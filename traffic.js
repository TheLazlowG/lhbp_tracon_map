import { L } from './leaflet.js';
import { map, trafficGroup } from './map.js';
import { consumeDatablockDrag, createAircraftDatablock, createDatablockLeaderLine, datablockLeaderLines, markLeaderCanvasDirty, removeDatablockLeaderLine } from './traffic-renderer.js';
import { getAirlineOperator, getRegistrationCountry, openAircraftInfoPanel } from './aircraft-info.js';

// Traffic feed, aircraft state, filtering, and track selection.

// ==========================================
// 8. Air Traffic System (Live API Feeds Only)
// ==========================================
let aircraftState = {};
const SWEEP_INTERVAL_MS = 2000;
const RENDER_DELAY_MS = 2000;
const HISTORY_LENGTH = 30;
// Set to 2 to only display every OTHER history dot (skips every 2nd
// one), 3 for every 3rd, etc. 1 shows all of them. This only thins
// out which dots are drawn -- the underlying position history and
// HISTORY_LENGTH trail length are unaffected.
const HISTORY_DOT_DISPLAY_SKIP = 2;
// History dots fade from HISTORY_DOT_MAX_OPACITY (newest) down to
// HISTORY_DOT_MIN_OPACITY (oldest) across the visible trail.
const HISTORY_DOT_MAX_OPACITY = 1;
const HISTORY_DOT_MIN_OPACITY = 0.15;
const POSITION_UPDATE_THRESHOLD_PX = 0.5;
const PREDICTION_UPDATE_INTERVAL_MS = 100; // 10Hz is ample for vectors
let PREDICT_MINUTES = 0.25;
const RADAR_CENTER = [47.4369, 19.2556];
const RADAR_RADIUS_NM = 150;
const RADAR_BBOX = { minLat: 46.5, minLon: 18.0, maxLat: 48.5, maxLon: 20.5 };

let trafficSource = 'connecting';

const trafficStatusEl = document.createElement('div');
trafficStatusEl.className = 'radar-ui-section';
trafficStatusEl.id = 'traffic-source-status';
trafficStatusEl.textContent = 'Traffic: connecting...';
document.querySelector('.radar-ui-panel[data-panel-view="aircraft"]').appendChild(trafficStatusEl);

// One 18px DOM marker serves as both the click target and the visual
// target; its ::before pseudo-element draws the smaller radar symbol.
const targetDivIcon = L.divIcon({ className: 'atc-target-icon', iconSize: [18, 18] });

function setTrafficSource(source, statusText, siteDomain) {
    trafficSource = source;
    if (source === 'live') {
        trafficStatusEl.textContent = `Feed: ${siteDomain} (${statusText})`;
        trafficStatusEl.style.color = '#5DEB3D';
    } else if (source === 'failed') {
        trafficStatusEl.textContent = `Feed: Offline / Error`;
        trafficStatusEl.style.color = '#FF3B30';
    } else {
        trafficStatusEl.textContent = `Feed: ${statusText}`;
        trafficStatusEl.style.color = '#FFCC00';
    }
}

function inRadarBox(lat, lon) {
    return lat >= RADAR_BBOX.minLat && lat <= RADAR_BBOX.maxLat &&
           lon >= RADAR_BBOX.minLon && lon <= RADAR_BBOX.maxLon;
}

// ==========================================
// 8b. Track History Selection
// ==========================================
// selectedAircraftIds holds every currently-selected aircraft. In
// single-select mode (default) it will only ever contain 0 or 1 ids.
// When "MULTI-SELECT TRACKS" is enabled, clicking additional
// aircraft adds them to the set instead of replacing the selection,
// so multiple track history lines can be shown at once.
const selectedAircraftIds = new Set();
const trackHistoryLines = new Map(); // id -> L.polyline

function isMultiSelectEnabled() {
    const el = document.getElementById('multi-select-tracks');
    return el ? el.checked : false;
}

function getOrCreateTrackLine(id) {
    let line = trackHistoryLines.get(id);
    if (!line) {
        line = L.polyline([], {
            color: '#5DEB3D',
            weight: 1.5,
            opacity: 0.85,
            interactive: false,
            lineJoin: 'round',
            pane: 'aircraftPane'
        });
        trackHistoryLines.set(id, line);
    }
    return line;
}

function updateTrackHistoryLine(id) {
    const state = aircraftState[id];
    const line = trackHistoryLines.get(id);
    if (!state || !line) return;

    const currentPos = state.ui.marker.getLatLng();
    const points = [
        ...state.trackHistory,
        ...(currentPos ? [[currentPos.lat, currentPos.lng]] : [])
    ];

    line.setLatLngs(points);
    if (!map.hasLayer(line)) line.addTo(map);
}

