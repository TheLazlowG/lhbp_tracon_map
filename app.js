/* global Cesium */

// A Cesium ion token is intentionally not bundled. Add a domain-restricted token here
// or inject one at build time to enable terrain. Imagery and traffic need no key.
const CESIUM_ION_TOKEN = "";
const HUNGARY_RECTANGLE = Cesium.Rectangle.fromDegrees(16.0, 45.6, 23.1, 48.8);
const TRAFFIC_CENTER = { lat: 47.16, lon: 19.5, radiusNm: 150 };
const POLL_MS = 4_000;
const MAX_HISTORY = 24;
const HISTORY_MIN_DISTANCE_M = 180;
const DEMO_AIRCRAFT = [
  { hex: "4A0001", flight: "WZZ312", lat: 47.34, lon: 19.05, alt: 7000, gs: 236, track: 74, t: "A320" },
  { hex: "4A0002", flight: "RYR8QF", lat: 47.55, lon: 19.76, alt: 13000, gs: 281, track: 237, t: "B738" },
  { hex: "4A0003", flight: "DLH5KM", lat: 46.98, lon: 18.47, alt: 24500, gs: 412, track: 62, t: "A21N" },
  { hex: "4A0004", flight: "AUA73P", lat: 48.11, lon: 20.22, alt: 18200, gs: 334, track: 251, t: "E195" },
  { hex: "4A0005", flight: "BAW82K", lat: 47.12, lon: 20.44, alt: 31600, gs: 442, track: 286, t: "A320" },
  { hex: "4A0006", flight: "THY4DP", lat: 46.68, lon: 19.35, alt: 28700, gs: 451, track: 21, t: "B739" },
  { hex: "4A0007", flight: "EZY41PW", lat: 47.73, lon: 18.16, alt: 10500, gs: 251, track: 118, t: "A320" },
  { hex: "4A0008", flight: "WZZ84GM", lat: 47.45, lon: 19.31, alt: 3200, gs: 168, track: 311, t: "A321" }
];
const demoStartedAt = Date.now();

const el = {
  blocks: document.querySelector("#datablocks"), status: document.querySelector("#feedStatus"), statusDot: document.querySelector("#statusDot"),
  count: document.querySelector("#trafficCount"), lastUpdate: document.querySelector("#lastUpdate"), search: document.querySelector("#searchInput"),
  results: document.querySelector("#searchResults"), labels: document.querySelector("#labelsToggle"), tracks: document.querySelector("#tracksToggle"),
  datablocks: document.querySelector("#datablocksToggle"), vertical: document.querySelector("#verticalExaggeration"), verticalValue: document.querySelector("#verticalValue"),
  tower: document.querySelector("#towerPanel"), details: document.querySelector("#detailsPanel"), selectedTitle: document.querySelector("#selectedTitle"), selectedDetails: document.querySelector("#selectedDetails")
};

const noLabels = new Cesium.UrlTemplateImageryProvider({
  url: "https://a.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}@2x.png",
  credit: new Cesium.Credit("© CARTO © OpenStreetMap contributors")
});
const labelTiles = new Cesium.UrlTemplateImageryProvider({
  url: "https://a.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}@2x.png",
  credit: new Cesium.Credit("© CARTO © OpenStreetMap contributors")
});
const viewerOptions = {
  baseLayer: new Cesium.ImageryLayer(noLabels), baseLayerPicker: false, animation: false, timeline: false,
  geocoder: false, homeButton: false, sceneModePicker: false, navigationHelpButton: false, fullscreenButton: false,
  selectionIndicator: false, infoBox: false, sceneMode: Cesium.SceneMode.SCENE2D, mapProjection: new Cesium.WebMercatorProjection(),
  shouldAnimate: true, creditContainer: document.createElement("div")
};
if (CESIUM_ION_TOKEN) {
  Cesium.Ion.defaultAccessToken = CESIUM_ION_TOKEN;
  viewerOptions.terrain = Cesium.Terrain.fromWorldTerrain();
}
const viewer = new Cesium.Viewer("cesiumContainer", viewerOptions);
const scene = viewer.scene;
scene.globe.baseColor = Cesium.Color.fromCssColorString("#0c151a");
scene.globe.depthTestAgainstTerrain = true;
scene.verticalExaggeration = 1;
scene.verticalExaggerationRelativeHeight = 0;
const labelsLayer = new Cesium.ImageryLayer(labelTiles, { show: false });
viewer.imageryLayers.add(labelsLayer);

