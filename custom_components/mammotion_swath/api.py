"""Websocket commands the panel uses.

Reads go through the upstream integration's public services (map, route, progress,
tasks) plus the defensive runtime read in `upstream.py`. Writes are upstream services
too, so Swath never talks to the mower itself.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from homeassistant.components import websocket_api
from homeassistant.core import Event, EventStateChangedData, HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError, ServiceNotFound
from homeassistant.helpers.event import async_track_state_change_event
import voluptuous as vol

from .const import DOMAIN, UPSTREAM_DOMAIN
from .coverage import compute_coverage
from .discovery import async_discover_mowers, async_find_mower
from .upstream import async_job_facts, async_pose

_LOGGER = logging.getLogger(__name__)

# How long a fresh-route start waits for the mower to drop its breakpoint.
_BREAKPOINT_CLEAR_TIMEOUT_S = 60


@callback
def async_register(hass: HomeAssistant) -> None:
    """Register every websocket command."""
    websocket_api.async_register_command(hass, ws_mowers)
    websocket_api.async_register_command(hass, ws_snapshot)
    websocket_api.async_register_command(hass, ws_plan_fresh)
    websocket_api.async_register_command(hass, ws_start_task)
    websocket_api.async_register_command(hass, ws_subscribe_pose)


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/subscribe_pose", vol.Required("lawn_mower"): str}
)
@callback
def ws_subscribe_pose(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Push the mower's position and true heading whenever its tracker reports.

    The tracker entity's `direction` attribute cannot be used for the heading (see
    `heading_from_toward`), so the pose is read from upstream on every tracker update.
    Without that read, the tracker's position is sent with no heading.
    """
    mower = async_find_mower(hass, msg["lawn_mower"])
    tracker = mower.roles.get("tracker") if mower else None
    if mower is None or tracker is None:
        connection.send_error(msg["id"], "not_found", "No tracked Mammotion mower")
        return

    @callback
    def send(_event: Event[EventStateChangedData] | None = None) -> None:
        pose = async_pose(hass, mower.unique_name)
        if pose is not None:
            payload = pose.as_dict()
        else:
            state = hass.states.get(tracker)
            attrs = state.attributes if state else {}
            payload = {
                "latitude": attrs.get("latitude"),
                "longitude": attrs.get("longitude"),
                "heading": None,
            }
        connection.send_message(websocket_api.event_message(msg["id"], payload))

    connection.subscriptions[msg["id"]] = async_track_state_change_event(hass, [tracker], send)
    connection.send_result(msg["id"])
    send()


async def _upstream_response(hass: HomeAssistant, service: str, entity_id: str) -> Any:
    """Call an upstream service that returns data; None when it is missing or fails."""
    try:
        return await hass.services.async_call(
            UPSTREAM_DOMAIN,
            service,
            {"entity_id": entity_id},
            blocking=True,
            return_response=True,
        )
    except (HomeAssistantError, ServiceNotFound, vol.Invalid):
        _LOGGER.debug("Upstream %s.%s failed", UPSTREAM_DOMAIN, service, exc_info=True)
        return None


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/mowers"})
@callback
def ws_mowers(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """List every Mammotion mower and the entities Swath uses for it."""
    connection.send_result(
        msg["id"], {"mowers": [m.as_dict() for m in async_discover_mowers(hass)]}
    )


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/snapshot", vol.Required("lawn_mower"): str}
)
@websocket_api.async_response
async def ws_snapshot(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Return the map, route, progress, tasks, job facts and the coverage comparison."""
    mower = async_find_mower(hass, msg["lawn_mower"])
    if mower is None:
        connection.send_error(msg["id"], "not_found", "No Mammotion mower with that entity")
        return

    entity_id = mower.lawn_mower
    map_geojson, route_geojson, progress_geojson, tasks = await asyncio.gather(
        _upstream_response(hass, "get_geojson", entity_id),
        _upstream_response(hass, "get_mow_path_geojson", entity_id),
        _upstream_response(hass, "get_mow_progress_geojson", entity_id),
        _upstream_response(hass, "get_tasks", entity_id),
    )
    coverage = await hass.async_add_executor_job(compute_coverage, map_geojson, route_geojson)
    facts = async_job_facts(hass, mower.unique_name)

    connection.send_result(
        msg["id"],
        {
            "mower": mower.as_dict(),
            "map": map_geojson,
            "route": route_geojson,
            "progress": progress_geojson,
            "tasks": (tasks or {}).get("tasks", []),
            "job": facts.as_dict() if facts else None,
            "coverage": coverage.as_dict() if coverage else None,
        },
    )


async def _async_clear_breakpoint(
    hass: HomeAssistant, lawn_mower: str, unique_name: str | None
) -> bool:
    """End the stored job so the next start plans a fresh route; True once it is gone."""
    facts = async_job_facts(hass, unique_name)
    if facts is not None and not facts.has_breakpoint:
        return True
    await hass.services.async_call(
        UPSTREAM_DOMAIN, "cancel_job", {"entity_id": lawn_mower}, blocking=True
    )
    if facts is None:
        # Without the runtime read there is nothing to wait on; the cancel is the best
        # available signal that the old route is gone.
        return True
    deadline = asyncio.get_running_loop().time() + _BREAKPOINT_CLEAR_TIMEOUT_S
    while asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(2)
        current = async_job_facts(hass, unique_name)
        if current is None or not current.has_breakpoint:
            return True
    return False


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/plan_fresh", vol.Required("lawn_mower"): str}
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_plan_fresh(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Drop the stored job, so the next start plans against the current map."""
    mower = async_find_mower(hass, msg["lawn_mower"])
    if mower is None:
        connection.send_error(msg["id"], "not_found", "No Mammotion mower with that entity")
        return
    state = hass.states.get(mower.lawn_mower)
    if state is not None and state.state == "mowing":
        connection.send_error(
            msg["id"], "busy", "Pause or dock the mower before planning a fresh route"
        )
        return
    try:
        cleared = await _async_clear_breakpoint(hass, mower.lawn_mower, mower.unique_name)
    except HomeAssistantError as err:
        connection.send_error(msg["id"], "upstream_error", str(err))
        return
    connection.send_result(msg["id"], {"cleared": cleared})


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/start_task",
        vol.Required("lawn_mower"): str,
        vol.Required("task"): str,
        vol.Optional("fresh", default=True): bool,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_start_task(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Start a saved job, first dropping any stored route when *fresh* is set."""
    mower = async_find_mower(hass, msg["lawn_mower"])
    if mower is None or msg["task"] not in mower.tasks:
        connection.send_error(msg["id"], "not_found", "Unknown mower or task")
        return
    try:
        if msg["fresh"]:
            state = hass.states.get(mower.lawn_mower)
            if state is None or state.state != "mowing":
                await _async_clear_breakpoint(hass, mower.lawn_mower, mower.unique_name)
        await hass.services.async_call(
            UPSTREAM_DOMAIN, "start_task", {"entity_id": msg["task"]}, blocking=True
        )
    except HomeAssistantError as err:
        connection.send_error(msg["id"], "upstream_error", str(err))
        return
    connection.send_result(msg["id"], {"started": True})
