/**
 * Mammotion Swath — sidebar panel.
 *
 * Registered through panel_custom, so it runs inside the Home Assistant frontend with the
 * real `hass` object. It is built from Home Assistant's own elements — ha-menu-button,
 * ha-card, ha-alert, ha-button, ha-icon and a native picture-entity card for the live
 * camera — so it follows the user's theme and keeps up with frontend updates. Only the
 * lawn map is drawn here, as SVG.
 */

import {
  applyLayers,
  bearing,
  distance,
  extendTrail,
  lawnRings,
  PanZoom,
  placeRobot,
  Projection,
  renderMap,
  ringArea,
  robotPoint,
} from "./map.js";
import { buildActivity, fetchHistory } from "./activity.js";
import { MOWER_STATES, formatArea, formatRelativeMinutes, formatTime, formatWeeks } from "./format.js";

const DOMAIN = "mammotion_swath";
const SNAPSHOT_EVERY_MS = 60_000;
const HISTORY_EVERY_MS = 5 * 60_000;
const CONFIRM_WINDOW_MS = 6000;
const STORAGE_KEY = "mammotion-swath";
// Travel shorter than this between pose updates is jitter, not a direction.
const MIN_TRAVEL_M = 0.25;
// How long the camera gets to show a picture before the playback hint appears.
const CAMERA_GRACE_MS = 15000;
// The stream counts as failed after its clock stood still for this many checks in a row.
const CAMERA_CHECK_MS = 2000;
const CAMERA_STALL_CHECKS = 3;

