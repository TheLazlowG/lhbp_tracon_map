import { L } from './leaflet.js';
import { EDITOR_MODE } from './config.js';
import { getOffsetPoint } from './geo.js';

// Map initialization, panes, basemap, runway geometry, and shared layer groups.

// 1. Initialize map centered on Budapest Airport (LHBP)
const INITIAL_VIEW_CENTER = [47.4369, 19.2556];
// View presets, by zoom level: APP (approach/TMA-scale overview) <
// TWR (tower/airport-scale) < GND (ground/apron-scale, closest zoom).
const APP_VIEW_ZOOM = 10;
const TWR_VIEW_ZOOM = 13;
const GND_VIEW_ZOOM = 15;
const INITIAL_VIEW_ZOOM = APP_VIEW_ZOOM;
const map = L.map('radar-scope', {
    zoomControl: false,
    attributionControl: true,
    zoomSnap: 1,
    zoomDelta: 1,
    wheelPxPerZoomLevel: 360,
    // Canvas rendering is dramatically cheaper than the SVG default
    // once you have thousands of polygon vertices on screen at once
    // (ground features + airspaces + taxiway lines add up to ~12,000
    // points combined). SVG creates one DOM node per shape and has to
    // recompute/repaint every path node on each zoom animation frame,
    // which is what caused the rendering glitches at certain zoom
    // levels. Canvas draws everything into one bitmap per frame
    // instead, and Leaflet still supports tooltips/hover/click on
    // canvas-rendered shapes (used by the airspace tooltips), so no
    // interactivity is lost.
    preferCanvas: true
}).setView(INITIAL_VIEW_CENTER, INITIAL_VIEW_ZOOM);

// Keep the desktop radar chrome minimal, but expose large, familiar
// zoom buttons on phone-sized screens via the responsive stylesheet.
const mobileZoomControl = L.control.zoom({ position: 'bottomleft' }).addTo(map);
mobileZoomControl.getContainer().classList.add('mobile-zoom-control');

// Leaflet caches the map container dimensions. Mobile orientation and
// browser-chrome changes update 100dvh without necessarily producing a
// Leaflet resize, leaving the projection centered on the old portrait
// height. Observe the actual scope and resynchronize on the next frame.
let mapResizeFrame = 0;
const mapSizeObserver = new ResizeObserver(() => {
    cancelAnimationFrame(mapResizeFrame);
    mapResizeFrame = requestAnimationFrame(() => {
        map.invalidateSize({ animate: false, pan: true, debounceMoveend: true });
    });
});
mapSizeObserver.observe(document.getElementById('radar-scope'));

// Dedicated panes so ground-feature fills (aprons/taxiways/runway fills),
// taxiway centerlines, and the bright runway centerlines stack in a
// fixed, predictable order regardless of the order layers are added or
// re-added (e.g. toggling the "GROUND FEATURES" checkbox off/on):
//   basemap (200) < apronsPane (340) < taxiwaysFillPane (345) < runwayFillPane (350)
//   < taxiwayLinesPane (380) < runwayLinesPane (390) < static airspaces (394/395)
//   < LARA/FUA airspaces (396/397) < overlayPane (400, default: waypoints,
//   SID/STAR, etc.) < ... < markerPane (600, default) <
//   tooltipPane (650, default) < aircraftPane (700, traffic: position dots,
//   speed vectors, leader lines, data blocks, history trail dots) <
//   datablockPane (710) < airspaceInfoTooltipPane (720, AIRSPACE INFO's
//   combined hover tooltip -- always on top of every other layer,
//   including aircraft, regardless of add order).
map.createPane('apronsPane');
map.getPane('apronsPane').style.zIndex = 340;
map.createPane('taxiwaysFillPane');
map.getPane('taxiwaysFillPane').style.zIndex = 345;
map.createPane('runwayFillPane');
map.getPane('runwayFillPane').style.zIndex = 350;
map.createPane('taxiwayLinesPane');
map.getPane('taxiwayLinesPane').style.zIndex = 380;
map.createPane('runwayLinesPane');
map.getPane('runwayLinesPane').style.zIndex = 390;
// Airspaces must render below SID/STAR procedures, while genuine
// LARA/FUA records must always sit above static airspaces regardless
// of fetch, refresh, filter-toggle, or LayerGroup insertion order.
// SID/STAR remain on Leaflet's default overlayPane (z-index 400).
map.createPane('airspacePane');
map.getPane('airspacePane').style.zIndex = 394;

// Keep each label directly above its own class of polygon. This also
// ensures a LARA/FUA polygon and label both outrank static content.
map.createPane('airspaceLabelPane');
map.getPane('airspaceLabelPane').style.zIndex = 395;
map.createPane('laraFuaAirspacePane');
map.getPane('laraFuaAirspacePane').style.zIndex = 396;
map.createPane('laraFuaAirspaceLabelPane');
map.getPane('laraFuaAirspaceLabelPane').style.zIndex = 397;


