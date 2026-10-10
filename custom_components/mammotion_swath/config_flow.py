"""Config flow: one entry, offered only when the Mammotion integration has a mower."""

from __future__ import annotations

from typing import Any

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult

from .const import DOMAIN, PANEL_TITLE
from .discovery import async_discover_mowers


class SwathConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Mammotion Swath."""

    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Confirm setup, once there is a Mammotion mower to show."""
        if not async_discover_mowers(self.hass):
            return self.async_abort(reason="no_mowers")
        if user_input is not None:
            return self.async_create_entry(title=PANEL_TITLE, data={})
        return self.async_show_form(step_id="user")
