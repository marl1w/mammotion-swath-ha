/**
 * The lawn map: areas, planned route, mowed progress, coverage gaps, dock and robot.
 *
 * Everything arrives as GeoJSON in lon/lat from the Mammotion integration. It is
 * projected into a local metric frame (equirectangular around the first lawn vertex —
 * exact enough for a garden), north up, and drawn as one SVG that scales with its card.
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON = 111320;
const PADDING_M = 1.2;

const features = (collection) => (collection && collection.features) || [];

function svg(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  }
  for (const child of children) node.append(child);
  return node;
}

/** A projection fitted to the lawn, mapping lon/lat to SVG user units (metres). */
export class Projection {
  constructor(lon0, lat0) {
    this.lon0 = lon0;
    this.lat0 = lat0;
    this.kx = M_PER_DEG_LON * Math.cos((lat0 * Math.PI) / 180);
  }

  /** Metres east and *south* of the origin, so SVG's y-down reads north-up. */
  point([lon, lat]) {
    return [(lon - this.lon0) * this.kx, -(lat - this.lat0) * M_PER_DEG_LAT];
  }

  path(coords, close) {
    const pts = coords.map((c) => this.point(c).map((v) => v.toFixed(2)).join(","));
    return pts.length ? `M${pts.join("L")}${close ? "Z" : ""}` : "";
  }
}

/** Return the lawn polygons (exterior rings) from the map GeoJSON. */
export function lawnRings(map) {
  return features(map)
    .filter((f) => f.properties?.type_name === "area" && f.geometry?.type === "Polygon")
    .map((f) => ({ ring: f.geometry.coordinates[0], name: f.properties?.title || f.properties?.Name }));
}

