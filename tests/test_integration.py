"""Discovery, setup and the websocket commands, against a stand-in Mammotion integration."""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.mammotion_swath.const import DOMAIN, PANEL_TITLE, PANEL_URL_PATH
from custom_components.mammotion_swath.discovery import async_discover_mowers
from custom_components.mammotion_swath.upstream import async_job_facts

from .conftest import (
    LAWN_MOWER,
    UNIQUE_NAME,
    add_upstream_mower,
    lawn_square,
    map_geojson,
    register_upstream_services,
    route_geojson,
    stripes,
    upstream_record,
)


async def _setup(hass: HomeAssistant) -> MockConfigEntry:
    assert await async_setup_component(hass, "http", {})
    entry = MockConfigEntry(domain=DOMAIN, title=PANEL_TITLE)
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


async def test_discovery_groups_the_mower_entities(hass: HomeAssistant) -> None:
    add_upstream_mower(hass)

    [mower] = async_discover_mowers(hass)

    assert mower.lawn_mower == LAWN_MOWER
    assert mower.unique_name == UNIQUE_NAME
    assert mower.model == "YUKA mini Vision 500"
    assert mower.roles["tracker"].startswith("device_tracker.")
    assert mower.roles["battery"] == "sensor.yuka_battery"
    assert mower.roles["error_code"] == "sensor.yuka_error_code"
    assert mower.charging == "binary_sensor.yuka_charging"
    # A camera the user disabled is left out, so the panel shows only working feeds.
    assert mower.cameras == ["camera.yuka_left"]
    assert mower.tasks == ["button.yuka_task_1"]
    assert mower.areas == ["switch.yuka_area_1"]


async def test_job_facts_read_the_breakpoint(hass: HomeAssistant) -> None:
    add_upstream_mower(hass, upstream_record(bp_info=7, area=0x00630062))

    facts = async_job_facts(hass, UNIQUE_NAME)

    assert facts is not None
    assert facts.has_breakpoint
    assert facts.route_area_m2 == 98
    assert facts.route_progress_pct == 99


async def test_job_facts_degrade_when_upstream_changes_shape(hass: HomeAssistant) -> None:
    record = upstream_record()
    record.reporting_coordinator.data = object()  # no report_data any more
    add_upstream_mower(hass, record)

    assert async_job_facts(hass, UNIQUE_NAME) is None


async def test_setup_registers_the_panel_and_unload_removes_it(hass: HomeAssistant) -> None:
    entry = await _setup(hass)

    panel = hass.data["frontend_panels"][PANEL_URL_PATH]
    assert panel.sidebar_title == PANEL_TITLE
    module_url = panel.config["_panel_custom"]["module_url"]
    # The fingerprint is in the path, so every module of the panel is re-fetched on change.
    assert "?" not in module_url and module_url.endswith("/mammotion-swath-panel.js")

    await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.LOADED

    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert PANEL_URL_PATH not in hass.data["frontend_panels"]


async def test_config_flow_needs_a_mower(hass: HomeAssistant) -> None:
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": "user"})
    assert result["type"] == "abort"
    assert result["reason"] == "no_mowers"

    add_upstream_mower(hass)
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": "user"})
    assert result["type"] == "form"
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {})
    assert result["type"] == "create_entry"


async def test_snapshot_combines_upstream_data(hass, hass_ws_client) -> None:
    add_upstream_mower(hass, upstream_record(bp_info=7))
    ring = lawn_square()
    calls = []
    register_upstream_services(
        hass,
        {
            "get_geojson": map_geojson(ring),
            "get_mow_path_geojson": route_geojson(stripes(ring, 0.5)),
            "get_mow_progress_geojson": {"type": "FeatureCollection", "features": []},
            "get_tasks": {"tasks": [{"name": "Task-1", "entity_id": "button.yuka_task_1"}]},
        },
        calls,
    )
    await _setup(hass)
    client = await hass_ws_client(hass)

    await client.send_json_auto_id({"type": f"{DOMAIN}/snapshot", "lawn_mower": LAWN_MOWER})
    msg = await client.receive_json()

    assert msg["success"], msg
    result = msg["result"]
    assert result["job"]["has_breakpoint"] is True
    assert result["tasks"][0]["name"] == "Task-1"
    assert result["coverage"]["gap_area_m2"] > 30
    assert {c.service for c in calls} == {
        "get_geojson",
        "get_mow_path_geojson",
        "get_mow_progress_geojson",
        "get_tasks",
    }