const targets = new Cesium.PointPrimitiveCollection();
const historyDots = new Cesium.PointPrimitiveCollection();
const tracks = new Cesium.PolylineCollection();
scene.primitives.add(targets);
scene.primitives.add(historyDots);
scene.primitives.add(tracks);

const aircraft = new Map();
let callsigns = {};
let selectedId = null;
let activeMode = "2D";
let towerState = { heading: Cesium.Math.toRadians(215), pitch: Cesium.Math.toRadians(-10), fov: Cesium.Math.toRadians(58) };
const towerPosition = Cesium.Cartesian3.fromDegrees(19.2554, 47.4342, 150);

function setStatus(text, type = "loading") {
  el.status.textContent = text;
  el.statusDot.className = type === "live" ? "live" : type === "error" ? "error" : "";
}

function isInHungary(lat, lon) { return lat >= 45.65 && lat <= 48.65 && lon >= 16.0 && lon <= 22.95; }
function metersBetween(a, b) { return Cesium.Cartesian3.distance(a, b); }
function cartesian(lon, lat, height) { return Cesium.Cartesian3.fromDegrees(lon, lat, Math.max(0, height)); }
function feetToMeters(feet) { return (Number(feet) || 0) * 0.3048; }
function telemetryPosition(sample) { return cartesian(sample.lon, sample.lat, feetToMeters(sample.alt)); }

function telephonyFor(callsign) {
  const match = String(callsign || "").trim().toUpperCase().match(/^([A-Z]{3})(\d.*)$/);
  if (!match || !callsigns[match[1]]) return callsign || "UNK";
  const word = callsigns[match[1]].callsign;
  return word && word !== "(None)" ? `${word} ${match[2]}` : callsign;
}

async function loadCallsigns() {
  try {
    const response = await fetch("./data/callsigns.json", { cache: "no-store" });
    if (!response.ok) throw new Error("not installed");
    callsigns = await response.json();
  } catch {
    console.info("callsigns.json not installed; raw aircraft callsigns will be shown.");
  }
}

function createState(sample) {
  const point = targets.add({ position: telemetryPosition(sample), pixelSize: 7, color: Cesium.Color.fromCssColorString("#65ffae"), outlineColor: Cesium.Color.BLACK, outlineWidth: 1, id: sample.id });
  const line = tracks.add({ positions: [], width: 1.5, material: Cesium.Material.fromType("Color", { color: Cesium.Color.fromCssColorString("#4ccb88").withAlpha(.6) }), show: el.tracks.checked });
  const block = document.createElement("button");
  block.className = "datablock";
  block.type = "button";
  block.hidden = true;
  block.addEventListener("click", event => { event.stopPropagation(); selectAircraft(sample.id); });
  installDatablockDrag(block, sample.id);
  el.blocks.append(block);
  return { ...sample, point, line, block, history: [], historyPrimitives: [], samples: [sample], render: sample, offset: { x: 13, y: -16 }, lastSeen: Date.now() };
}

function addHistoryPoint(state, p) {
  const pos = telemetryPosition(p);
  const last = state.history[state.history.length - 1];
  if (last && metersBetween(pos, telemetryPosition(last)) < HISTORY_MIN_DISTANCE_M) return;
  state.history.push(p);
  const primitive = historyDots.add({ position: pos, pixelSize: 3, color: Cesium.Color.fromCssColorString("#54d98e").withAlpha(.7), id: state.id });
  state.historyPrimitives.push(primitive);
  if (state.history.length > MAX_HISTORY) {
    state.history.shift();
    historyDots.remove(state.historyPrimitives.shift());
  }
}