function updateAllTrackHistoryLines() {
    selectedAircraftIds.forEach(id => updateTrackHistoryLine(id));
}

function deselectAircraft(id) {
    if (!selectedAircraftIds.has(id)) return;
    selectedAircraftIds.delete(id);

    if (aircraftState[id]) {
        const icon = aircraftState[id].ui.marker.getElement();
        if (icon) icon.classList.remove('selected');
    }

    const line = trackHistoryLines.get(id);
    if (line) {
        if (map.hasLayer(line)) map.removeLayer(line);
        trackHistoryLines.delete(id);
    }
}

function deselectAllAircraft() {
    Array.from(selectedAircraftIds).forEach(deselectAircraft);
}

function selectAircraft(id) {
    const multi = isMultiSelectEnabled();

    if (selectedAircraftIds.has(id)) {
        // Clicking an already-selected aircraft toggles it off
        deselectAircraft(id);
        return;
    }

    if (!multi) {
        // Single-select mode: clear any existing selection first
        deselectAllAircraft();
    }

    selectedAircraftIds.add(id);
    getOrCreateTrackLine(id);

    if (aircraftState[id]) {
        const icon = aircraftState[id].ui.marker.getElement();
        if (icon) icon.classList.add('selected');
    }

    updateTrackHistoryLine(id);
}

// Turning multi-select off collapses the selection down to at most
// one aircraft (the most recently selected), same as single-select.
document.getElementById('multi-select-tracks').addEventListener('change', function(e) {
    if (!e.target.checked && selectedAircraftIds.size > 1) {
        const keepId = Array.from(selectedAircraftIds).pop();
        Array.from(selectedAircraftIds).forEach(id => {
            if (id !== keepId) deselectAircraft(id);
        });
    }
});

map.on('click', function() {
    deselectAllAircraft();
});

// Recomputes fillOpacity for every history dot of an aircraft, fading
// from HISTORY_DOT_MAX_OPACITY (newest visible dot) down to
// HISTORY_DOT_MIN_OPACITY (oldest dot still in the trail). Dots that
// are skipped by HISTORY_DOT_DISPLAY_SKIP (not currently on the map)
// still get their opacity updated so they're correct if re-shown.
function updateHistoryDotFade(state) {
    const dots = state.historyDots;
    // Index 0 is oldest, length-1 is the always-hidden "latest" dot,
    // so the oldest VISIBLE dot is index 0 and the newest visible is
    // length-2 (see the reveal logic above).
    const visibleCount = dots.length - 1;
    if (visibleCount <= 0) return;

    for (let i = 0; i < dots.length; i++) {
        // ageRank: 0 = newest visible dot, increasing with age.
        const ageRank = (dots.length - 1) - i - 1;
        if (ageRank < 0) continue; // the hidden "latest" dot itself

        const t = visibleCount > 1 ? ageRank / (visibleCount - 1) : 0;
        const opacity = HISTORY_DOT_MAX_OPACITY - t * (HISTORY_DOT_MAX_OPACITY - HISTORY_DOT_MIN_OPACITY);
        dots[i].setStyle({ fillOpacity: opacity });
    }
}