/** Shoelace area of a ring, in m², through *projection*. */
export function ringArea(projection, ring) {
  let sum = 0;
  const pts = ring.map((c) => projection.point(c));
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/**
 * Build the map SVG. *layers* toggles route/mowed/gaps; *robot* is {lon, lat, heading}.
 * Returns {svg, projection} or null when the map has no lawn yet.
 */
export function renderMap({ map, route, progress, trail, coverage, robot, layers, labels }) {
  const rings = lawnRings(map);
  if (!rings.length) return null;
  const projection = new Projection(...rings[0].ring[0]);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { ring } of rings) {
    for (const c of ring) {
      const [x, y] = projection.point(c);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  const width = maxX - minX + 2 * PADDING_M;
  const height = maxY - minY + 2 * PADDING_M;

  const root = svg("svg", {
    viewBox: `${(minX - PADDING_M).toFixed(2)} ${(minY - PADDING_M).toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)}`,
    width: "100%",
    role: "img",
    "aria-label": labels.mapAria,
    class: "lawn-map",
  });
  root.append(
    svg("defs", {}, [
      svg("pattern", { id: "swath-gap", width: 0.35, height: 0.35, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }, [
        svg("rect", { width: 0.35, height: 0.35, class: "gap-fill" }),
        svg("line", { x1: 0, y1: 0, x2: 0, y2: 0.35, class: "gap-hatch" }),
      ]),
    ]),
  );

  for (const { ring } of rings) root.append(svg("path", { d: projection.path(ring, true), class: "lawn" }));

  for (const f of features(map)) {
    if (f.properties?.type_name === "visual_obstacle_zone" && f.geometry?.type === "Polygon") {
      root.append(svg("path", { d: projection.path(f.geometry.coordinates[0], true), class: "obstacle" }));
    }
  }

  const routeGroup = svg("g", { class: "route", "data-layer": "route" });
  for (const f of features(route)) {
    if (f.geometry?.type === "LineString") routeGroup.append(svg("path", { d: projection.path(f.geometry.coordinates, false) }));
  }
  root.append(routeGroup);

  // Mowed: the trail Swath recorded, which is where the mower really drove. Upstream's
  // progress layer is route lines marked done, so it only means something alongside a
  // route; without one it is a stale fragment and is left out.
  const mowedGroup = svg("g", { class: "mowed", "data-layer": "mowed" });
  if (features(route).length) {
    for (const f of features(progress)) {
      if (f.geometry?.type === "LineString" && f.geometry.coordinates.length > 1) {
        mowedGroup.append(svg("path", { d: projection.path(f.geometry.coordinates, false) }));
      }
    }
  }
  const trailPoints = (features(trail)[0]?.geometry?.coordinates || []).map((c) => [c[0], c[1]]);
  const trailNode = svg("path", { class: "trail", d: projection.path(trailPoints, false) });
  mowedGroup.append(trailNode);
  root.append(mowedGroup);

  const gapGroup = svg("g", { class: "gaps", "data-layer": "gaps" });
  for (const f of features(coverage?.gaps)) {
    if (f.geometry?.type === "Polygon") gapGroup.append(svg("path", { d: projection.path(f.geometry.coordinates[0], true) }));
  }
  root.append(gapGroup);

  const dock = features(map).find((f) => f.geometry?.type === "Point" && /dock/i.test(f.properties?.title || ""));
  let dockNode = null;
  let dockExit = null;
  if (dock) {
    const [x, y] = projection.point(dock.geometry.coordinates);
    dockNode = svg("g", { class: "dock" }, [dockIcon()]);
    dockNode.dataset.x = x;
    dockNode.dataset.y = y;
    root.append(dockNode);
    dockExit = dockExitBearing(map, projection, [x, y]);
  }

  const robotNode = svg("g", { class: "robot", visibility: "hidden" }, [mowerIcon()]);
  root.append(robotNode);

  const result = { svg: root, projection, robotNode, dockNode, dockExit, trailNode, trailPoints };
  applyLayers(root, layers);
  placeRobot(result, robot);
  return result;
}

/** Compass bearing from one projected point to another (SVG y grows southwards). */
const bearingXY = ([x1, y1], [x2, y2]) => ((Math.atan2(x2 - x1, -(y2 - y1)) * 180) / Math.PI + 360) % 360;

/**
 * The direction a mower leaves its dock in: along the map's channel path that starts at
 * the dock, from the dock end outwards. A docked mower faces this way, and so does the
 * dock's opening. Null when no path starts near the dock.
 */
function dockExitBearing(map, projection, dockPoint) {
  let best = null;
  for (const f of features(map)) {
    if (f.properties?.type_name !== "path" || f.geometry?.type !== "LineString") continue;
    const coords = f.geometry.coordinates;
    if (coords.length < 2) continue;
    const first = projection.point(coords[0]);
    const last = projection.point(coords[coords.length - 1]);
    const dFirst = Math.hypot(first[0] - dockPoint[0], first[1] - dockPoint[1]);
    const dLast = Math.hypot(last[0] - dockPoint[0], last[1] - dockPoint[1]);
    const [near, far, d] = dFirst <= dLast ? [first, last, dFirst] : [last, first, dLast];
    if (d < DOCK_PATH_MAX_M && (!best || d < best.d)) best = { d, bearing: bearingXY(near, far) };
  }
  return best ? best.bearing : null;
}

// A channel path counts as leaving the dock when one of its ends is this close to it.
const DOCK_PATH_MAX_M = 3;

// The icons are drawn one unit long, front towards -y (north before rotation), and
// scaled to real size — or larger, so they stay findable when the lawn is zoomed out.
const MOWER_LENGTH_M = 0.6;
const DOCK_LENGTH_M = 0.8;
const MIN_ICON_PX = 30;

/** A robot mower seen from above: wheels, body, shell, front bumper and cameras. */
function mowerIcon() {
  return svg("g", { class: "mower-icon" }, [
    svg("rect", { x: -0.43, y: -0.36, width: 0.1, height: 0.22, rx: 0.04, class: "wheel" }),
    svg("rect", { x: 0.33, y: -0.36, width: 0.1, height: 0.22, rx: 0.04, class: "wheel" }),
    svg("rect", { x: -0.45, y: 0.1, width: 0.12, height: 0.3, rx: 0.05, class: "wheel" }),
    svg("rect", { x: 0.33, y: 0.1, width: 0.12, height: 0.3, rx: 0.05, class: "wheel" }),
    svg("rect", { x: -0.34, y: -0.5, width: 0.68, height: 1, rx: 0.22, class: "body" }),
    svg("rect", { x: -0.25, y: -0.26, width: 0.5, height: 0.62, rx: 0.14, class: "shell" }),
    svg("rect", { x: -0.28, y: -0.5, width: 0.56, height: 0.13, rx: 0.065, class: "bumper" }),
    svg("circle", { cx: -0.1, cy: -0.435, r: 0.04, class: "eye" }),
    svg("circle", { cx: 0.1, cy: -0.435, r: 0.04, class: "eye" }),
    svg("circle", { cx: 0, cy: 0.14, r: 0.07, class: "stop" }),
  ]);
}

/** A charging dock seen from above: base plate, charging tower at the back, a bolt. */
function dockIcon() {
  return svg("g", { class: "dock-icon" }, [
    svg("rect", { x: -0.42, y: -0.5, width: 0.84, height: 0.86, rx: 0.14, class: "plate" }),
    svg("rect", { x: -0.36, y: 0.3, width: 0.72, height: 0.2, rx: 0.08, class: "tower" }),
    svg("rect", { x: -0.2, y: 0.33, width: 0.4, height: 0.05, rx: 0.025, class: "contacts" }),
    svg("path", { d: "M0.03 -0.3 L-0.11 -0.04 L-0.01 -0.04 L-0.05 0.17 L0.11 -0.1 L0.01 -0.1 Z", class: "bolt" }),
  ]);
}

/** Map units per screen pixel for the map as currently zoomed (letterboxing included). */
function unitsPerPixel(root) {
  const rect = root.getBoundingClientRect();
  const [, , vw, vh] = root.getAttribute("viewBox").split(" ").map(Number);
  const scale = Math.min((rect.width || 600) / (vw || 1), (rect.height || 400) / (vh || 1));
  return 1 / scale;
}

const iconScale = (root, lengthM) => Math.max(lengthM, MIN_ICON_PX * unitsPerPixel(root));

/** Show or hide the toggleable layers without rebuilding the map. */
export function applyLayers(root, layers) {
  for (const group of root.querySelectorAll("[data-layer]")) {
    group.style.display = layers[group.dataset.layer] ? "" : "none";
  }
}

/**
 * Place, turn and size the mower and the dock. *heading* is a compass bearing in
 * degrees; *docked* turns the mower to face out of its dock instead. Without either the
 * mower faces up and is drawn faded, so it never points confidently the wrong way.
 * Call again after zooming: the icons keep a minimum size.
 */
export function placeRobot(rendered, robot) {
  if (!rendered) return;
  const { svg: root, projection, robotNode, dockNode, dockExit } = rendered;
  const hasPosition = robot && Number.isFinite(robot.lat) && Number.isFinite(robot.lon);
  const heading = hasPosition && robot.docked && dockExit !== null ? dockExit : hasPosition ? robot.heading : null;
  const hasHeading = Number.isFinite(heading);

  if (hasPosition) {
    const [x, y] = projection.point([robot.lon, robot.lat]);
    const scale = iconScale(root, MOWER_LENGTH_M);
    robotNode.setAttribute(
      "transform",
      `translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${hasHeading ? heading.toFixed(1) : 0}) scale(${scale.toFixed(3)})`,
    );
    robotNode.classList.toggle("no-heading", !hasHeading);
    robotNode.setAttribute("visibility", "visible");
  } else {
    robotNode.setAttribute("visibility", "hidden");
  }

  if (dockNode) {
    const dx = Number(dockNode.dataset.x);
    const dy = Number(dockNode.dataset.y);
    const scale = iconScale(root, DOCK_LENGTH_M);
    dockNode.setAttribute(
      "transform",
      `translate(${dx.toFixed(2)} ${dy.toFixed(2)}) rotate(${(dockExit ?? 0).toFixed(1)}) scale(${scale.toFixed(3)})`,
    );
  }
}

// Positions closer than this to the trail's last point are jitter (as in the backend).
const TRAIL_STEP_M = 0.15;

/** Extend the drawn trail with a live position, between snapshots. */
export function extendTrail(rendered, robot) {
  if (!rendered || !robot || !Number.isFinite(robot.lat) || !Number.isFinite(robot.lon)) return;
  const points = rendered.trailPoints;
  const point = [robot.lon, robot.lat];
  const last = points[points.length - 1];
  if (last && distance({ lon: last[0], lat: last[1] }, robot) < TRAIL_STEP_M) return;
  points.push(point);
  rendered.trailNode.setAttribute("d", rendered.projection.path(points, false));
}

/** Where the robot is, in map units, or null. */
export function robotPoint(rendered, robot) {
  if (!rendered || !robot || !Number.isFinite(robot.lat) || !Number.isFinite(robot.lon)) return null;
  return rendered.projection.point([robot.lon, robot.lat]);
}

/** Compass bearing, in degrees, of travel from one lon/lat point to another. */
export function bearing(from, to) {
  const projection = new Projection(from.lon, from.lat);
  const [x, y] = projection.point([to.lon, to.lat]);
  // SVG y grows southwards, so north is -y.
  return ((Math.atan2(x, -y) * 180) / Math.PI + 360) % 360;
}

/** Distance in metres between two lon/lat points. */
export function distance(from, to) {
  const projection = new Projection(from.lon, from.lat);
  const [x, y] = projection.point([to.lon, to.lat]);
  return Math.hypot(x, y);
}

const MIN_ZOOM = 1 / 1.5;
const MAX_ZOOM = 12;

/**
 * Pan and zoom for the map SVG, by changing its viewBox: drag to pan, wheel or pinch to
 * zoom around the pointer, double-click to zoom in. The view survives a re-render: hand
 * the previous `view` to the next instance.
 */
export class PanZoom {
  constructor(svgNode, view = null, onChange = null) {
    this.svg = svgNode;
    this.onChange = onChange;
    const [x, y, w, h] = svgNode.getAttribute("viewBox").split(" ").map(Number);
    this.base = { x, y, w, h };
    this.view = view ? { ...view } : { ...this.base };
    this.pointers = new Map();
    this.apply();
    this._bind();
  }

  get zoom() {
    return this.base.w / this.view.w;
  }

  apply() {
    const { x, y, w, h } = this.view;
    this.svg.setAttribute("viewBox", `${x.toFixed(3)} ${y.toFixed(3)} ${w.toFixed(3)} ${h.toFixed(3)}`);
    this.onChange?.();
  }

  reset() {
    this.view = { ...this.base };
    this.apply();
  }

  /** Zoom by *factor* around (cx, cy) in map units; the centre of the view by default. */
  zoomBy(factor, cx, cy) {
    const target = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor));
    const w = this.base.w / target;
    const h = this.base.h / target;
    const px = cx ?? this.view.x + this.view.w / 2;
    const py = cy ?? this.view.y + this.view.h / 2;
    const fx = (px - this.view.x) / this.view.w;
    const fy = (py - this.view.y) / this.view.h;
    this.view = { x: px - fx * w, y: py - fy * h, w, h };
    this.apply();
  }

  centerOn(x, y) {
    this.view = { ...this.view, x: x - this.view.w / 2, y: y - this.view.h / 2 };
    this.apply();
  }

  /** Map units under a client (screen) point. */
  _toMap(clientX, clientY) {
    const rect = this.svg.getBoundingClientRect();
    // preserveAspectRatio meet: the viewBox is letterboxed into the element.
    const scale = Math.min(rect.width / this.view.w, rect.height / this.view.h);
    const offX = (rect.width - this.view.w * scale) / 2;
    const offY = (rect.height - this.view.h * scale) / 2;
    return [this.view.x + (clientX - rect.left - offX) / scale, this.view.y + (clientY - rect.top - offY) / scale, scale];
  }

  _bind() {
    const svg = this.svg;
    svg.addEventListener(
      "wheel",
      (ev) => {
        ev.preventDefault();
        const [mx, my] = this._toMap(ev.clientX, ev.clientY);
        this.zoomBy(Math.pow(1.0018, -ev.deltaY), mx, my);
      },
      { passive: false },
    );
    svg.addEventListener("dblclick", (ev) => {
      const [mx, my] = this._toMap(ev.clientX, ev.clientY);
      this.zoomBy(2, mx, my);
    });
    svg.addEventListener("pointerdown", (ev) => {
      svg.setPointerCapture(ev.pointerId);
      this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      svg.classList.add("dragging");
    });
    const end = (ev) => {
      this.pointers.delete(ev.pointerId);
      this.pinch = null;
      if (!this.pointers.size) svg.classList.remove("dragging");
    };
    svg.addEventListener("pointerup", end);
    svg.addEventListener("pointercancel", end);
    svg.addEventListener("pointermove", (ev) => {
      const prev = this.pointers.get(ev.pointerId);
      if (!prev) return;
      const next = { x: ev.clientX, y: ev.clientY };
      if (this.pointers.size === 1) {
        const [, , scale] = this._toMap(ev.clientX, ev.clientY);
        this.view = { ...this.view, x: this.view.x - (next.x - prev.x) / scale, y: this.view.y - (next.y - prev.y) / scale };
        this.apply();
      } else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const other = a === prev ? b : a;
        const before = Math.hypot(prev.x - other.x, prev.y - other.y);
        const after = Math.hypot(next.x - other.x, next.y - other.y);
        if (before > 0) {
          const [mx, my] = this._toMap((next.x + other.x) / 2, (next.y + other.y) / 2);
          this.zoomBy(after / before, mx, my);
        }
      }
      this.pointers.set(ev.pointerId, next);
    });
  }
}
