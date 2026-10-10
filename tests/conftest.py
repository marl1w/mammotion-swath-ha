"""Shared fixtures.

No test needs the real Mammotion integration. Its registry entries, runtime record and
response-returning services are stood up here in the shape Swath reads, which also makes
these fixtures the record of that shape: if upstream changes it, they are what to update.
"""

from __future__ import annotations

import math
from types import SimpleNamespace
from typing import Any

from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant, ServiceCall, SupportsResponse
from homeassistant.helpers import device_registry as dr, entity_registry as er
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

pytest_plugins = "pytest_homeassistant_custom_component"

UNIQUE_NAME = "Yuka-TEST123"
LAWN_MOWER = "lawn_mower.yuka"


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    """Make the custom integration loadable in every test."""
    return enable_custom_integrations


def lawn_square(size_m: float = 10.0) -> list[list[float]]:
    """A square lawn of *size_m* metres at an arbitrary spot, as a closed lon/lat ring."""
    lon0, lat0 = 11.0, 48.0
    dlat = size_m / 110540
    dlon = size_m / (111320 * math.cos(math.radians(lat0)))
    return [
        [lon0, lat0],
        [lon0 + dlon, lat0],
        [lon0 + dlon, lat0 + dlat],
        [lon0, lat0 + dlat],
        [lon0, lat0],
    ]


def stripes(
    ring: list[list[float]], fraction: float, spacing_m: float = 0.4
) -> list[list[list[float]]]:
    """East-west cover lines over the southern *fraction* of a square lawn."""
    (lon0, lat0), (lon1, _), _, (_, lat1), _ = ring
    lines = []
    lat = lat0
    step = spacing_m / 110540
    while lat <= lat0 + (lat1 - lat0) * fraction:
        lines.append([[lon0, lat], [lon1, lat]])
        lat += step
    return lines


def map_geojson(ring: list[list[float]]) -> dict[str, Any]:
    """The upstream map GeoJSON: one area and a dock."""
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"type_name": "area", "title": "area 1"},
                "geometry": {"type": "Polygon", "coordinates": [ring]},
            },
            {
                "type": "Feature",
                "properties": {"title": "Dock", "type_name": "station"},
                "geometry": {"type": "Point", "coordinates": ring[0]},
            },
        ],
    }


def route_geojson(lines: list[list[list[float]]]) -> dict[str, Any]:
    """The upstream route GeoJSON: one LineString per cover line."""
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"type_name": "mow_path"},
                "geometry": {"type": "LineString", "coordinates": line},
            }
            for line in lines
        ],
    }


def upstream_record(
    *, bp_info: int = 0, area: int = 98, path_hash: int = 7, real_toward: int = 25219
) -> SimpleNamespace:
    """The upstream per-mower runtime record, as far as Swath reads it.

    The pose defaults are the real Yuka's, read while docked facing its lawn.
    """
    work = SimpleNamespace(bp_info=bp_info, area=area, path_hash=path_hash)
    report = SimpleNamespace(
        work=work,
        dev=SimpleNamespace(sys_status=11),
        locations=[SimpleNamespace(real_toward=real_toward)],
    )
    location = SimpleNamespace(
        device=SimpleNamespace(latitude=48.0000890, longitude=11.0000310),
        RTK=SimpleNamespace(yaw=-3.04028986),
    )
    coordinator = SimpleNamespace(data=SimpleNamespace(report_data=report, location=location))
    return SimpleNamespace(unique_name=UNIQUE_NAME, reporting_coordinator=coordinator)


def add_upstream_mower(
    hass: HomeAssistant, record: SimpleNamespace | None = None
) -> MockConfigEntry:
    """Register a Mammotion mower: config entry, device, entities and states."""
    entry = MockConfigEntry(domain="mammotion", title="Yuka")
    entry.add_to_hass(hass)
    entry.runtime_data = SimpleNamespace(mowers=[record or upstream_record()])
    entry.mock_state(hass, ConfigEntryState.LOADED)

    device = dr.async_get(hass).async_get_or_create(
        config_entry_id=entry.entry_id,
        identifiers={("mammotion", UNIQUE_NAME)},
        name=UNIQUE_NAME,
        model="YUKA mini Vision 500",
    )
    ent_reg = er.async_get(hass)

    def add(
        domain: str,
        object_id: str,
        translation_key: str | None,
        state: str = "on",
        attributes: dict[str, Any] | None = None,
        disabled: bool = False,
    ) -> str:
        entity = ent_reg.async_get_or_create(
            domain,
            "mammotion",
            f"{UNIQUE_NAME}_{object_id}",
            suggested_object_id=object_id,
            device_id=device.id,
            config_entry=entry,
            translation_key=translation_key,
            disabled_by=er.RegistryEntryDisabler.USER if disabled else None,
        )
        if not disabled:
            hass.states.async_set(entity.entity_id, state, attributes or {})
        return entity.entity_id

    add("lawn_mower", "yuka", None, "docked")
    add(
        "device_tracker",
        "yuka_tracker",
        "device_tracker",
        "home",
        {"latitude": 48.0000100, "longitude": 11.0000200},
    )
    add("sensor", "yuka_battery", "battery_percent", "86")
    add("sensor", "yuka_error_code", "error_1_code", "1000019")
    add("sensor", "yuka_error", "error_1_message", "navigation: Positioning failed, 1.Please move")
    add("binary_sensor", "yuka_charging", None, "on")
    add("camera", "yuka_left", "webrtc_camera", "streaming")
    add("camera", "yuka_right", "webrtc_camera_right", disabled=True)
    add("button", "yuka_task_1", "123", "unknown", {"task_id": "123"})
    add("switch", "yuka_area_1", "area_plain", "off", {"hash": 326506498609757686})
    add("switch", "yuka_voice", "voice_on_off", "on")
    return entry


def register_upstream_services(
    hass: HomeAssistant, responses: dict[str, Any], calls: list[ServiceCall]
) -> None:
    """Stand up the upstream services Swath calls, recording every call."""

    async def handler(call: ServiceCall) -> Any:
        calls.append(call)
        return responses.get(call.service)

    for service in ("get_geojson", "get_mow_path_geojson", "get_mow_progress_geojson", "get_tasks"):
        hass.services.async_register(
            "mammotion", service, handler, supports_response=SupportsResponse.ONLY
        )
    for service in ("cancel_job", "start_task"):
        hass.services.async_register("mammotion", service, handler)