function updateState(state, sample) {
  const previous = state.samples[state.samples.length - 1];
  state.callsign = sample.callsign; state.alt = sample.alt; state.speed = sample.speed; state.heading = sample.heading; state.type = sample.type; state.source = sample.source; state.lastSeen = Date.now();
  if (!previous || previous.lat !== sample.lat || previous.lon !== sample.lon) {
    state.samples.push(sample);
    if (state.samples.length > 3) state.samples.shift();
    addHistoryPoint(state, sample);
  }
}

function processTraffic(json) {
  if (!Array.isArray(json.ac)) throw new Error("No aircraft array returned");
  const active = new Set();
  for (const ac of json.ac) {
    if (!Number.isFinite(ac.lat) || !Number.isFinite(ac.lon) || !isInHungary(ac.lat, ac.lon) || ac.alt_baro === "ground") continue;
    const id = String(ac.hex || ac.icao || "").trim(); if (!id) continue;
    const sample = { id, callsign: String(ac.flight || "UNK").trim() || "UNK", lat: ac.lat, lon: ac.lon, alt: typeof ac.alt_baro === "number" ? ac.alt_baro : 0, speed: Math.round(ac.gs || 0), heading: Number(ac.track ?? ac.true_heading ?? ac.mag_heading ?? 0), type: String(ac.t || "UNK").toUpperCase(), source: ac.type === "mlat" ? "MLAT" : "ADS-B", time: Date.now() };
    active.add(id);
    const state = aircraft.get(id);
    if (state) updateState(state, sample); else { const next = createState(sample); addHistoryPoint(next, sample); aircraft.set(id, next); }
  }
  for (const [id, state] of aircraft) if (!active.has(id) && Date.now() - state.lastSeen > 30_000) removeState(id, state);
  el.count.textContent = String(aircraft.size); el.lastUpdate.textContent = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  setStatus(`${aircraft.size} targets live`, "live");
  updateSearchResults(el.search.value);
}

function removeState(id, state) { targets.remove(state.point); tracks.remove(state.line); state.historyPrimitives.forEach(p => historyDots.remove(p)); state.block.remove(); aircraft.delete(id); if (selectedId === id) closeDetails(); }

async function pollTraffic() {
  const url = `https://api.airplanes.live/v2/point/${TRAFFIC_CENTER.lat}/${TRAFFIC_CENTER.lon}/${TRAFFIC_CENTER.radiusNm}`;
  try { const response = await fetch(url, { cache: "no-store" }); if (!response.ok) throw new Error(`HTTP ${response.status}`); processTraffic(await response.json()); }
  catch (error) { console.warn("Traffic feed error; using local demo targets", error); processTraffic(demoTraffic()); setStatus(`${aircraft.size} demo targets (live feed unavailable)`, "loading"); }
}

function demoTraffic() {
  const elapsedHours = (Date.now() - demoStartedAt) / 3_600_000;
  return { ac: DEMO_AIRCRAFT.map((plane, index) => {
    const travelledNm = plane.gs * elapsedHours;
    const bearing = Cesium.Math.toRadians(plane.track);
    const lat = plane.lat + (travelledNm * Math.cos(bearing)) / 60;
    const lon = plane.lon + (travelledNm * Math.sin(bearing)) / (60 * Math.cos(Cesium.Math.toRadians(plane.lat)));
    return { ...plane, lat, lon, alt_baro: plane.alt, type: index === 6 ? "mlat" : "adsb" };
  }) };
}

function interpolate(state, now) {
  const s = state.samples; if (s.length < 2) return s[0];
  const a = s[s.length - 2], b = s[s.length - 1];
  const elapsed = Math.min(1, Math.max(0, (now - b.time + POLL_MS) / POLL_MS));
  return { ...b, lat: a.lat + (b.lat - a.lat) * elapsed, lon: a.lon + (b.lon - a.lon) * elapsed, alt: a.alt + (b.alt - a.alt) * elapsed };
}