const STYLES = /* css */ `
/*
 * Desktop: a full-window app. Nothing scrolls the page; the map card takes all the
 * height left, and the side column scrolls on its own when it is taller than the window.
 * Narrow screens (below) fall back to one stacked, scrolling column.
 */
:host {
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
  background: var(--primary-background-color);
  color: var(--primary-text-color);
  font-family: var(--ha-font-family-body, Roboto, system-ui, sans-serif);
  --swath-gap: 16px;
}
.toolbar {
  display: flex; align-items: center; gap: 4px;
  height: var(--header-height, 56px);
  padding: 0 12px 0 4px;
  padding-top: var(--safe-area-inset-top, 0px);
  background: var(--app-header-background-color, var(--primary-color));
  color: var(--app-header-text-color, var(--text-primary-color, #fff));
  border-bottom: var(--app-header-border-bottom, none);
  box-sizing: content-box;
}
.toolbar .title { flex: 1; font-size: 20px; margin-left: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.toolbar .sun { display: flex; align-items: center; gap: 6px; font-size: 14px; opacity: .92; white-space: nowrap; }
.toolbar select {
  font: inherit; font-size: 14px; color: inherit; background: transparent;
  border: 1px solid currentColor; border-radius: 8px; padding: 6px 8px; min-height: 36px;
}
.toolbar select option { color: var(--primary-text-color); background: var(--card-background-color); }
.root { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.toolbar { flex-shrink: 0; }
main { flex: 1; min-height: 0; width: 100%; padding: var(--swath-gap); display: flex; flex-direction: column; gap: var(--swath-gap); box-sizing: border-box; }
.status, .alerts { flex-shrink: 0; }
.alerts:empty { display: none; }
.status { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.chip {
  display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 14px;
  border-radius: 18px; background: var(--card-background-color);
  border: 1px solid var(--divider-color); font-size: 14px; white-space: nowrap;
}
.chip ha-icon { --mdc-icon-size: 18px; color: var(--secondary-text-color); }
.chip.state ha-icon { color: var(--state-icon-active-color, var(--primary-color)); }
.chip .dim { color: var(--secondary-text-color); }
.spacer { flex: 1; }
.columns { flex: 1; min-height: 0; display: flex; gap: var(--swath-gap); }
.map-slot { flex: 1; min-width: 0; min-height: 0; display: flex; }
.map-slot > ha-card { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.side {
  width: 380px; flex-shrink: 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  display: flex; flex-direction: column; gap: var(--swath-gap);
}
ha-card { overflow: hidden; flex-shrink: 0; }
.card-header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 12px 16px; }
.card-header h2 { margin: 0; flex: 1; font-size: var(--ha-card-header-font-size, 20px); font-weight: var(--ha-font-weight-normal, 400); }
.layers { display: flex; gap: 6px; flex-wrap: wrap; }
.map-slot .card-header, .map-slot .stats, .map-slot .note { flex-shrink: 0; }
.map-wrap { position: relative; flex: 1; min-height: 240px; padding: 0 12px 12px; }
.map-empty { padding: 48px 16px; text-align: center; color: var(--secondary-text-color); }
.lawn-map { display: block; position: absolute; inset: 0 12px 12px; width: calc(100% - 24px); height: calc(100% - 12px); }
.lawn-map .lawn { fill: var(--swath-lawn, rgba(76, 175, 80, .18)); stroke: var(--swath-lawn-edge, #3d8b40); stroke-width: .08; stroke-linejoin: round; }
.lawn-map .obstacle { fill: var(--warning-color, #ff9800); opacity: .7; }
.lawn-map .route path { fill: none; stroke: var(--secondary-text-color); stroke-opacity: .5; stroke-width: .04; }
.lawn-map .mowed path { fill: none; stroke: var(--success-color, #43a047); stroke-opacity: .55; stroke-width: .16; stroke-linecap: round; }
/* The recorded trail, about as wide as the cut, so mowed ground reads as a surface. */
.lawn-map .mowed path.trail { stroke-opacity: .45; stroke-width: .2; stroke-linejoin: round; }
.lawn-map .gaps path { fill: url(#swath-gap); stroke: var(--warning-color, #ff9800); stroke-width: .05; stroke-dasharray: .14 .1; }
.lawn-map .gap-fill { fill: var(--warning-color, #ff9800); fill-opacity: .15; }
.lawn-map .gap-hatch { stroke: var(--warning-color, #ff9800); stroke-width: .1; stroke-opacity: .75; }
.lawn-map .dock-icon .plate { fill: var(--card-background-color); stroke: var(--primary-text-color); stroke-width: .05; }
.lawn-map .dock-icon .tower { fill: var(--primary-text-color); }
.lawn-map .dock-icon .contacts { fill: var(--warning-color, #ffb300); }
.lawn-map .dock-icon .bolt { fill: var(--warning-color, #ffb300); }
.lawn-map .mower-icon .wheel { fill: #1b1d20; }
.lawn-map .mower-icon .body { fill: #3b4048; stroke: #f5f5f5; stroke-width: .035; }
.lawn-map .mower-icon .shell { fill: var(--primary-color); }
.lawn-map .mower-icon .bumper { fill: #23262b; }
.lawn-map .mower-icon .eye { fill: #8fd0ff; }
.lawn-map .mower-icon .stop { fill: #e5484d; }
.lawn-map .robot { filter: drop-shadow(0 1px 1.5px rgba(0, 0, 0, .45)); }
.lawn-map .robot.no-heading { opacity: .55; }
.lawn-map { touch-action: none; cursor: grab; user-select: none; }
.lawn-map.dragging { cursor: grabbing; }
.map-controls {
  position: absolute; right: 20px; top: 4px; display: flex; flex-direction: column;
  border-radius: 12px; background: var(--card-background-color); border: 1px solid var(--divider-color);
  overflow: hidden;
}
.map-controls > * + * { border-top: 1px solid var(--divider-color); }
.map-controls button {
  width: 44px; height: 44px; border: 0; background: transparent; color: var(--primary-text-color);
  display: flex; align-items: center; justify-content: center; cursor: pointer;
}
.map-controls button:disabled { opacity: .4; cursor: default; }
.map-controls ha-icon { --mdc-icon-size: 22px; }
.compass {
  position: absolute; left: 20px; top: 4px; width: 52px; height: 52px; pointer-events: none;
  border-radius: 50%; background: var(--card-background-color); border: 1px solid var(--divider-color);
}
.compass svg { display: block; width: 100%; height: 100%; }
.compass .needle-n { fill: var(--error-color, #db4437); }
.compass .needle-s { fill: var(--secondary-text-color); opacity: .6; }
.compass text { font: 600 9px var(--ha-font-family-body, Roboto, system-ui, sans-serif); fill: var(--secondary-text-color); text-anchor: middle; dominant-baseline: central; }
.compass text.n { fill: var(--error-color, #db4437); }
.progress-badge {
  position: absolute; left: 20px; bottom: 20px; display: flex; align-items: center; gap: 10px;
  padding: 8px 12px; border-radius: 12px; background: var(--card-background-color);
  border: 1px solid var(--divider-color);
}
.progress-badge[hidden] { display: none; }
.camera-hint[hidden] { display: none; }
.camera-stage { position: relative; }
.camera-lost {
  position: absolute; inset: 0; z-index: 2; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 12px; padding: 16px; text-align: center;
  background: #0e1116; color: #c9d1d9;
}
.camera-lost[hidden] { display: none; }
.camera-lost ha-icon { --mdc-icon-size: 36px; color: #9aa3ad; }
.progress-badge .big { font-size: 22px; font-variant-numeric: tabular-nums; }
.progress-badge .dim { font-size: 12px; color: var(--secondary-text-color); }
.stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-top: 1px solid var(--divider-color); }
.stats > div { padding: 12px 16px; }
.stats > div + div { border-left: 1px solid var(--divider-color); }
.stats .label { font-size: 12px; color: var(--secondary-text-color); }
.stats .value { font-size: 20px; font-variant-numeric: tabular-nums; }
.stats .value.warn { color: var(--warning-color, #ff9800); }
.note { padding: 0 16px 12px; font-size: 12px; color: var(--secondary-text-color); }
.camera-switch { display: flex; gap: 6px; }
.jobs, .activity { list-style: none; margin: 0; padding: 0 16px 12px; display: flex; flex-direction: column; gap: 12px; }
.job { display: flex; align-items: center; gap: 12px; }
.job .icon { width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: rgba(var(--rgb-primary-color, 3, 169, 244), .12); color: var(--primary-color); flex-shrink: 0; }
.job .text { flex: 1; min-width: 0; }
.job .name { font-weight: 500; }
.job .meta { font-size: 13px; color: var(--secondary-text-color); }
.fresh { display: flex; align-items: center; gap: 8px; padding: 0 16px 14px; font-size: 13px; color: var(--secondary-text-color); cursor: pointer; }
.fresh input { width: 18px; height: 18px; accent-color: var(--primary-color); margin: 0; }
.activity li { display: flex; gap: 12px; font-size: 14px; }
.activity time { width: 44px; flex-shrink: 0; color: var(--secondary-text-color); font-variant-numeric: tabular-nums; }
.activity .error .title { color: var(--error-color, #db4437); }
.activity .title { font-weight: 500; }
.activity .detail { color: var(--secondary-text-color); }
.empty { padding: 0 16px 16px; color: var(--secondary-text-color); font-size: 14px; }
button.fallback {
  font: inherit; font-weight: 500; min-height: 40px; padding: 0 16px; border-radius: 20px; cursor: pointer;
  border: 1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color);
  display: inline-flex; align-items: center; gap: 6px;
}
button.fallback.primary { background: var(--primary-color); border-color: transparent; color: var(--text-primary-color, #fff); }
button.fallback[aria-pressed="true"] { background: rgba(var(--rgb-primary-color, 3, 169, 244), .14); border-color: var(--primary-color); }
/* Narrow: the page scrolls as one column again, and the map gets a fixed height. */
@media (max-width: 900px) {
  :host { height: auto; min-height: 100vh; overflow: visible; }
  .columns { flex-direction: column; }
  .side { width: auto; overflow: visible; }
  .map-wrap { flex: none; height: 60vh; }
}
@media (max-width: 600px) {
  .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .stats > div:nth-child(3) { border-left: 0; }
  .stats > div:nth-child(n+3) { border-top: 1px solid var(--divider-color); }
  .toolbar .sun .long { display: none; }
}
`;

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (key === "text") node.textContent = value;
    else if (key in node && typeof value !== "string") node[key] = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of [].concat(children)) if (child !== null && child !== undefined) node.append(child);
  return node;
}