map.createPane('aircraftPane');
map.getPane('aircraftPane').style.zIndex = 700;
// aircraftPane's Canvas renderer draws a full-viewport <canvas>
// even where nothing is drawn, and that canvas was the topmost
// element under the cursor everywhere on the map (aircraftPane
// sits above every airspace pane, whose highest z-index is 397),
// silently swallowing all mouse events -- including airspace
// hover -- map-wide, even far from any aircraft. The
// .leaflet-aircraft-pane canvas rule in the stylesheet sets
// pointer-events:none so events fall through to panes below;
// aircraft interaction still works because it goes through real
// DOM aircraft marker elements
// which set pointer-events:auto on themselves individually.

// Leaflet's Canvas renderer (used because the map runs with
// preferCanvas: true) draws every non-explicitly-rendered vector
// layer -- circleMarkers, polylines -- into one shared <canvas>
// per pane. That canvas listens for clicks across its own
// full-viewport bounding box and does its own internal hit-test,
// so it intercepts clicks meant for a Tooltip DOM element sharing
// the same pane even when the tooltip is later in DOM order.
// Datablocks get their own pane above aircraftPane so their
// clicks reach the tooltip instead of being swallowed by the
// traffic canvas (speed lines and history dots).
map.createPane('datablockPane');
map.getPane('datablockPane').style.zIndex = 710;

// AIRSPACE INFO's combined hover tooltip (see AirspaceManager's
// hover engine) needs to sit above aircraft and datablocks -- a
// tooltip explaining what's under the cursor is only useful if
// it isn't itself hidden behind the traffic it's next to.
// Leaflet's default tooltipPane (650) sits below aircraftPane
// (700) and datablockPane (710), so this gets its own pane above
// both instead of using the default.
map.createPane('airspaceInfoTooltipPane');
map.getPane('airspaceInfoTooltipPane').style.zIndex = 720;

// Editor-mode label pane, created here (before any markers try to
// use it) rather than inside initLabelEditor(), since that isn't
// called until after every waypoint's editable label marker has
// already tried to add itself to this pane.
if (EDITOR_MODE) {
    map.createPane('editorLabelsPane');
    map.getPane('editorLabelsPane').style.zIndex = 5000;
}

// Define CARTO raster basemap variants (with labels and without labels).
// CARTO basemap keys are intentionally browser-visible identifiers used
// in each client-side tile request, rather than server-side secrets.
const CARTO_BASEMAP_KEY = 'cb1_2qfg_1_ef21cddc70e867a689fe0ca1';
const cartoAttribution = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';
const cartoTileOptions = {
    attribution: cartoAttribution,
    subdomains: 'abcd',
    maxZoom: 20
};
const darkAllWithLabels = L.tileLayer(`https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=${CARTO_BASEMAP_KEY}`, cartoTileOptions);
const darkAllNoLabels   = L.tileLayer(`https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png?key=${CARTO_BASEMAP_KEY}`, cartoTileOptions);

const basemapEnabledInput = document.getElementById('basemap-enabled');
const mapLabelsInput = document.getElementById('map-labels');

function syncBasemap() {
    map.removeLayer(darkAllWithLabels);
    map.removeLayer(darkAllNoLabels);

    if (basemapEnabledInput.checked) {
        map.addLayer(mapLabelsInput.checked ? darkAllWithLabels : darkAllNoLabels);
    }
}

// Default to the label-free basemap. With the basemap disabled, Leaflet's
// transparent map panes reveal the solid black radar-scope background.
syncBasemap();
basemapEnabledInput.addEventListener('change', syncBasemap);
mapLabelsInput.addEventListener('change', syncBasemap);

// 2. Exact coordinates for LHBP Runway Thresholds 
const rwy13R = [47.4487, 19.2208]; 
const rwy31L = [47.4305, 19.2502]; 
const rwy13L = [47.4454, 19.2575]; 
const rwy31R = [47.4230, 19.2939]; 

// 3. Complete Master Waypoints
// The full waypoint database (published AIP fixes, VFR reporting points,
// and internal SID/STAR/procedure turn points like BPxxx and runway
// thresholds) lives entirely in data/waypoints.json, fetched and loaded
// into `waypoints` at boot by initWaypointsAndProcedures().

// Monochromatic Layer Configurations
const runwayStyle = { color: '#ffffff', weight: 4, opacity: 0.9 };
// interactive:false on these -- decorative only (no click/hover/
// tooltip ever bound). Left interactive by default they sit in
// Leaflet's default overlayPane, whose full-viewport canvas then
// blocks airspace hover map-wide, same as aircraftPane did (see
// CSS/pane comments near aircraftPane's creation).
const extensionStyle = { color: '#ffffff', weight: 1.5, opacity: 0.6, interactive: false };
const tickLineStyle = { color: '#ffffff', weight: 1.5, opacity: 0.6, interactive: false };
const majorTickLineStyle = { color: '#ffffff', weight: 1.5, opacity: 0.6, interactive: false };

