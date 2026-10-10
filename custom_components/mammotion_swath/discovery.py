"""Find Mammotion mowers and the entities that belong to each, from the registries.

Everything is matched on registry facts the upstream integration sets on purpose —
platform, device, domain and translation key — never on entity ids, which the user can
rename at will.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr, entity_registry as er

from .const import ROLE_TRANSLATION_KEYS, UPSTREAM_DOMAIN


@dataclass
class MowerEntities:
    """The entities Swath reads and drives for one mower."""

    device_id: str
    name: str
    unique_name: str | None
    model: str | None
    lawn_mower: str
    roles: dict[str, str] = field(default_factory=dict)
    cameras: list[str] = field(default_factory=list)
    tasks: list[str] = field(default_factory=list)
    areas: list[str] = field(default_factory=list)
    charging: str | None = None

    def as_dict(self) -> dict[str, object]:
        """Serialise for the websocket API."""
        return {
            "device_id": self.device_id,
            "name": self.name,
            "model": self.model,
            "lawn_mower": self.lawn_mower,
            "roles": dict(self.roles),
            "cameras": list(self.cameras),
            "tasks": list(self.tasks),
            "areas": list(self.areas),
            "charging": self.charging,
        }


def _upstream_unique_name(device: dr.DeviceEntry | None) -> str | None:
    """Return the upstream device key, the second half of its registry identifier."""
    if device is None:
        return None
    for domain, key in device.identifiers:
        if domain == UPSTREAM_DOMAIN:
            return key
    return None


def async_discover_mowers(hass: HomeAssistant) -> list[MowerEntities]:
    """Return every Mammotion mower with its related entities, sorted by name."""
    ent_reg = er.async_get(hass)
    dev_reg = dr.async_get(hass)
    role_by_key = {key: role for role, key in ROLE_TRANSLATION_KEYS.items()}

    mowers: dict[str, MowerEntities] = {}
    for entry in ent_reg.entities.values():
        if entry.platform != UPSTREAM_DOMAIN or entry.domain != "lawn_mower":
            continue
        if entry.disabled_by is not None or entry.device_id is None:
            continue
        device = dev_reg.async_get(entry.device_id)
        mowers[entry.device_id] = MowerEntities(
            device_id=entry.device_id,
            name=(device.name_by_user or device.name) if device else entry.entity_id,
            unique_name=_upstream_unique_name(device),
            model=device.model if device else None,
            lawn_mower=entry.entity_id,
        )

    for entry in ent_reg.entities.values():
        mower = mowers.get(entry.device_id or "")
        if mower is None or entry.platform != UPSTREAM_DOMAIN or entry.disabled_by:
            continue
        if entry.domain == "camera":
            mower.cameras.append(entry.entity_id)
        elif (role := role_by_key.get(entry.translation_key or "")) is not None:
            mower.roles.setdefault(role, entry.entity_id)
        elif entry.domain == "binary_sensor" and entry.entity_id.endswith("_charging"):
            mower.charging = entry.entity_id
        elif entry.domain == "button" and _has_attribute(hass, entry.entity_id, "task_id"):
            mower.tasks.append(entry.entity_id)
        elif entry.domain == "switch" and _has_attribute(hass, entry.entity_id, "hash"):
            mower.areas.append(entry.entity_id)

    for mower in mowers.values():
        mower.cameras.sort(key=_camera_order)
        mower.tasks.sort()
        mower.areas.sort()
    return sorted(mowers.values(), key=lambda m: m.name.lower())


def async_find_mower(hass: HomeAssistant, lawn_mower: str) -> MowerEntities | None:
    """Return the discovered mower whose lawn_mower entity is *lawn_mower*."""
    return next((m for m in async_discover_mowers(hass) if m.lawn_mower == lawn_mower), None)


def _has_attribute(hass: HomeAssistant, entity_id: str, attribute: str) -> bool:
    """Whether the entity's current state carries *attribute*."""
    state = hass.states.get(entity_id)
    return state is not None and attribute in state.attributes


def _camera_order(entity_id: str) -> tuple[int, str]:
    """Left/front feed first, so the panel opens on the camera every model publishes."""
    return (0 if "right" not in entity_id and "rear" not in entity_id else 1, entity_id)
