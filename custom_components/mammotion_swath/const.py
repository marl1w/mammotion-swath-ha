"""Constants for Mammotion Swath."""

from __future__ import annotations

from typing import Final

DOMAIN: Final = "mammotion_swath"
UPSTREAM_DOMAIN: Final = "mammotion"

PANEL_URL_PATH: Final = "mammotion-swath"
PANEL_TITLE: Final = "Mower"
PANEL_ICON: Final = "mdi:robot-mower"
PANEL_ELEMENT: Final = "mammotion-swath-panel"
STATIC_URL: Final = "/mammotion_swath_static"

# Registry translation keys the upstream integration gives the entities Swath reads.
# Matching on these rather than on entity ids keeps renamed entities working.
ROLE_TRANSLATION_KEYS: Final[dict[str, str]] = {
    "tracker": "device_tracker",
    "battery": "battery_percent",
    "activity": "activity_mode",
    "progress": "progress",
    "area": "area",
    "time_left": "left_time",
    "total_time": "total_time",
    "error_code": "error_1_code",
    "error_message": "error_1_message",
    "error_time": "error_1_time",
    "self_check": "self_check",
    "connection": "connect_type",
}

# A route segment counts as covering the lawn within this distance, in metres. Half the
# Yuka mini's cut width plus a little, so neighbouring stripes merge into one surface.
COVERAGE_STRIPE_RADIUS_M: Final = 0.25
# Gaps smaller than this are rounding noise along the boundary, not lawn left out.
COVERAGE_MIN_GAP_M2: Final = 1.5
# The planner keeps this far off the boundary and covers the margin with edge laps.
COVERAGE_EDGE_INSET_M: Final = 0.25