const icon = (name) => el("ha-icon", { icon: name });

/** A compass rose. The map is always drawn north-up, so it does not turn. */
function compass() {
  const wrap = el("div", { class: "compass", role: "img", "aria-label": "North is up" });
  wrap.innerHTML = `
    <svg viewBox="-26 -26 52 52" aria-hidden="true">
      <path class="needle-n" d="M0 -15 L5 0 L-5 0 Z"></path>
      <path class="needle-s" d="M0 15 L5 0 L-5 0 Z"></path>
      <text class="n" x="0" y="-20">N</text>
      <text x="20" y="0">E</text>
      <text x="0" y="20">S</text>
      <text x="-20" y="0">W</text>
    </svg>`;
  return wrap;
}

/** querySelector that also looks inside every nested shadow root. */
function deepQuery(root, selector) {
  const scope = root.shadowRoot || root;
  const direct = scope.querySelector?.(selector);
  if (direct) return direct;
  for (const node of scope.querySelectorAll?.("*") || []) {
    if (node.shadowRoot) {
      const found = deepQuery(node, selector);
      if (found) return found;
    }
  }
  return null;
}

/** A native ha-button when the frontend has one, a styled <button> otherwise. */
function button(label, { icon: iconName, primary, pressed, onClick, disabled, small } = {}) {
  if (customElements.get("ha-button")) {
    const node = el("ha-button", {
      appearance: pressed === undefined ? (primary ? "accent" : "outlined") : pressed ? "filled" : "plain",
      variant: primary || pressed ? "brand" : "neutral",
      size: small ? "small" : undefined,
      onclick: onClick,
      disabled,
    });
    if (pressed !== undefined) node.setAttribute("aria-pressed", String(pressed));
    if (iconName) node.append(el("ha-icon", { icon: iconName, slot: "start" }));
    node.append(label);
    return node;
  }
  const node = el("button", { class: `fallback${primary ? " primary" : ""}`, onclick: onClick, disabled, type: "button" });
  if (pressed !== undefined) node.setAttribute("aria-pressed", String(pressed));
  if (iconName) node.append(icon(iconName));
  node.append(label);
  return node;
}

function readPrefs() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function writePrefs(update) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readPrefs(), ...update }));
  } catch {
    /* private mode or blocked storage: preferences are a convenience only */
  }
}

class MammotionSwathPanel extends HTMLElement {
  constructor() {
    super();
    this._hass = null;
    this._narrow = false;
    this._mowers = [];
    this._mowerId = null;
    this._snapshot = null;
    this._activity = [];
    this._layers = { route: true, mowed: true, gaps: true, ...readPrefs().layers };
    this._fresh = readPrefs().fresh !== false;
    this._camera = null;
    this._confirmUntil = 0;
    this._busy = false;
    this._message = null;
    this._rendered = null;
    this._cameraCard = null;
    this._timers = [];
    this._lastMowerState = null;
    this._lastErrorTime = null;
    this._pose = null;
    this._travelFrom = null;
    this._travelHeading = null;
    this._lastFix = null;
    this._panzoom = null;
    this._view = null;
    this._cameraWatch = null;
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._init();
    else this._onHass();
  }

  get hass() {
    return this._hass;
  }

  set narrow(value) {
    this._narrow = value;
    const menu = this.shadowRoot?.querySelector("ha-menu-button");
    if (menu) menu.narrow = value;
  }

  set panel(_value) {}

  set route(_value) {}

  connectedCallback() {
    if (this._hass && !this._timers.length) this._startTimers();
  }

  disconnectedCallback() {
    for (const t of this._timers) clearInterval(t);
    this._timers = [];
    this._stopCameraWatch();
    this._resizeObserver?.disconnect();
  }

  /** Forget the mower's movement, as when switching to another mower. */
  _resetPose() {
    this._pose = null;
    this._travelFrom = null;
    this._travelHeading = null;
    this._lastFix = null;
  }