function initAircraftState(id, callsign, srcType) {
    aircraftState[id] = {
        id: id,
        callsign: callsign,
        actype: "UNK",
        wake: "",
        registration: "",
        country: "",
        operator: "",
        operatorCallsign: "",
        metadataOperator: "",
        registeredOwner: "",
        metadataRegisteredOwner: "",
        typeName: "",


        squawk: "",
        selectedAltitude: null,
        latestAlt: 0,
        latestSpeed: 0,
        latestHeading: 0,
        onGround: false,
        srcType: srcType || "OTHER",
        isFilteredVisible: false,
        markerVisible: false,
        speedLineVisible: true,
        lastAircraftPoint: null,
        lastDatablockPoint: null,
        lastPredictionUpdateTime: 0,
        telemetry: [],
        historyDots: [],
        historyDotRevealCount: 0,
        trackHistory: [],
        // User-repositioned datablock offset, in screen pixels
        // from the aircraft's current projected position. null
        // until the user drags the datablock for the first time,
        // at which point renderLoop switches from the default
        // fixed-angle placement to this offset and keeps using it
        // for the life of this aircraft's track (see
        // DRAG_THRESHOLD_PX / datablock drag handling below).
        datablockOffset: null,
        featureGroup: L.featureGroup().addTo(trafficGroup),
        ui: {
            marker: L.marker([0, 0], { icon: targetDivIcon, interactive: true, opacity: 0, pane: 'aircraftPane' }),
            speedLine: L.polyline([[0,0],[0,0]], { color: '#5DEB3D', weight: 1.8, opacity: 1, interactive: false, pane: 'aircraftPane' }),
            dataBlock: createAircraftDatablock(id)
        }
    };
    const ui = aircraftState[id].ui;
    ui.marker.addTo(aircraftState[id].featureGroup);
    ui.speedLine.addTo(aircraftState[id].featureGroup);

    // The leader line connecting the aircraft dot to its datablock
    // is drawn as a masked SVG <line> in the shared
    // #datablock-leader-canvas overlay rather than as a Leaflet
    // polyline (see createDatablockLeaderLine / updateDatablockLeaderLine)
    // -- row-masking so the line stops at each text row's edge
    // isn't possible against Leaflet's Canvas polyline renderer.
    createDatablockLeaderLine(id);

    updateMarkerSourceShape(id);

    ui.marker.on('click', function(e) {
        L.DomEvent.stopPropagation(e);
        selectAircraft(id);
    });
    // Leaflet registers a bound tooltip's own DOM element as an
    // interactive target on the Tooltip layer itself (see
    // DivOverlay.prototype._initLayout -> addInteractiveTarget),
    // not on the marker it's attached to -- so the click handler
    // has to go on the tooltip object, not on ui.dataBlock.
    // A click here means "the user pressed and released without
    // dragging" -- see datablockDidDrag in the pointerdown
    // delegate below, which suppresses this when a drag happened.
    ui.dataBlock.getTooltip().on('click', function(e) {
        L.DomEvent.stopPropagation(e);
        if (consumeDatablockDrag()) {
            return;
        }
        selectAircraft(id);
        openAircraftInfoPanel(id);
    });
}

// Toggles the "mlat" CSS class on an aircraft's marker element so
// MLAT-sourced positions render as a rectangle instead of a circle.
function updateMarkerSourceShape(id) {
    const state = aircraftState[id];
    if (!state) return;
    const icon = state.ui.marker.getElement();
    if (!icon) return;
    if (state.srcType === 'MLAT') {
        icon.classList.add('mlat');
    } else {
        icon.classList.remove('mlat');
    }
}