function drawTargets() {
  const now = Date.now();
  for (const state of aircraft.values()) {
    state.render = interpolate(state, now);
    state.point.position = telemetryPosition(state.render);
    state.point.color = state.id === selectedId ? Cesium.Color.YELLOW : Cesium.Color.fromCssColorString("#65ffae");
    state.point.pixelSize = state.id === selectedId ? 10 : 7;
    state.line.positions = state.history.map(telemetryPosition);
    state.line.show = el.tracks.checked;
  }
}

function updateDatablocks() {
  if (!el.datablocks.checked) { for (const state of aircraft.values()) state.block.hidden = true; return; }
  for (const state of aircraft.values()) {
    const screen = scene.cartesianToCanvasCoordinates(state.point.position);
    if (!screen || scene.mode === Cesium.SceneMode.MORPHING) { state.block.hidden = true; continue; }
    state.block.hidden = false;
    state.block.classList.toggle("selected", state.id === selectedId);
    state.block.style.transform = `translate(${Math.round(screen.x + state.offset.x)}px, ${Math.round(screen.y + state.offset.y)}px)`;
    state.block.innerHTML = `<strong>${telephonyFor(state.callsign)}</strong><br><span class="sub">${state.type} · FL${String(Math.max(0, Math.round(state.render.alt / 100))).padStart(3, "0")} · ${state.speed}KT</span>`;
  }
}

function selectAircraft(id) {
  if (!aircraft.has(id)) return;
  selectedId = id;
  const state = aircraft.get(id);
  el.details.hidden = false; el.selectedTitle.textContent = state.callsign;
  const operator = callsigns[String(state.callsign).slice(0, 3).toUpperCase()];
  el.selectedDetails.innerHTML = `<dt>Telephony</dt><dd>${telephonyFor(state.callsign)}</dd><dt>Type</dt><dd>${state.type}</dd><dt>Altitude</dt><dd>${Math.round(state.alt).toLocaleString()} ft</dd><dt>Speed</dt><dd>${state.speed} kt</dd><dt>Source</dt><dd>${state.source}</dd>${operator ? `<dt>Operator</dt><dd>${operator.company || "—"}</dd>` : ""}`;
  updateDatablocks();
}
function closeDetails() { selectedId = null; el.details.hidden = true; updateDatablocks(); }

function installDatablockDrag(block, id) {
  let origin;
  block.addEventListener("pointerdown", event => { const state = aircraft.get(id); if (!state) return; origin = { x: event.clientX, y: event.clientY, ox: state.offset.x, oy: state.offset.y }; block.setPointerCapture(event.pointerId); block.classList.add("dragging"); event.stopPropagation(); });
  block.addEventListener("pointermove", event => { if (!origin) return; const state = aircraft.get(id); state.offset.x = origin.ox + event.clientX - origin.x; state.offset.y = origin.oy + event.clientY - origin.y; updateDatablocks(); });
  const finish = () => { origin = null; block.classList.remove("dragging"); };
  block.addEventListener("pointerup", finish); block.addEventListener("pointercancel", finish);
}

function updateSearchResults(query) {
  const term = query.trim().toUpperCase(); el.results.replaceChildren(); if (!term) return;
  const matches = [...aircraft.values()].filter(a => a.callsign.includes(term) || a.id.toUpperCase().includes(term) || telephonyFor(a.callsign).includes(term)).slice(0, 12);
  matches.forEach(state => { const button = document.createElement("button"); button.className = "search-item"; button.textContent = `${state.callsign} · ${telephonyFor(state.callsign)}`; button.onclick = () => { selectAircraft(state.id); viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(state.render.lon, state.render.lat, 45_000), duration: .7 }); }; el.results.append(button); });
}