  /** Feed the tracker's position to the pose logic when it changes (about once a second). */
  _trackPosition() {
    const tracker = this._mower?.roles.tracker;
    const lat = this._attr(tracker, "latitude");
    const lon = this._attr(tracker, "longitude");
    const fix = `${lat},${lon},${this._state(this._mower?.lawn_mower)}`;
    if (fix === this._lastFix) return;
    this._lastFix = fix;
    this._onPose({ latitude: lat, longitude: lon });
  }

  /**
   * A new position. The mower's own reported heading is not used: while docked it was
   * seen to swing by 90° with the mower not moving. Instead, a docked mower faces out of
   * its dock along the map's channel path; a moving one faces where it is going; a
   * stopped one keeps the direction it last travelled in.
   */
  _onPose({ latitude, longitude }) {
    const lat = Number(latitude);
    const lon = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const here = { lat, lon };
    const state = this._state(this._mower?.lawn_mower);
    if (state === "mowing" || state === "returning") {
      extendTrail(this._rendered, here);
      if (!this._travelFrom) {
        this._travelFrom = here;
      } else if (distance(this._travelFrom, here) >= MIN_TRAVEL_M) {
        this._travelHeading = bearing(this._travelFrom, here);
        this._travelFrom = here;
      }
    } else {
      this._travelFrom = here;
      if (state === "docked") this._travelHeading = null;
    }
    this._pose = { lat, lon, heading: this._travelHeading, docked: state === "docked" };
    placeRobot(this._rendered, this._pose);
  }

  async _init() {
    this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLES;
    this.shadowRoot.append(style, el("div", { class: "root" }));
    try {
      // Card helpers pull in the frontend's card elements (ha-card, the picture-entity
      // card and ha-camera-stream with them), which a custom panel cannot import itself.
      this._helpers = await window.loadCardHelpers?.();
    } catch {
      this._helpers = null;
    }
    await Promise.race([customElements.whenDefined("ha-button"), new Promise((r) => setTimeout(r, 1500))]);
    await this._loadMowers();
    this._startTimers();
    this._trackPosition();
  }

  _startTimers() {
    this._timers.push(setInterval(() => !document.hidden && this._loadSnapshot(), SNAPSHOT_EVERY_MS));
    this._timers.push(setInterval(() => !document.hidden && this._loadActivity(), HISTORY_EVERY_MS));
  }

  get _mower() {
    return this._mowers.find((m) => m.lawn_mower === this._mowerId) || null;
  }

  async _loadMowers() {
    try {
      const { mowers } = await this._hass.callWS({ type: `${DOMAIN}/mowers` });
      this._mowers = mowers;
    } catch (err) {
      this._mowers = [];
      this._message = `Couldn't list mowers: ${err.message || err}`;
    }
    const saved = readPrefs().mower;
    this._mowerId = (this._mowers.find((m) => m.lawn_mower === saved) || this._mowers[0])?.lawn_mower || null;
    this._camera = this._mower?.cameras[0] || null;
    this._render();
    await Promise.all([this._loadSnapshot(), this._loadActivity()]);
  }

  async _loadSnapshot() {
    if (!this._mowerId) return;
    try {
      this._snapshot = await this._hass.callWS({ type: `${DOMAIN}/snapshot`, lawn_mower: this._mowerId });
      const fresh = this._snapshot.mower;
      this._mowers = this._mowers.map((m) => (m.lawn_mower === fresh.lawn_mower ? fresh : m));
      if (!fresh.cameras.includes(this._camera)) this._camera = fresh.cameras[0] || null;
    } catch (err) {
      this._message = `Couldn't load the map: ${err.message || err}`;
    }
    this._renderSnapshot();
  }

  async _loadActivity() {
    const mower = this._mower;
    if (!mower) return;
    try {
      const history = await fetchHistory(this._hass, [
        mower.lawn_mower,
        mower.roles.error_code,
        mower.roles.error_message,
        mower.roles.error_time,
      ]);
      this._activity = buildActivity(history, {
        lawnMower: mower.lawn_mower,
        errorCode: mower.roles.error_code,
        errorMessage: mower.roles.error_message,
        errorTime: mower.roles.error_time,
      });
    } catch {
      this._activity = [];
    }
    this._renderActivity();
  }

  _onHass() {
    const mower = this._mower;
    if (!mower) return;
    const state = this._state(mower.lawn_mower);
    const errorTime = this._state(mower.roles.error_time);
    // A job starting or stopping changes the route and the stored breakpoint.
    if (state !== this._lastMowerState || errorTime !== this._lastErrorTime) {
      const changed = this._lastMowerState !== null;
      this._lastMowerState = state;
      this._lastErrorTime = errorTime;
      if (changed) {
        this._loadSnapshot();
        this._loadActivity();
        return;
      }
    }
    this._renderStatus();
    this._trackPosition();
    if (this._cameraCard) this._cameraCard.hass = this._hass;
    const menu = this.shadowRoot.querySelector("ha-menu-button");
    if (menu) menu.hass = this._hass;
  }

  _state(entityId) {
    return entityId ? this._hass.states[entityId]?.state : undefined;
  }

  _attr(entityId, name) {
    return entityId ? this._hass.states[entityId]?.attributes?.[name] : undefined;
  }

