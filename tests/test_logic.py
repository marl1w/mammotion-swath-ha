"""Pure logic: the packed area field and the coverage comparison."""

from __future__ import annotations

import pytest

from custom_components.mammotion_swath.coverage import compute_coverage
from custom_components.mammotion_swath.upstream import decode_packed_area

from .conftest import lawn_square, map_geojson, route_geojson, stripes


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (0x00630062, (98, 99)),  # 99 % of a 98 m² route, as reported mid-job
        (0x00040062, (98, 4)),
        (98, (98, None)),  # only the area, before a job starts
        (0, (None, None)),
        (None, (None, None)),
    ],
)
def test_decode_packed_area(value, expected) -> None:
    assert decode_packed_area(value) == expected


def test_full_route_leaves_no_gap() -> None:
    ring = lawn_square()
    coverage = compute_coverage(map_geojson(ring), route_geojson(stripes(ring, 1.0)))

    assert coverage is not None
    assert coverage.lawn_area_m2 == pytest.approx(100, rel=0.02)
    assert coverage.gaps == []
    assert coverage.gap_area_m2 == 0


def test_half_route_reports_the_other_half() -> None:
    ring = lawn_square()
    coverage = compute_coverage(map_geojson(ring), route_geojson(stripes(ring, 0.5)))

    assert coverage is not None
    # The northern half, minus the edge margin all round and the stripe overlap.
    assert 35 < coverage.gap_area_m2 < 50
    assert len(coverage.gaps) == 1
    gap = coverage.gaps[0]
    assert gap["geometry"]["type"] == "Polygon"
    # The gap sits north of the covered half.
    lats = [lat for _lon, lat in gap["geometry"]["coordinates"][0]]
    assert min(lats) > ring[0][1]


def test_no_route_means_no_comparison() -> None:
    ring = lawn_square()
    assert compute_coverage(map_geojson(ring), {"features": []}) is None
    assert compute_coverage(map_geojson(ring), None) is None


def test_no_lawn_means_no_comparison() -> None:
    ring = lawn_square()
    assert compute_coverage({"features": []}, route_geojson(stripes(ring, 1.0))) is None
