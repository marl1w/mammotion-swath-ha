"""The trail Swath records of where the mower really drives."""

from __future__ import annotations

from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.mammotion_swath.const import DOMAIN, PANEL_TITLE
from custom_components.mammotion_swath.discovery import async_discover_mowers
from custom_components.mammotion_swath.trail import MIN_STEP_M, Trail, TrailRecorder, step_m

from .conftest import LAWN_MOWER, add_upstream_mower, register_upstream_services

LAT, LON = 48.0, 11.0
ONE_METRE_LAT = 1 / 110_540


def test_trail_skips_jitter_and_needs_two_points() -> None:
    trail = Trail()
    assert trail.add(LON, LAT)
    assert trail.as_geojson()["features"] == []  # one point is not a line yet
    assert not trail.add(LON, LAT + ONE_METRE_LAT * MIN_STEP_M / 2)
    assert trail.add(LON, LAT + ONE_METRE_LAT)
    [feature] = trail.as_geojson()["features"]
    assert len(feature["geometry"]["coordinates"]) == 2
    assert step_m((LON, LAT), (LON, LAT + ONE_METRE_LAT)) == pytest.approx(1.0, rel=0.01)


async def _drive(hass: HomeAssistant, tracker: str, metres: list[float]) -> None:
    for m in metres:
        hass.states.async_set(
            tracker, "home", {"latitude": LAT + m * ONE_METRE_LAT, "longitude": LON}
        )
    await hass.async_block_till_done()


async def test_recorder_follows_the_job(hass: HomeAssistant) -> None:
    add_upstream_mower(hass)
    [mower] = async_discover_mowers(hass)
    tracker = mower.roles["tracker"]
    recorder = TrailRecorder(hass)
    recorder.async_watch(mower)
    trail = recorder.trail(LAWN_MOWER)

    # Docked: positions are not mowing.
    await _drive(hass, tracker, [0, 1])
    assert trail.points == []

    # A job starts from the dock: the trail records it.
    hass.states.async_set(LAWN_MOWER, "mowing")
    await _drive(hass, tracker, [2, 3, 4])
    assert len(trail.points) == 3

    # Paused and resumed: the same job, so the trail is kept.
    hass.states.async_set(LAWN_MOWER, "paused")
    await _drive(hass, tracker, [9])
    hass.states.async_set(LAWN_MOWER, "mowing")
    await _drive(hass, tracker, [5])
    assert len(trail.points) == 4

    # Back to the dock, then a new job: the trail starts over.
    hass.states.async_set(LAWN_MOWER, "docked")
    await hass.async_block_till_done()
    hass.states.async_set(LAWN_MOWER, "mowing")
    await _drive(hass, tracker, [6])
    assert len(trail.points) == 1

    recorder.async_stop()
    await _drive(hass, tracker, [8])
    assert len(trail.points) == 1


async def test_snapshot_carries_the_trail(hass, hass_ws_client) -> None:
    add_upstream_mower(hass)
    register_upstream_services(hass, {}, [])
    assert await async_setup_component(hass, "http", {})
    entry = MockConfigEntry(domain=DOMAIN, title=PANEL_TITLE)
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    tracker = async_discover_mowers(hass)[0].roles["tracker"]

    hass.states.async_set(LAWN_MOWER, "mowing")
    await _drive(hass, tracker, [0, 1, 2])

    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": f"{DOMAIN}/snapshot", "lawn_mower": LAWN_MOWER})
    msg = await client.receive_json()
    assert msg["success"], msg
    [feature] = msg["result"]["trail"]["features"]
    assert len(feature["geometry"]["coordinates"]) == 3