  _robot() {
    const docked = this._state(this._mower?.lawn_mower) === "docked";
    if (this._pose) return { ...this._pose, docked };
    // Until the pose subscription answers, the tracker's position; its `direction`
    // attribute is truncated radians, not a compass bearing, so it is not used.
    const tracker = this._mower?.roles.tracker;
    return { lat: Number(this._attr(tracker, "latitude")), lon: Number(this._attr(tracker, "longitude")), heading: null, docked };
  }

  // ----------------------------------------------------------------- rendering

  _render() {
    const root = this.shadowRoot.querySelector(".root");
    root.replaceChildren(this._renderToolbar(), this._renderMain());
    this._renderStatus();
    this._renderActivity();
  }

  _renderToolbar() {
    const menu = el("ha-menu-button");
    menu.hass = this._hass;
    menu.narrow = this._narrow;
    const children = [menu, el("div", { class: "title", text: this._mower?.name || "Mower" })];
    if (this._mowers.length > 1) {
      const select = el("select", {
        "aria-label": "Mower",
        onchange: (ev) => {
          this._mowerId = ev.target.value;
          writePrefs({ mower: this._mowerId });
          this._snapshot = null;
          this._view = null;
          this._resetPose();
          this._camera = this._mower?.cameras[0] || null;
          this._render();
          this._loadSnapshot();
          this._loadActivity();
          this._trackPosition();
        },
      });
      for (const m of this._mowers) select.append(el("option", { value: m.lawn_mower, text: m.name, selected: m.lawn_mower === this._mowerId }));
      children.push(select);
    }
    children.push(el("div", { class: "sun" }));
    return el("header", { class: "toolbar" }, children);
  }

  _renderMain() {
    if (!this._mowers.length) {
      return el("main", {}, [
        el("ha-alert", { "alert-type": "info", title: "No Mammotion mower found" }, [
          this._message || "Set up the Mammotion integration, then reload this page.",
        ]),
      ]);
    }
    return el("main", {}, [
      el("section", { class: "status", "aria-label": "Status" }),
      el("div", { class: "alerts" }),
      el("div", { class: "columns" }, [
        el("div", { class: "map-slot" }, [this._renderMapCard()]),
        el("div", { class: "side" }, [
          el("div", { class: "camera-slot" }, [this._renderCameraCard()]),
          el("div", { class: "jobs-slot" }, [this._renderJobsCard()]),
          this._renderActivityCard(),
        ]),
      ]),
    ]);
  }

  /**
   * Refresh what a new snapshot changes. The camera card is left alone unless the set of
   * cameras changed: rebuilding it would restart the live stream on every refresh.
   */
  _renderSnapshot() {
    const mapSlot = this.shadowRoot.querySelector(".map-slot");
    if (!mapSlot) {
      this._render();
      return;
    }
    mapSlot.replaceChildren(this._renderMapCard());
    this.shadowRoot.querySelector(".jobs-slot")?.replaceChildren(this._renderJobsCard());
    if (this._cameraKeyFor() !== this._cameraKey) {
      this.shadowRoot.querySelector(".camera-slot")?.replaceChildren(this._renderCameraCard());
    }
    this._renderStatus();
  }

  _cameraKeyFor() {
    return `${(this._mower?.cameras || []).join(",")}|${this._camera}`;
  }

  _renderStatus() {
    const mower = this._mower;
    const status = this.shadowRoot.querySelector(".status");
    const sun = this.shadowRoot.querySelector(".toolbar .sun");
    if (sun) sun.replaceChildren(...this._sunContent());
    if (!status || !mower) return;

    const state = this._state(mower.lawn_mower) || "unavailable";
    const battery = this._state(mower.roles.battery);
    const charging = this._state(mower.charging) === "on";
    const left = Number(this._state(mower.roles.time_left));
    const connection = this._state(mower.roles.connection);

    const chips = [
      el("span", { class: "chip state" }, [icon("mdi:robot-mower"), el("strong", { text: MOWER_STATES[state] || state })]),
    ];
    if (battery !== undefined && battery !== "unavailable") {
      chips.push(el("span", { class: "chip" }, [icon(charging ? "mdi:battery-charging" : "mdi:battery"), `${battery}%`]));
    }
    if (connection && connection !== "unavailable") chips.push(el("span", { class: "chip" }, [icon("mdi:wifi"), connection]));
    if (state === "mowing" && Number.isFinite(left) && left > 0) {
      chips.push(el("span", { class: "chip" }, [icon("mdi:timer-outline"), `≈ ${left} min left`]));
    }
    chips.push(el("span", { class: "spacer" }));
    if (state === "mowing") {
      chips.push(button("Pause", { icon: "mdi:pause", onClick: () => this._call("lawn_mower", "pause") }));
      chips.push(button("Return to dock", { icon: "mdi:home-import-outline", onClick: () => this._call("lawn_mower", "dock") }));
    } else if (state === "paused") {
      chips.push(button("Resume", { icon: "mdi:play", primary: true, onClick: () => this._call("lawn_mower", "start_mowing") }));
      chips.push(button("Return to dock", { icon: "mdi:home-import-outline", onClick: () => this._call("lawn_mower", "dock") }));
    }
    status.replaceChildren(...chips);
    this._renderAlerts();
    this._renderProgressBadge();
  }