async def test_plan_fresh_cancels_the_stored_job(hass, hass_ws_client) -> None:
    record = upstream_record(bp_info=7)
    add_upstream_mower(hass, record)
    calls = []
    register_upstream_services(hass, {}, calls)

    async def clear_breakpoint(call):
        calls.append(call)
        record.reporting_coordinator.data.report_data.work.bp_info = 0

    hass.services.async_register("mammotion", "cancel_job", clear_breakpoint)
    await _setup(hass)
    client = await hass_ws_client(hass)

    await client.send_json_auto_id({"type": f"{DOMAIN}/plan_fresh", "lawn_mower": LAWN_MOWER})
    msg = await client.receive_json()

    assert msg["success"], msg
    assert msg["result"] == {"cleared": True}
    assert [c.service for c in calls] == ["cancel_job"]


async def test_plan_fresh_refuses_while_mowing(hass, hass_ws_client) -> None:
    add_upstream_mower(hass, upstream_record(bp_info=7))
    hass.states.async_set(LAWN_MOWER, "mowing")
    calls = []
    register_upstream_services(hass, {}, calls)
    await _setup(hass)
    client = await hass_ws_client(hass)

    await client.send_json_auto_id({"type": f"{DOMAIN}/plan_fresh", "lawn_mower": LAWN_MOWER})
    msg = await client.receive_json()

    assert not msg["success"]
    assert msg["error"]["code"] == "busy"
    assert calls == []


async def test_start_task_without_breakpoint_just_starts(hass, hass_ws_client) -> None:
    add_upstream_mower(hass, upstream_record(bp_info=0))
    calls = []
    register_upstream_services(hass, {}, calls)
    await _setup(hass)
    client = await hass_ws_client(hass)

    await client.send_json_auto_id(
        {"type": f"{DOMAIN}/start_task", "lawn_mower": LAWN_MOWER, "task": "button.yuka_task_1"}
    )
    msg = await client.receive_json()

    assert msg["success"], msg
    assert [(c.service, c.data["entity_id"]) for c in calls] == [
        ("start_task", "button.yuka_task_1")
    ]


async def test_pose_subscription_sends_true_heading(hass, hass_ws_client) -> None:
    add_upstream_mower(hass)
    await _setup(hass)
    client = await hass_ws_client(hass)

    await client.send_json_auto_id({"type": f"{DOMAIN}/subscribe_pose", "lawn_mower": LAWN_MOWER})
    assert (await client.receive_json())["success"]
    first = (await client.receive_json())["event"]
    assert first["heading"] == pytest.approx(119.7, abs=0.5)
    assert first["latitude"] == pytest.approx(48.000089)

    # Every tracker report pushes a fresh pose.
    tracker = async_discover_mowers(hass)[0].roles["tracker"]
    hass.states.async_set(tracker, "home", {"latitude": 48.0001, "longitude": 11.0001})
    second = (await client.receive_json())["event"]
    assert second["heading"] == pytest.approx(119.7, abs=0.5)


async def test_pose_without_upstream_record_has_no_heading(hass, hass_ws_client) -> None:
    record = upstream_record()
    record.reporting_coordinator.data = object()
    add_upstream_mower(hass, record)
    await _setup(hass)
    client = await hass_ws_client(hass)

    await client.send_json_auto_id({"type": f"{DOMAIN}/subscribe_pose", "lawn_mower": LAWN_MOWER})
    assert (await client.receive_json())["success"]
    event = (await client.receive_json())["event"]
    # The tracker's position, and no arrow rather than a wrong one.
    assert event["heading"] is None
    assert event["latitude"] == pytest.approx(48.00001)


async def test_start_task_rejects_a_foreign_entity(hass, hass_ws_client) -> None:
    add_upstream_mower(hass)
    calls = []
    register_upstream_services(hass, {}, calls)
    await _setup(hass)
    client = await hass_ws_client(hass)

    await client.send_json_auto_id(
        {"type": f"{DOMAIN}/start_task", "lawn_mower": LAWN_MOWER, "task": "button.something_else"}
    )
    msg = await client.receive_json()

    assert not msg["success"]
    assert calls == []
