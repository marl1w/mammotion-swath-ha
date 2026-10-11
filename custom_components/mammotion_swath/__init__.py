"""Mammotion Swath — a live mowing panel for the Mammotion integration.

Adds a sidebar panel with the lawn map, the planned route and what it leaves out, the
mower's live position, its saved jobs and its camera. All mower access goes through the
Mammotion integration's own entities and services; Swath only adds a view and a few
websocket commands on top.
"""

from __future__ import annotations

import hashlib
import logging
from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .api import async_register as async_register_websocket_api
from .const import (
    DATA_TRAILS,
    DOMAIN,
    PANEL_ELEMENT,
    PANEL_ICON,
    PANEL_TITLE,
    PANEL_URL_PATH,
    STATIC_URL,
)
from .discovery import async_discover_mowers
from .trail import TrailRecorder

_LOGGER = logging.getLogger(__name__)

_FRONTEND_DIR = Path(__file__).parent / "frontend"
_DATA_STATIC_REGISTERED = f"{DOMAIN}_static_registered"
_DATA_WS_REGISTERED = f"{DOMAIN}_ws_registered"


def frontend_fingerprint(directory: Path = _FRONTEND_DIR) -> str:
    """Return a short hash of every frontend file's name and contents.

    The panel is a set of ES modules importing each other by relative path, so a query
    string on the entry module would leave the others cached. Serving the whole directory
    under a URL named after its contents invalidates every module whenever any changes.
    """
    digest = hashlib.sha256()
    for path in sorted(directory.rglob("*.js")):
        digest.update(path.relative_to(directory).as_posix().encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()[:12]


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Register the websocket API, the static frontend and the sidebar panel."""
    if not hass.data.get(_DATA_WS_REGISTERED):
        async_register_websocket_api(hass)
        hass.data[_DATA_WS_REGISTERED] = True

    # Record each mower's trail from now on; mowers set up later are picked up by the
    # panel's first snapshot request.
    recorder = TrailRecorder(hass)
    hass.data[DATA_TRAILS] = recorder
    for mower in async_discover_mowers(hass):
        recorder.async_watch(mower)

    fingerprint = await hass.async_add_executor_job(frontend_fingerprint)
    static_url = f"{STATIC_URL}/{fingerprint}"
    # Static paths cannot be unregistered, so a reload must not register the same one twice.
    if hass.data.get(_DATA_STATIC_REGISTERED) != static_url:
        await hass.http.async_register_static_paths(
            [StaticPathConfig(static_url, str(_FRONTEND_DIR), True)]
        )
        hass.data[_DATA_STATIC_REGISTERED] = static_url

    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL_PATH,
        webcomponent_name=PANEL_ELEMENT,
        module_url=f"{static_url}/{PANEL_ELEMENT}.js",
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        require_admin=False,
        embed_iframe=False,
        config={},
    )
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Remove the sidebar panel and stop recording; the websocket commands stay until restart."""
    frontend.async_remove_panel(hass, PANEL_URL_PATH)
    if (recorder := hass.data.pop(DATA_TRAILS, None)) is not None:
        recorder.async_stop()
    return True