  _sunContent() {
    const sun = this._hass.states["sun.sun"];
    if (!sun) return [];
    if (sun.state === "below_horizon") {
      const rising = sun.attributes.next_rising ? new Date(sun.attributes.next_rising) : null;
      return [icon("mdi:weather-night"), el("span", { text: rising ? `Daylight at ${formatTime(rising)}` : "After sunset" })];
    }
    const setting = sun.attributes.next_setting ? new Date(sun.attributes.next_setting) : null;
    const rel = setting ? formatRelativeMinutes(setting) : null;
    return [icon("mdi:weather-sunset-down"), el("span", {}, [el("span", { class: "long", text: "Sunset " }), rel ? `in ${rel}` : ""])];
  }

  _renderAlerts() {
    const host = this.shadowRoot.querySelector(".alerts");
    if (!host) return;
    const mower = this._mower;
    const job = this._snapshot?.job;
    const coverage = this._snapshot?.coverage;
    const state = this._state(mower?.lawn_mower);
    const alerts = [];

    if (this._message) {
      alerts.push(
        el("ha-alert", {
          "alert-type": "error",
          dismissable: true,
          "onalert-dismissed-clicked": () => {
            this._message = null;
            this._renderAlerts();
          },
        }, [this._message]),
      );
    }

    const gap = coverage?.gap_area_m2 || 0;
    if (job?.has_breakpoint && state !== "mowing" && state !== "returning") {
      const confirming = Date.now() < this._confirmUntil;
      const action = button(confirming ? "Drop the stored route" : "Plan a fresh route", {
        primary: true,
        disabled: this._busy,
        onClick: () => this._planFresh(),
      });
      action.setAttribute("slot", "action");
      const detail =
        gap >= 1
          ? `The stored route leaves about ${Math.round(gap)} m² of lawn out. Dropping it makes the next start plan against the current map.`
          : "The next start continues an earlier job's route instead of planning a new one. If the map changed since, it may not match.";
      alerts.push(el("ha-alert", { "alert-type": "warning", title: "Next start resumes the stored route" }, [detail, action]));
    } else if (gap >= 1) {
      alerts.push(
        el("ha-alert", { "alert-type": "warning", title: `This route leaves about ${Math.round(gap)} m² out` }, [
          "Measured from the route Home Assistant received, which can arrive in parts. The hatched areas are lawn no route line passes near.",
        ]),
      );
    }
    host.replaceChildren(...alerts);
  }

  _renderLayerToggles() {
    return el("div", { class: "layers", role: "group", "aria-label": "Map layers" }, [
      ["route", "Planned route"],
      ["mowed", "Mowed"],
      ["gaps", "Not in route"],
    ].map(([key, label]) =>
      button(label, {
        small: true,
        pressed: this._layers[key],
        onClick: () => {
          this._layers = { ...this._layers, [key]: !this._layers[key] };
          writePrefs({ layers: this._layers });
          if (this._rendered) applyLayers(this._rendered.svg, this._layers);
          this.shadowRoot.querySelector(".layers")?.replaceWith(this._renderLayerToggles());
        },
      }),
    ));
  }

  _renderMapCard() {
    const card = el("ha-card", { class: "map-card" });
    card.append(el("div", { class: "card-header" }, [el("h2", { text: "Live map" }), this._renderLayerToggles()]));

    const wrap = el("div", { class: "map-wrap" });
    const snap = this._snapshot;
    // Keep the user's zoom and pan across the periodic refresh.
    if (this._panzoom) this._view = this._panzoom.view;
    this._panzoom = null;
    this._rendered = snap
      ? renderMap({
          map: snap.map,
          route: snap.route,
          progress: snap.progress,
          trail: snap.trail,
          coverage: snap.coverage,
          robot: this._robot(),
          layers: this._layers,
          labels: { mapAria: `Lawn map of ${this._mower?.name || "the mower"}` },
        })
      : null;
    if (this._rendered) {
      const rescale = () => placeRobot(this._rendered, this._robot());
      this._panzoom = new PanZoom(this._rendered.svg, this._view, rescale);
      wrap.append(this._rendered.svg, compass(), this._renderMapControls(), el("div", { class: "progress-badge", hidden: true }));
      // Icon sizes depend on the map's size on screen, known only once it is laid out.
      this._resizeObserver?.disconnect();
      this._resizeObserver = new ResizeObserver(rescale);
      this._resizeObserver.observe(wrap);
    } else {
      wrap.append(el("div", { class: "map-empty", text: snap ? "The map has not synced from the mower yet." : "Loading the map…" }));
    }
    card.append(wrap, this._renderStats());
    const routeCount = (snap?.route?.features || []).length;
    if (snap && !routeCount) {
      const working = ["mowing", "returning", "paused"].includes(this._state(this._mower?.lawn_mower));
      const text = working
        ? "The mower has not shared this job's planned route, so only the mowed trail is shown."
        : "The planned route appears while a job runs.";
      card.append(el("div", { class: "note", text }));
    }
    return card;
  }

  _renderMapControls() {
    const control = (iconName, label, onClick) =>
      el("button", { type: "button", "aria-label": label, title: label, onclick: onClick }, [icon(iconName)]);
    return el("div", { class: "map-controls", role: "group", "aria-label": "Map view" }, [
      control("mdi:plus", "Zoom in", () => this._panzoom?.zoomBy(1.6)),
      control("mdi:minus", "Zoom out", () => this._panzoom?.zoomBy(1 / 1.6)),
      control("mdi:crosshairs-gps", "Centre on the mower", () => {
        const point = robotPoint(this._rendered, this._robot());
        if (!point || !this._panzoom) return;
        if (this._panzoom.zoom < 2) this._panzoom.zoomBy(2.5 / this._panzoom.zoom);
        this._panzoom.centerOn(...point);
      }),
      control("mdi:fit-to-screen-outline", "Show the whole lawn", () => this._panzoom?.reset()),
    ]);
  }