function processTrafficTargets(targets, sourceLabel, siteDomain) {
    const now = Date.now();
    const activeIds = new Set();

    targets.forEach(t => {
        activeIds.add(t.id);
        if (!aircraftState[t.id]) {
            initAircraftState(t.id, t.call, t.srcType);
        }
        const state = aircraftState[t.id];
        const normalizedCallsign = String(t.call || '').trim().toUpperCase();
        if (state.operatorCallsign !== normalizedCallsign) {
            state.operatorCallsign = normalizedCallsign;
            state.metadataOperator = "";
        }
        state.callsign = t.call;
        state.actype = t.type || "UNK";
        state.wake = t.wake || "";
        state.registration = t.reg || "";
        state.country = t.country || state.country || "";
        state.operator = t.operator || state.metadataOperator || "";
        state.registeredOwner = state.metadataRegisteredOwner || t.registeredOwner || state.registeredOwner || "";
        state.typeName = t.typeName || "";
        state.squawk = t.squawk || "";
        state.selectedAltitude = t.selectedAlt ?? null;
        state.latestAlt = t.alt;
        state.latestSpeed = t.spd;
        state.latestHeading = t.hdg;
        state.onGround = !!t.onGround;
        state.srcType = t.srcType || "OTHER";
        updateMarkerSourceShape(t.id);

        const lastData = state.telemetry[state.telemetry.length - 1];
        if (!lastData || lastData.lat !== t.lat || lastData.lon !== t.lon) {
            state.telemetry.push({ time: now, lat: t.lat, lon: t.lon, alt: t.alt, spd: t.spd, hdg: t.hdg });
            if (state.telemetry.length > 4) state.telemetry.shift();
            state.lastPredictionUpdateTime = 0;

            state.trackHistory.push([t.lat, t.lon]);
            // Cap the full flight-path trail so long-running sessions
            // (or an aircraft tracked for hours) don't grow this array
            // -- and the polyline rebuilt from it -- without bound.
            // ~1hr of history at the 2s sweep interval.
            if (state.trackHistory.length > 1800) state.trackHistory.shift();

            if (!t.onGround) {
                // The rendered aircraft marker lags real time by RENDER_DELAY_MS
                // (for smooth interpolation), but history dots are pushed at
                // the moment fresh data arrives (real time). If we showed the
                // newest dot immediately, it would sit ahead of the marker.
                // So we keep the newest dot hidden and only show dots from
                // "latest+1" back to "latest+31" (i.e. skip index 0 from the
                // end, display the next 30).
                const dot = L.circleMarker([t.lat, t.lon], { radius: 2, color: '#5DEB3D', fillOpacity: 1, weight: 0, interactive: false, pane: 'aircraftPane' });
                state.historyDots.push(dot);

                // Reveal the previous newest dot now that a newer one has
                // taken its place as "latest" (it becomes "latest+1").
                // Only actually add it to the map if it lands on the
                // configured display-skip interval, so e.g. every OTHER
                // dot can be shown while the underlying trail data (and
                // the "latest+1..latest+31" windowing above) is unaffected.
                if (state.historyDots.length >= 2) {
                    const revealIndex = state.historyDots.length - 2;
                    const toReveal = state.historyDots[revealIndex];
                    state.historyDotRevealCount++;
                    const shouldShow = (state.historyDotRevealCount % HISTORY_DOT_DISPLAY_SKIP) === 0;
                    if (shouldShow && !state.featureGroup.hasLayer(toReveal)) {
                        toReveal.addTo(state.featureGroup);
                    }
                }

                if (state.historyDots.length > HISTORY_LENGTH + 1) {
                    const oldDot = state.historyDots.shift();
                    state.featureGroup.removeLayer(oldDot);
                }

                updateHistoryDotFade(state);
            }
        }
    });

    Object.keys(aircraftState).forEach(id => {
        if (!activeIds.has(id)) {
            if (trafficGroup.hasLayer(aircraftState[id].featureGroup)) {
                trafficGroup.removeLayer(aircraftState[id].featureGroup);
            }
            if (selectedAircraftIds.has(id)) {
                deselectAircraft(id);
            }
            removeDatablockLeaderLine(id);
            aircraftState[id].ui.dataBlock.remove();
            delete aircraftState[id];
        }
    });

    setTrafficSource('live', sourceLabel, siteDomain);
    applyFiltering();

    // Track history lines only need to grow when new ADS-B position
    // data actually comes in (once per sweep), not on every
    // animation frame -- rebuilding the polyline geometry is
    // relatively expensive (re-projection + path regeneration), so
    // doing it 60x/sec in renderLoop was pegging the CPU/GPU for no
    // visual benefit.
    if (selectedAircraftIds.size > 0) updateAllTrackHistoryLines();
}


function applyFiltering() {
    const limitFL = parseInt(document.getElementById('alt-filter-slider').value, 10);
    const trafficLayerActive = document.getElementById('layer-traffic').checked;
    const showGroundTraffic = document.getElementById('show-ground-traffic').checked;

    const showMlat = document.getElementById('src-mlat').checked;
    const showOther = document.getElementById('src-other').checked;

    Object.keys(aircraftState).forEach(id => {
        const state = aircraftState[id];
        const fl = Math.round(state.latestAlt / 100);
        
        let matchesHardwareFilter = false;
        if (state.srcType === 'MLAT' && showMlat) matchesHardwareFilter = true;
        else if (state.srcType === 'OTHER' && showOther) matchesHardwareFilter = true;

        const matchesGroundFilter = showGroundTraffic || !state.onGround;

        if (trafficLayerActive && fl <= limitFL && matchesHardwareFilter && matchesGroundFilter) {
            state.isFilteredVisible = true;
            if (!trafficGroup.hasLayer(state.featureGroup)) {
                trafficGroup.addLayer(state.featureGroup);
                // Leaflet creates a fresh DOM element for the marker
                // whenever it's re-added to the map, which loses the
                // "mlat" class that was previously applied
                // imperatively -- reapply it now so the correct
                // shape shows immediately instead of flashing as a
                // circle first.
                updateMarkerSourceShape(id);
            }
        } else {
            state.isFilteredVisible = false;
            state.ui.dataBlock.setOpacity(0);
            const leaderEntry = datablockLeaderLines.get(id);
            if (leaderEntry && leaderEntry.visible) {
                leaderEntry.visible = false;
                markLeaderCanvasDirty();
            }
            if (trafficGroup.hasLayer(state.featureGroup)) {
                trafficGroup.removeLayer(state.featureGroup);
            }
        }
    });
}