function captureFocus() {
  const center = new Cesium.Cartesian2(scene.canvas.clientWidth / 2, scene.canvas.clientHeight / 2);
  const ray = viewer.camera.getPickRay(center);
  const point = ray && scene.globe.pick(ray, scene);
  const cartographic = point && Cesium.Cartographic.fromCartesian(point);
  return cartographic ? { longitude: cartographic.longitude, latitude: cartographic.latitude, height: Math.max(15_000, viewer.camera.getMagnitude()) } : null;
}
function restoreFocus(focus) {
  if (!focus) return;
  viewer.camera.setView({ destination: Cesium.Cartesian3.fromRadians(focus.longitude, focus.latitude, focus.height) });
}

function setMode(mode) {
  const focus = activeMode === "tower" ? null : captureFocus();
  activeMode = mode; document.querySelectorAll(".mode-button").forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
  el.tower.hidden = mode !== "tower";
  const controller = scene.screenSpaceCameraController;
  if (mode === "2D") { viewer.scene.morphTo2D(.55); controller.enableRotate = true; controller.enableTilt = true; controller.enableTranslate = true; controller.enableZoom = true; setTimeout(() => restoreFocus(focus), 600); }
  else if (mode === "3D") { viewer.scene.morphTo3D(.55); controller.enableRotate = true; controller.enableTilt = true; controller.enableTranslate = true; controller.enableZoom = true; setTimeout(() => restoreFocus(focus), 600); }
  else { viewer.scene.morphTo3D(.35); setTimeout(setTowerView, 400); controller.enableRotate = false; controller.enableTilt = false; controller.enableTranslate = false; controller.enableZoom = false; }
}
function setTowerView() { viewer.camera.setView({ destination: towerPosition, orientation: { heading: towerState.heading, pitch: towerState.pitch, roll: 0 } }); if (viewer.camera.frustum.fov !== undefined) viewer.camera.frustum.fov = towerState.fov; }
function ptz(action) { if (action === "left") towerState.heading -= Cesium.Math.toRadians(4); if (action === "right") towerState.heading += Cesium.Math.toRadians(4); if (action === "up") towerState.pitch = Math.min(Cesium.Math.toRadians(-2), towerState.pitch + Cesium.Math.toRadians(3)); if (action === "down") towerState.pitch = Math.max(Cesium.Math.toRadians(-80), towerState.pitch - Cesium.Math.toRadians(3)); if (action === "zoom-in") towerState.fov = Math.max(Cesium.Math.toRadians(8), towerState.fov * .8); if (action === "zoom-out") towerState.fov = Math.min(Cesium.Math.toRadians(85), towerState.fov * 1.2); if (action === "home") towerState = { heading: Cesium.Math.toRadians(215), pitch: Cesium.Math.toRadians(-10), fov: Cesium.Math.toRadians(58) }; setTowerView(); }

scene.postRender.addEventListener(() => { drawTargets(); updateDatablocks(); });
scene.screenSpaceCameraController.minimumZoomDistance = 150;
new Cesium.ScreenSpaceEventHandler(scene.canvas).setInputAction(event => { const picked = scene.pick(event.position); if (picked?.primitive?.id && aircraft.has(picked.primitive.id)) selectAircraft(picked.primitive.id); else if (!event.position) closeDetails(); }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

document.querySelectorAll(".mode-button").forEach(button => button.addEventListener("click", () => setMode(button.dataset.mode)));
document.querySelectorAll("[data-ptz]").forEach(button => button.addEventListener("click", () => ptz(button.dataset.ptz)));
document.querySelector("#closeDetails").addEventListener("click", closeDetails);
el.labels.addEventListener("change", () => { labelsLayer.show = el.labels.checked; });
el.tracks.addEventListener("change", () => { for (const state of aircraft.values()) state.line.show = el.tracks.checked; });
el.datablocks.addEventListener("change", updateDatablocks);
el.vertical.addEventListener("input", () => { const value = Number(el.vertical.value); scene.verticalExaggeration = value; el.verticalValue.textContent = `${value}×`; });
el.search.addEventListener("input", () => updateSearchResults(el.search.value));

await loadCallsigns();
viewer.camera.setView({ destination: HUNGARY_RECTANGLE });
setStatus("connecting…");
pollTraffic();
setInterval(pollTraffic, POLL_MS);