  _renderStats() {
    const snap = this._snapshot;
    const rings = lawnRings(snap?.map);
    let lawn = snap?.coverage?.lawn_area_m2;
    if (!Number.isFinite(lawn) && rings.length) {
      const projection = new Projection(...rings[0].ring[0]);
      lawn = rings.reduce((sum, { ring }) => sum + ringArea(projection, ring), 0);
    }
    const gap = snap?.coverage?.gap_area_m2;
    const cell = (label, value, warn) => el("div", {}, [el("div", { class: "label", text: label }), el("div", { class: `value${warn ? " warn" : ""}`, text: value })]);
    return el("div", { class: "stats" }, [
      cell("Lawn on the map", formatArea(lawn)),
      cell("In this route", formatArea(snap?.job?.route_area_m2)),
      cell("Not in route", Number.isFinite(gap) ? formatArea(gap) : "—", gap >= 1),
      cell("Progress", this._progressText()),
    ]);
  }

  /** One progress figure everywhere: the progress sensor, else the mower's report. */
  _progressText() {
    const sensor = Number(this._state(this._mower?.roles.progress));
    if (Number.isFinite(sensor)) return `${sensor}%`;
    const reported = this._snapshot?.job?.route_progress_pct;
    return Number.isFinite(reported) ? `${reported}%` : "—";
  }

  _renderProgressBadge() {
    const badge = this.shadowRoot.querySelector(".progress-badge");
    const mower = this._mower;
    if (!badge || !mower) return;
    const state = this._state(mower.lawn_mower);
    const progress = Number(this._state(mower.roles.progress));
    if (state !== "mowing" || !Number.isFinite(progress)) {
      badge.hidden = true;
      return;
    }
    const r = 18;
    const c = 2 * Math.PI * r;
    badge.hidden = false;
    badge.innerHTML = `
      <svg width="44" height="44" viewBox="0 0 44 44" role="img" aria-label="${progress} percent mowed">
        <circle cx="22" cy="22" r="${r}" fill="none" stroke="var(--divider-color)" stroke-width="5"></circle>
        <circle cx="22" cy="22" r="${r}" fill="none" stroke="var(--success-color, #43a047)" stroke-width="5"
          stroke-linecap="round" stroke-dasharray="${((progress / 100) * c).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 22 22)"></circle>
      </svg>
      <div><div class="big">${progress}%</div><div class="dim">of this job</div></div>`;
  }

  _renderCameraCard() {
    const mower = this._mower;
    this._cameraCard = null;
    this._cameraKey = this._cameraKeyFor();
    if (!mower?.cameras.length) return el("span");
    const card = el("ha-card");
    const header = el("div", { class: "card-header" }, [el("h2", { text: "Camera" })]);
    if (mower.cameras.length > 1) {
      header.append(
        el("div", { class: "camera-switch", role: "group", "aria-label": "Choose camera" }, mower.cameras.map((entityId) =>
          button(this._hass.states[entityId]?.attributes?.friendly_name?.replace(mower.name, "").trim() || entityId, {
            small: true,
            pressed: entityId === this._camera,
            onClick: () => {
              this._camera = entityId;
              this.shadowRoot.querySelector(".camera-slot")?.replaceChildren(this._renderCameraCard());
            },
          }),
        )),
      );
    }
    card.append(header);
    if (this._helpers && this._camera) {
      const live = this._helpers.createCardElement({
        type: "picture-entity",
        entity: this._camera,
        camera_view: "live",
        show_name: false,
        show_state: false,
      });
      live.hass = this._hass;
      this._cameraCard = live;
      // The overlay sits over the player, so a failed stream never shows the card's own
      // still-image fallback or its error text; it offers a refresh instead.
      const lost = el("div", { class: "camera-lost", hidden: true, role: "alert" }, [
        icon("mdi:video-off-outline"),
        el("div", { text: "The stream stopped." }),
        button("Refresh", {
          icon: "mdi:refresh",
          primary: true,
          onClick: () => this.shadowRoot.querySelector(".camera-slot")?.replaceChildren(this._renderCameraCard()),
        }),
      ]);
      card.append(el("div", { class: "camera-stage" }, [live, lost]));
      const hint = el("div", {
        class: "note camera-hint",
        hidden: true,
        text: "No picture yet. The mower sends H.265 video, which this browser may not be able to play. Safari and the Home Assistant apps on Apple devices can.",
      });
      card.append(hint);
      this._watchCamera(live, hint, lost);
    } else {
      card.append(el("div", { class: "empty", text: "The camera card could not be loaded." }));
    }
    return card;
  }

