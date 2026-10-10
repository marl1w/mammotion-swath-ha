"""Compare the lawn on the map with the lawn the planned route actually cuts.

The upstream integration hands both over as GeoJSON in lon/lat: the mowing areas and the
route's cover lines. Both are projected into a local metric frame, the route lines are
widened into stripes, and whatever lawn is left uncovered — beyond a margin along the
boundary, which edge laps cover — is reported as a gap.

The route reaches Home Assistant only while a job runs, and may arrive in parts, so a
result is a reading of what was received, not a certainty about the mower's planner.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Any

from .const import COVERAGE_EDGE_INSET_M, COVERAGE_MIN_GAP_M2, COVERAGE_STRIPE_RADIUS_M

_M_PER_DEG_LAT = 110_540.0
_M_PER_DEG_LON_EQUATOR = 111_320.0


@dataclass(frozen=True)
class Coverage:
    """The comparison, with gaps as GeoJSON polygons in lon/lat."""

    lawn_area_m2: float
    route_segments: int
    gap_area_m2: float
    gaps: list[dict[str, Any]]

    def as_dict(self) -> dict[str, Any]:
        """Serialise for the websocket API."""
        return {
            "lawn_area_m2": round(self.lawn_area_m2, 1),
            "route_segments": self.route_segments,
            "gap_area_m2": round(self.gap_area_m2, 1),
            "gaps": {"type": "FeatureCollection", "features": self.gaps},
        }


class _Frame:
    """An equirectangular projection around a reference point — exact enough for a garden."""

    def __init__(self, lon0: float, lat0: float) -> None:
        self.lon0, self.lat0 = lon0, lat0
        self.kx = _M_PER_DEG_LON_EQUATOR * math.cos(math.radians(lat0))

    def to_m(self, lon: float, lat: float) -> tuple[float, float]:
        return ((lon - self.lon0) * self.kx, (lat - self.lat0) * _M_PER_DEG_LAT)

    def to_lonlat(self, x: float, y: float) -> list[float]:
        return [self.lon0 + x / self.kx, self.lat0 + y / _M_PER_DEG_LAT]


def _features(collection: dict[str, Any] | None) -> list[dict[str, Any]]:
    return list((collection or {}).get("features") or [])


def lawn_polygons(map_geojson: dict[str, Any] | None) -> list[list[list[float]]]:
    """Return the exterior rings of every mowing area in the map GeoJSON."""
    rings = []
    for feature in _features(map_geojson):
        props = feature.get("properties") or {}
        geometry = feature.get("geometry") or {}
        if props.get("type_name") == "area" and geometry.get("type") == "Polygon":
            ring = (geometry.get("coordinates") or [[]])[0]
            if len(ring) >= 3:
                rings.append(ring)
    return rings


def route_lines(route_geojson: dict[str, Any] | None) -> list[list[list[float]]]:
    """Return every cover line with at least two points."""
    lines = []
    for feature in _features(route_geojson):
        geometry = feature.get("geometry") or {}
        if geometry.get("type") == "LineString":
            coords = geometry.get("coordinates") or []
            if len(coords) >= 2:
                lines.append(coords)
    return lines


def compute_coverage(
    map_geojson: dict[str, Any] | None, route_geojson: dict[str, Any] | None
) -> Coverage | None:
    """Return the comparison, or None when there is no lawn, no route or no shapely."""
    try:
        from shapely.geometry import LineString, Polygon
        from shapely.ops import unary_union
    except ImportError:
        return None

    rings = lawn_polygons(map_geojson)
    lines = route_lines(route_geojson)
    if not rings or not lines:
        return None

    frame = _Frame(*rings[0][0][:2])
    lawn = unary_union([Polygon([frame.to_m(*p[:2]) for p in ring]).buffer(0) for ring in rings])
    covered = unary_union(
        [
            LineString([frame.to_m(*p[:2]) for p in line]).buffer(COVERAGE_STRIPE_RADIUS_M)
            for line in lines
        ]
    )
    uncovered = lawn.buffer(-COVERAGE_EDGE_INSET_M).difference(
        covered.buffer(COVERAGE_STRIPE_RADIUS_M / 2)
    )
    pieces = [g for g in getattr(uncovered, "geoms", [uncovered]) if not g.is_empty]
    gaps = [g for g in pieces if g.geom_type == "Polygon" and g.area >= COVERAGE_MIN_GAP_M2]

    features = [
        {
            "type": "Feature",
            "properties": {"type_name": "coverage_gap", "area_m2": round(g.area, 1)},
            "geometry": {
                "type": "Polygon",
                "coordinates": [
                    [frame.to_lonlat(x, y) for x, y in g.simplify(0.05).exterior.coords]
                ],
            },
        }
        for g in sorted(gaps, key=lambda g: -g.area)
    ]
    return Coverage(
        lawn_area_m2=lawn.area,
        route_segments=len(lines),
        gap_area_m2=sum(g.area for g in gaps),
        gaps=features,
    )
