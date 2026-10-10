"""Read job facts the upstream integration keeps but does not expose as entities.

The breakpoint (`bp_info`) decides whether the next start resumes an old route or plans a
new one, and the packed `area` field says how much lawn the current route covers. Neither
has an entity, so they are read from the upstream config entry's runtime data.

That is another integration's internals, so every access here is defensive: if the shape
changes, `async_job_facts` returns `None` and the panel simply leaves those facts out.
"""

from __future__ import annotations

from dataclasses import dataclass
import logging
import math
from typing import Any

from homeassistant.core import HomeAssistant

from .const import UPSTREAM_DOMAIN

_LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class JobFacts:
    """What the mower reports about its current or last job."""

    breakpoint: int
    route_area_m2: int | None
    route_progress_pct: int | None
    path_hash: int | None
    sys_status: int | None

    @property
    def has_breakpoint(self) -> bool:
        """Whether the next start will resume the stored route instead of planning anew."""
        return self.breakpoint != 0

    def as_dict(self) -> dict[str, Any]:
        """Serialise for the websocket API (hashes as strings: JS loses 64-bit ints)."""
        return {
            "has_breakpoint": self.has_breakpoint,
            "route_area_m2": self.route_area_m2,
            "route_progress_pct": self.route_progress_pct,
            "path_hash": str(self.path_hash) if self.path_hash else None,
            "sys_status": self.sys_status,
        }


def decode_packed_area(value: int | None) -> tuple[int | None, int | None]:
    """Split the report's packed area into (route area in m², progress in %).

    The mower packs two 16-bit numbers: the low half is the route's total area, the high
    half the job's progress — 0x00630062 is 99 % of a 98 m² route, matching the progress
    sensor at the same moment. A value below 0x10000 carries only the area.
    """
    if not value or value < 0:
        return None, None
    area = value & 0xFFFF
    progress = value >> 16
    return (area or None), (progress if value > 0xFFFF else None)


def _mower_record(hass: HomeAssistant, unique_name: str) -> Any | None:
    """Return the upstream per-mower runtime record for *unique_name*."""
    for entry in hass.config_entries.async_entries(UPSTREAM_DOMAIN):
        runtime = getattr(entry, "runtime_data", None)
        for mower in getattr(runtime, "mowers", None) or ():
            if getattr(mower, "unique_name", None) == unique_name:
                return mower
    return None


def heading_from_toward(real_toward: float, map_yaw: float) -> float:
    """Return a compass bearing in degrees (0 = north, clockwise) for the mower's heading.

    `real_toward` is the heading in 1/10000 rad, counter-clockwise from the map frame's x
    axis. The map frame is rotated by `map_yaw` against east/north — the same rotation
    upstream applies to the position — so the angle from east is `toward + yaw`, and a
    compass bearing is 90° minus that. (Upstream's own `direction` attribute is
    `int(real_toward / 10000)`: radians truncated to a whole number, not a bearing.)
    """
    from_east = real_toward / 10000 + map_yaw
    return (90 - math.degrees(from_east)) % 360


@dataclass(frozen=True)
class Pose:
    """Where the mower is and which way it faces."""

    latitude: float
    longitude: float
    heading: float | None

    def as_dict(self) -> dict[str, Any]:
        """Serialise for the websocket API."""
        return {
            "latitude": self.latitude,
            "longitude": self.longitude,
            "heading": round(self.heading, 1) if self.heading is not None else None,
        }


def async_pose(hass: HomeAssistant, unique_name: str | None) -> Pose | None:
    """Return the mower's position and true heading, or None when not readable."""
    if not unique_name:
        return None
    try:
        mower = _mower_record(hass, unique_name)
        if mower is None:
            return None
        data = mower.reporting_coordinator.data
        device = data.location.device
        locations = data.report_data.locations or []
        heading = (
            heading_from_toward(locations[0].real_toward, data.location.RTK.yaw)
            if locations
            else None
        )
        return Pose(latitude=device.latitude, longitude=device.longitude, heading=heading)
    except (AttributeError, TypeError, ValueError, IndexError):
        _LOGGER.debug("Upstream pose unavailable for %s", unique_name, exc_info=True)
        return None


def async_job_facts(hass: HomeAssistant, unique_name: str | None) -> JobFacts | None:
    """Return the mower's job facts, or None when the upstream shape is not as expected."""
    if not unique_name:
        return None
    try:
        mower = _mower_record(hass, unique_name)
        if mower is None:
            return None
        report = mower.reporting_coordinator.data.report_data
        work = report.work
        area, progress = decode_packed_area(getattr(work, "area", None))
        return JobFacts(
            breakpoint=int(work.bp_info or 0),
            route_area_m2=area,
            route_progress_pct=progress,
            path_hash=int(work.path_hash) if getattr(work, "path_hash", None) else None,
            sys_status=getattr(report.dev, "sys_status", None),
        )
    except (AttributeError, TypeError, ValueError):
        _LOGGER.debug("Upstream job facts unavailable for %s", unique_name, exc_info=True)
        return None