function processAdsbTraffic(data) {
    if (!data || !Array.isArray(data.ac)) throw new Error('Empty dataset returned');
    const targets = [];
    data.ac.forEach(ac => {
        if (!ac.lat || !ac.lon || !inRadarBox(ac.lat, ac.lon)) return;
        if (ac.t && ac.t.trim().toUpperCase() === 'TWR') return;
        
        const onGround = ac.alt_baro === 'ground';
        
        let srcType = 'OTHER';
        
        if (ac.type === 'adsb_icao' || ac.type === 'adsb_icao_nt' || ac.type === 'adsr_icao') {
            srcType = 'OTHER'; 
        } 
        else if (ac.type === 'mlat' || (ac.mlat && (Array.isArray(ac.mlat) ? ac.mlat.length > 0 : ac.mlat === true))) {
            srcType = 'MLAT';
        }

        const mcpSelectedAlt = Number(ac.nav_altitude_mcp);
        const fmsSelectedAlt = Number(ac.nav_altitude_fms);
        const selectedAltValue = Number.isFinite(mcpSelectedAlt)
            ? mcpSelectedAlt
            : fmsSelectedAlt;

        targets.push({
            id: (ac.hex || ac.icao || 'UNK').trim(),
            call: ac.flight ? ac.flight.trim() : 'UNK',
            lat: ac.lat,
            lon: ac.lon,
            alt: typeof ac.alt_baro === 'number' ? Math.round(ac.alt_baro) : 0,
            selectedAlt: Number.isFinite(selectedAltValue) ? Math.round(selectedAltValue) : null,
            onGround: onGround,
            spd: ac.gs ? Math.round(ac.gs) : 0,
            hdg: ac.track ?? ac.true_heading ?? ac.mag_heading ?? 0,
            type: ac.t ? ac.t.trim().toUpperCase() : 'UNK',
            wake: ac.category ? String(ac.category).trim().toUpperCase() : '',
            reg: ac.r ? ac.r.trim().toUpperCase() : '',
            country: getRegistrationCountry(ac.hex || ac.icao),
            operator: getAirlineOperator(ac.flight),
            registeredOwner: ac.ownOp || '',
            typeName: ac.desc || '',


            squawk: ac.squawk ? String(ac.squawk).trim() : '',
            srcType: srcType
        });
    });
    if (targets.length === 0) throw new Error('Zero targets inside tracking sector');
    processTrafficTargets(targets, `${targets.length} targets`, 'ADS-B.fi');
}

async function fetchJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

// ADS-B.fi is accessed through the Vercel serverless proxy.
// Keeping this as a same-origin path avoids browser CORS issues
// when the radar is deployed at the Vercel project URL.
const TRAFFIC_API_BASE = '/api/aircraft';

async function fetchLiveTraffic() {
    const [lat, lon] = RADAR_CENTER;
    const targetUrl =
        `${TRAFFIC_API_BASE}?lat=${encodeURIComponent(lat)}` +
        `&lon=${encodeURIComponent(lon)}` +
        `&dist=${encodeURIComponent(RADAR_RADIUS_NM)}`;

    try {
        const data = await fetchJson(targetUrl);
        processAdsbTraffic(data);
    } catch (err) {
        console.error("ADS-B.fi stream connection failure:", err.message);
        setTrafficSource('failed');
    }
}

function fetchRadarSweep() {
    fetchLiveTraffic();
}

// Initialize Filter Slider Observers
document.getElementById('alt-filter-slider').addEventListener('input', function(e) {
    const val = parseInt(e.target.value, 10);
    document.getElementById('alt-filter-val').textContent = `FL${val.toString().padStart(3, '0')}`;
    applyFiltering();
});

// Selected altitude datablock toggle
document.getElementById('show-selected-altitude').addEventListener('change', function() {
    Object.keys(aircraftState).forEach(id => {
        aircraftState[id].lastHTML = null;
    });
});

// Prediction Line Length Slider Observer
document.getElementById('predict-len-slider').addEventListener('input', function(e) {
    const val = parseFloat(e.target.value);
    PREDICT_MINUTES = val;
    document.getElementById('predict-len-val').textContent = `${val.toFixed(2)} MIN`;
    Object.values(aircraftState).forEach(state => {
        state.lastPredictionUpdateTime = 0;
    });
});

// Initialize Event Listeners for Simplified Hardware Source Switches
['src-mlat', 'src-other'].forEach(id => {
    document.getElementById(id).addEventListener('change', applyFiltering);
});

// Ground Traffic Visibility Toggle
document.getElementById('show-ground-traffic').addEventListener('change', applyFiltering);

export { POSITION_UPDATE_THRESHOLD_PX, PREDICTION_UPDATE_INTERVAL_MS, PREDICT_MINUTES, RENDER_DELAY_MS, SWEEP_INTERVAL_MS, aircraftState, applyFiltering, fetchRadarSweep };