const taxiwayStyle = { stroke: false, fillColor: '#2B2B2B', fillOpacity: 1, pane: 'taxiwaysFillPane' };
const apronStyle = { stroke: false, fillColor: '#242424', fillOpacity: 1, pane: 'apronsPane' };
const runwayFillStyle = { stroke: false, fillColor: '#3A3A3A', fillOpacity: 1, pane: 'runwayFillPane' };
const taxiwayLineStyle = { color: '#ffffff', weight: 1.5, opacity: 0.55, pane: 'taxiwayLinesPane' };

// Permanent Element Layer: Main Physical Runways
L.polyline([rwy13R, rwy31L], {...runwayStyle, pane: 'runwayLinesPane'}).addTo(map);
L.polyline([rwy13L, rwy31R], {...runwayStyle, pane: 'runwayLinesPane'}).addTo(map);

// Define Toggleable Leaflet Layer Groups
const trafficGroup = L.layerGroup().addTo(map);
const waypointsGroup = L.layerGroup().addTo(map);
const extensions13Group = L.layerGroup().addTo(map);
const extensions31Group = L.layerGroup().addTo(map);
const holdingGroup = L.layerGroup(); 

const taxiwaysGroup = L.layerGroup();
const apronsGroup = L.layerGroup();
const runwaysGroup = L.layerGroup();
const taxiwayLinesGroup = L.layerGroup();
const taxiwayLabelsGroup = L.layerGroup();
const standsGroup = L.layerGroup();

// Master group: bundles all ground-feature sublayers (runway/taxiway/apron
// fills, taxiway centerlines, taxiway labels) behind a single toggle.
const groundFeaturesGroup = L.layerGroup([
    runwaysGroup, taxiwaysGroup, apronsGroup, taxiwayLinesGroup
]).addTo(map);

const sid31Group = L.layerGroup();
const sid13Group = L.layerGroup(); 
const star31Group = L.layerGroup();
const star13Group = L.layerGroup();

// 5. Generate Solid Centerlines and Directional Outward Range Ticks
// Each runway threshold gets an extended centerline running outward
// (into the approach path) to 15 NM. The first mile nearest the
// runway is intentionally not drawn (extension only becomes visible
// starting 1 NM out), and 1 NM tick marks are added out to 10 NM,
// with a bigger tick every 5th mile (5 NM, 10 NM), plus a final
// major tick right at the 15 NM endpoint.
function buildApproachRadar(threshold, heading, name) {
    const EXTENSION_LENGTH_NM = 15;
    const EXTENSION_START_NM = 1;   // last mile near the runway is hidden
    const TICK_MAX_NM = 10;
    const MINOR_TICK_LEN_NM = 0.3;
    const MAJOR_TICK_LEN_NM = 0.6;

    const targetGroup = (name === "13L" || name === "13R") ? extensions13Group : extensions31Group;

    const startPoint = getOffsetPoint(threshold, EXTENSION_START_NM, heading);
    const endPoint = getOffsetPoint(threshold, EXTENSION_LENGTH_NM, heading);
    L.polyline([startPoint, endPoint], extensionStyle).addTo(targetGroup);

    let tickHeading;
    if (name === "13R") {
        tickHeading = (heading - 90 + 360) % 360; 
    } else if (name === "31L") {
        tickHeading = (heading + 90) % 360;        
    } else if (name === "13L") {
        tickHeading = (heading + 90) % 360;        
    } else if (name === "31R") {
        tickHeading = (heading - 90 + 360) % 360; 
    }

    for (let miles = 1; miles <= TICK_MAX_NM; miles++) {
        const isMajor = miles % 5 === 0;
        const tickCoord = getOffsetPoint(threshold, miles, heading);
        const tickLen = isMajor ? MAJOR_TICK_LEN_NM : MINOR_TICK_LEN_NM;
        const tickEnd = getOffsetPoint(tickCoord, tickLen, tickHeading);
        L.polyline([tickCoord, tickEnd], isMajor ? majorTickLineStyle : tickLineStyle).addTo(targetGroup);
    }

    // Final tick at the very end of the extension (15 NM).
    const endTickEnd = getOffsetPoint(endPoint, MAJOR_TICK_LEN_NM, tickHeading);
    L.polyline([endPoint, endTickEnd], majorTickLineStyle).addTo(targetGroup);
}

export { APP_VIEW_ZOOM, GND_VIEW_ZOOM, INITIAL_VIEW_CENTER, TWR_VIEW_ZOOM, apronStyle, apronsGroup, buildApproachRadar, extensions13Group, extensions31Group, groundFeaturesGroup, holdingGroup, map, runwayFillStyle, runwaysGroup, rwy13L, rwy13R, rwy31L, rwy31R, sid13Group, sid31Group, standsGroup, star13Group, star31Group, taxiwayLabelsGroup, taxiwayLineStyle, taxiwayLinesGroup, taxiwayStyle, taxiwaysGroup, trafficGroup, waypointsGroup };