  /**
   * Watch the stream. The native card keeps its video deep in nested shadow roots.
   * - A frame has arrived once that video has a size: from then on the stream "has played".
   * - Never played within the grace period: show the playback hint (likely an H.265 issue).
   * - Played, then the video is gone, paused, ended or its clock stands still for a few
   *   checks: the stream failed, so show the refresh overlay instead.
   */
  _watchCamera(card, hint, lost) {
    this._stopCameraWatch();
    const started = Date.now();
    let hasPlayed = false;
    let lastTime = null;
    let stalled = 0;
    // A tab left alone is where streams usually die: the browser throttles it and the
    // connection times out. Nothing is judged while hidden, but on coming back a single
    // check decides — a live stream has advanced by then, a dead one has not.
    this._cameraVisibility = () => {
      if (!document.hidden && hasPlayed) stalled = Math.max(stalled, CAMERA_STALL_CHECKS - 1);
    };
    document.addEventListener("visibilitychange", this._cameraVisibility);
    this._cameraWatch = setInterval(() => {
      if (!card.isConnected) {
        this._stopCameraWatch();
        return;
      }
      // A hidden tab throttles playback; judging it then would raise false alarms.
      if (document.hidden) return;
      const video = deepQuery(card, "video");
      const playing = Boolean(video && video.videoWidth > 0 && !video.paused && !video.ended);
      const advancing = playing && video.currentTime !== lastTime;
      lastTime = video ? video.currentTime : null;
      if (advancing) {
        hasPlayed = true;
        stalled = 0;
      } else if (hasPlayed) {
        stalled += 1;
      }
      const failed = hasPlayed && stalled >= CAMERA_STALL_CHECKS;
      lost.hidden = !failed;
      hint.hidden = hasPlayed || Date.now() - started < CAMERA_GRACE_MS;
    }, CAMERA_CHECK_MS);
  }

  _stopCameraWatch() {
    clearInterval(this._cameraWatch);
    if (this._cameraVisibility) {
      document.removeEventListener("visibilitychange", this._cameraVisibility);
      this._cameraVisibility = null;
    }
  }

  _renderJobsCard() {
    const card = el("ha-card");
    card.append(el("div", { class: "card-header" }, [el("h2", { text: "Jobs" })]));
    const tasks = this._snapshot?.tasks || [];
    if (!tasks.length) {
      card.append(el("div", { class: "empty", text: this._snapshot ? "No saved jobs. Create one in the Mammotion app." : "Loading…" }));
      return card;
    }
    const list = el("ul", { class: "jobs" });
    const state = this._state(this._mower.lawn_mower);
    for (const task of tasks) {
      const schedule = task.enabled ? `${formatWeeks(task.weeks)} at ${task.start_time}` : "Schedule off";
      list.append(
        el("li", { class: "job" }, [
          el("span", { class: "icon" }, [icon(task.enabled ? "mdi:calendar-clock" : "mdi:calendar-remove-outline")]),
          el("div", { class: "text" }, [el("div", { class: "name", text: task.name || "Job" }), el("div", { class: "meta", text: `${schedule} · ${task.knife_height} mm` })]),
          button("Start now", {
            primary: true,
            disabled: this._busy || state === "mowing" || !task.entity_id,
            onClick: () => this._startTask(task.entity_id),
          }),
        ]),
      );
    }
    card.append(list);
    const fresh = el("label", { class: "fresh" }, [
      el("input", { type: "checkbox", checked: this._fresh, onchange: (ev) => { this._fresh = ev.target.checked; writePrefs({ fresh: this._fresh }); } }),
      "Plan a fresh route first, instead of resuming a stored one",
    ]);
    card.append(fresh);
    return card;
  }

  _renderActivityCard() {
    return el("ha-card", { class: "activity-card" }, [el("div", { class: "card-header" }, [el("h2", { text: "Activity" })]), el("ol", { class: "activity" })]);
  }

  _renderActivity() {
    const list = this.shadowRoot.querySelector(".activity");
    if (!list) return;
    if (!this._activity.length) {
      list.replaceChildren(el("li", { class: "detail", text: "Nothing in the last 24 hours." }));
      return;
    }
    list.replaceChildren(
      ...this._activity.map((item) =>
        el("li", { class: item.kind }, [
          el("time", { datetime: item.at.toISOString(), text: formatTime(item.at) }),
          el("span", {}, [
            el("span", { class: "title", text: item.count > 1 ? `${item.title} ×${item.count}` : item.title }),
            item.detail ? el("span", { class: "detail", text: ` ${item.detail}` }) : null,
          ]),
        ]),
      ),
    );
  }

  // ------------------------------------------------------------------- actions

  async _call(domain, service) {
    try {
      await this._hass.callService(domain, service, { entity_id: this._mowerId });
    } catch (err) {
      this._message = err.message || String(err);
      this._renderAlerts();
    }
  }

  async _planFresh() {
    if (Date.now() >= this._confirmUntil) {
      this._confirmUntil = Date.now() + CONFIRM_WINDOW_MS;
      this._renderAlerts();
      setTimeout(() => this._renderAlerts(), CONFIRM_WINDOW_MS + 50);
      return;
    }
    this._confirmUntil = 0;
    this._busy = true;
    this._renderAlerts();
    try {
      await this._hass.callWS({ type: `${DOMAIN}/plan_fresh`, lawn_mower: this._mowerId });
    } catch (err) {
      this._message = err.message || String(err);
    }
    this._busy = false;
    await this._loadSnapshot();
  }

  async _startTask(taskEntity) {
    this._busy = true;
    this._renderSnapshot();
    try {
      await this._hass.callWS({ type: `${DOMAIN}/start_task`, lawn_mower: this._mowerId, task: taskEntity, fresh: this._fresh });
    } catch (err) {
      this._message = err.message || String(err);
    }
    this._busy = false;
    await this._loadSnapshot();
  }
}

customElements.define("mammotion-swath-panel", MammotionSwathPanel);
