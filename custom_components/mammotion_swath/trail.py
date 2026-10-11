"""Record where each mower actually drives during the current job.

The upstream integration offers only a few points of live track, and many installs keep
the tracker out of the recorder because it writes once a second. So Swath keeps the
job's trail itself, in memory: positions are appended while the mower mows or returns,
and the trail starts over when a new job begins (the mower leaves the dock to mow).
An HA restart loses it.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
import math

from homeassistant.core import Event, EventStateChangedData, HomeAssistant, callback
from homeassistant.helpers.event import async_track_state_change_event

from .discovery import MowerEntities

# Positions closer together than this are jitter, not travel.
MIN_STEP_M = 0.15
# Enough for a long job at one point per 15 cm; beyond it the oldest points go.
MAX_POINTS = 20_000
_MOVING = {"mowing", "returning"}
# A job that starts from one of these is a new job; from "paused" it is the same one.
_NEW_JOB_FROM = {"docked", "idle", "error", "unavailable", "unknown"}

_M_PER_DEG_LAT = 110_540.0


def step_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Distance in metres between two (lon, lat) points; fine at garden scale."""
    kx = 111_320.0 * math.cos(math.radians(a[1]))
    return math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * _M_PER_DEG_LAT)


@dataclass
class Trail:
    """One mower's track for the current job, as (lon, lat) points."""

    points: list[tuple[float, float]] = field(default_factory=list)

    def add(self, lon: float, lat: float) -> bool:
        """Append a position if it moved far enough; True when it was added."""
        point = (lon, lat)
        if self.points and step_m(self.points[-1], point) < MIN_STEP_M:
            return False
        self.points.append(point)
        if len(self.points) > MAX_POINTS:
            del self.points[: len(self.points) - MAX_POINTS]
        return True

    def clear(self) -> None:
        """Start over, for a new job."""
        self.points.clear()

    def as_geojson(self) -> dict:
        """Return the trail as a GeoJSON LineString collection (empty when too short)."""
        features = []
        if len(self.points) >= 2:
            features.append(
                {
                    "type": "Feature",
                    "properties": {"type_name": "trail"},
                    "geometry": {
                        "type": "LineString",
                        "coordinates": [list(p) for p in self.points],
                    },
                }
            )
        return {"type": "FeatureCollection", "features": features}


class TrailRecorder:
    """Keeps a trail per mower, fed by its tracker and lawn_mower state changes."""

    def __init__(self, hass: HomeAssistant) -> None:
        """Initialise with no mowers watched yet."""
        self.hass = hass
        self._trails: dict[str, Trail] = {}
        self._unsubs: dict[str, Callable[[], None]] = {}

    def trail(self, lawn_mower: str) -> Trail:
        """Return the trail for *lawn_mower*, empty if it is not watched."""
        return self._trails.setdefault(lawn_mower, Trail())

    @callback
    def async_watch(self, mower: MowerEntities) -> None:
        """Start recording *mower*, once; safe to call on every request."""
        tracker = mower.roles.get("tracker")
        if mower.lawn_mower in self._unsubs or tracker is None:
            return
        trail = self.trail(mower.lawn_mower)

        @callback
        def on_mower(event: Event[EventStateChangedData]) -> None:
            old = event.data["old_state"]
            new = event.data["new_state"]
            if new is None or new.state not in _MOVING:
                return
            if old is None or old.state in _NEW_JOB_FROM:
                trail.clear()

        @callback
        def on_tracker(event: Event[EventStateChangedData]) -> None:
            state = self.hass.states.get(mower.lawn_mower)
            new = event.data["new_state"]
            if state is None or state.state not in _MOVING or new is None:
                return
            lat = new.attributes.get("latitude")
            lon = new.attributes.get("longitude")
            if isinstance(lat, (int, float)) and isinstance(lon, (int, float)):
                trail.add(float(lon), float(lat))

        unsub_mower = async_track_state_change_event(self.hass, [mower.lawn_mower], on_mower)
        unsub_tracker = async_track_state_change_event(self.hass, [tracker], on_tracker)

        def unsub() -> None:
            unsub_mower()
            unsub_tracker()

        self._unsubs[mower.lawn_mower] = unsub

    @callback
    def async_stop(self) -> None:
        """Stop recording every mower."""
        for unsub in self._unsubs.values():
            unsub()
        self._unsubs.clear()
