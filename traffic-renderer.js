import { map } from './map.js';
import { L } from './leaflet.js';
import { POSITION_UPDATE_THRESHOLD_PX, PREDICTION_UPDATE_INTERVAL_MS, PREDICT_MINUTES, RENDER_DELAY_MS, aircraftState } from './traffic.js';
import { EMERGENCY_SQUAWKS, EMERGENCY_SQUAWK_LABELS, closeAircraftInfoPanel, getFormattedCallsign, openAircraftInfoId, renderAircraftInfoPanel } from './aircraft-info.js';
import { getOffsetPoint } from './geo.js';

// Aircraft animation, datablocks, dragging, and canvas leaders.

// Permanent Leaflet tooltips synchronously measure their dimensions
// from _setPosition whenever setLatLng() moves them. With one tooltip
// per aircraft at animation-frame frequency, that forced one layout
// per visible aircraft per frame. Datablocks instead live as stable
// DOM nodes in the dedicated pane and move solely through a compositor-
// friendly transform; the small API mirrors the methods used below.
function createAircraftDatablock(id) {
    const element = document.createElement('div');
    element.className = 'leaflet-tooltip leaflet-zoom-animated leaflet-tooltip-right atc-label atc-label-clickable datablock-hidden';
    element.style.opacity = '0';
    element.setAttribute('aria-hidden', 'true');
    element.style.willChange = 'transform';
    map.getPane('datablockPane').appendChild(element);

    let latlng = L.latLng(0, 0);
    let opacity = 0;
    let layerPoint = L.point(0, 0);
    let halfHeightPx = 0;

    function applyPixelSnappedPosition() {
        const x = Math.round(layerPoint.x + 6);
        const y = Math.round(layerPoint.y - 10 - halfHeightPx);
        element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    }

    // Percentage centering (translateY(-50%)) puts text on fractional
    // pixels whenever the datablock height changes, notably when the
    // selected-altitude row is enabled. ResizeObserver supplies the
    // height asynchronously, avoiding a forced synchronous layout.
    const sizeObserver = new ResizeObserver(entries => {
        const entry = entries[0];
        const borderBox = Array.isArray(entry?.borderBoxSize)
            ? entry.borderBoxSize[0]
            : entry?.borderBoxSize;
        const height = borderBox?.blockSize ?? entry?.contentRect?.height;
        if (!Number.isFinite(height)) return;
        const nextHalfHeight = Math.round(height / 2);
        if (nextHalfHeight === halfHeightPx) return;
        halfHeightPx = nextHalfHeight;
        applyPixelSnappedPosition();

        // The content-height change moves the actual top-left corner
        // even though the datablock's geographic anchor is unchanged.
        // Invalidate this pair's cached DOM geometry so its leader is
        // remeasured on the next render instead of retaining the old
        // (slightly lower) endpoint until another traffic update.
        const leaderEntry = datablockLeaderLines.get(id);
        if (leaderEntry) {
            leaderEntry.measuredGeometryEpoch = -1;
            leaderCanvasDirty = true;
        }
    });
    sizeObserver.observe(element);

    const tooltipApi = {
        getElement: () => element,
        on(type, handler) {
            element.addEventListener(type, originalEvent => handler({ originalEvent }));
            return tooltipApi;
        }
    };

    return {
        getTooltip: () => tooltipApi,
        getLatLng: () => latlng,
        setLatLng(nextLatLng) {
            latlng = L.latLng(nextLatLng);
            layerPoint = map.latLngToLayerPoint(latlng);
            // Match Leaflet's former right-facing tooltip placement:
            // 6px right of the anchor, vertically centered, with the
            // configured -10px tooltip offset.
            applyPixelSnappedPosition();
            return this;
        },
        setTooltipContent(html) {
            element.innerHTML = html;
            return this;
        },
        setOpacity(nextOpacity) {
            if (opacity !== nextOpacity) {
                opacity = nextOpacity;
                element.style.opacity = String(nextOpacity);
                const isHidden = nextOpacity <= 0;
                element.classList.toggle('datablock-hidden', isHidden);
                element.setAttribute('aria-hidden', String(isHidden));
            }
            return this;
        },
        remove() {
            sizeObserver.disconnect();
            element.remove();
        }
    };
}

// Leader lines should stay a constant length on screen regardless of
// zoom level. Convert a target on-screen pixel length into NM using
// the map's current meters-per-pixel resolution. This only actually
// changes when the map is zoomed or panned (latitude affects meters-
// per-pixel too), so it's recomputed on those events instead of
// every renderLoop animation frame (up to 60x/sec).
const LEADER_LINE_PX = 28;
let leaderLineNM = 0.3;
function updateLeaderLineNM() {
    const metersPerPixel = 40075016.686 * Math.abs(Math.cos((map.getCenter().lat * Math.PI) / 180)) / Math.pow(2, map.getZoom() + 8);
    leaderLineNM = (LEADER_LINE_PX * metersPerPixel) / 1852;
}
updateLeaderLineNM();
map.on('zoomend move', updateLeaderLineNM);

// ---------------------------------------------------------------
// Datablock leader lines (single masked Canvas overlay)
// ---------------------------------------------------------------
const leaderCanvasEl = document.getElementById('datablock-leader-canvas');
const leaderCanvasCtx = leaderCanvasEl.getContext('2d');
const datablockLeaderLines = new Map();
let datablockGeometryEpoch = 0;
let revealLeaderCanvasAfterRender = false;
let leaderCanvasDirty = true;
const DATABLOCK_MASK_PAD_X = 3;
const DATABLOCK_MASK_PAD_Y = 1;

map.on('zoomstart', () => {
    leaderCanvasEl.style.visibility = 'hidden';
});
map.on('zoomend', () => {
    datablockGeometryEpoch++;
    revealLeaderCanvasAfterRender = true;
});
map.on('moveend resize', () => {
    datablockGeometryEpoch++;
});

function createDatablockLeaderLine(id) {
    datablockLeaderLines.set(id, {
        visible: false,
        x1: 0, y1: 0, x2: 0, y2: 0,
        lastCornerOffsetX: null,
        lastCornerOffsetY: null,
        measuredDatablockX: null,
        measuredDatablockY: null,
        measuredGeometryEpoch: -1,
        maskRects: [],
        lastHTML: null
    });
    leaderCanvasDirty = true;
}

function removeDatablockLeaderLine(id) {
    datablockLeaderLines.delete(id);
    leaderCanvasDirty = true;
}

function updateDatablockLeaderLine(id, aircraftX, aircraftY, datablockX, datablockY, tooltipEl, blockHTML, isDragging) {
    const entry = datablockLeaderLines.get(id);
    if (!entry) return;
    if (!tooltipEl || !document.contains(tooltipEl)) {
        if (entry.visible) leaderCanvasDirty = true;
        entry.visible = false;
        return;
    }

    if (!entry.visible) leaderCanvasDirty = true;
    entry.visible = true;
    const contentChanged = entry.lastHTML !== blockHTML;
    const needsMeasurement =
        entry.lastCornerOffsetX === null ||
        entry.lastCornerOffsetY === null ||
        entry.measuredGeometryEpoch !== datablockGeometryEpoch ||
        contentChanged ||
        isDragging;

    let cornerX = datablockX + (entry.lastCornerOffsetX || 0);
    let cornerY = datablockY + (entry.lastCornerOffsetY || 0);

    if (needsMeasurement) {
        const rows = Array.from(tooltipEl.querySelectorAll('div')).filter(
            d => d.querySelector('div') === null
        );
        if (rows.length === 0) {
            entry.visible = false;
            return;
        }

        const scopeRect = map.getContainer().getBoundingClientRect();
        const firstRowRect = rows[0].getBoundingClientRect();
        cornerX = firstRowRect.left - scopeRect.left;
        cornerY = firstRowRect.top - scopeRect.top;
        entry.lastCornerOffsetX = cornerX - datablockX;
        entry.lastCornerOffsetY = cornerY - datablockY;
        entry.measuredDatablockX = datablockX;
        entry.measuredDatablockY = datablockY;
        entry.measuredGeometryEpoch = datablockGeometryEpoch;
        entry.lastHTML = blockHTML;

        entry.maskRects = rows.map(row => {
            const rect = row.getBoundingClientRect();
            const textRange = document.createRange();
            textRange.selectNodeContents(row);
            const textRect = textRange.getBoundingClientRect();
            const useTextRect = textRect.width > 0 && textRect.width <= rect.width;
            return {
                x: (useTextRect ? textRect.left : rect.left) - scopeRect.left - DATABLOCK_MASK_PAD_X,
                y: rect.top - scopeRect.top - DATABLOCK_MASK_PAD_Y,
                width: (useTextRect ? textRect.width : rect.width) + DATABLOCK_MASK_PAD_X * 2,
                height: rect.height + DATABLOCK_MASK_PAD_Y * 2
            };
        });
        leaderCanvasDirty = true;
    }

    const nextX2 = cornerX + 30;
    const nextY2 = cornerY + 10;
    if (Math.hypot(aircraftX - entry.x1, aircraftY - entry.y1) >= POSITION_UPDATE_THRESHOLD_PX ||
        Math.hypot(nextX2 - entry.x2, nextY2 - entry.y2) >= POSITION_UPDATE_THRESHOLD_PX) {
        entry.x1 = aircraftX;
        entry.y1 = aircraftY;
        entry.x2 = nextX2;
        entry.y2 = nextY2;
        leaderCanvasDirty = true;
    }
}

// Return the [enter, exit] parameter interval where one line segment
// lies inside an axis-aligned rectangle (Liang-Barsky clipping).
// null means the line never enters that rectangle.
function lineRectangleInterval(x1, y1, x2, y2, rect) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const p = [-dx, dx, -dy, dy];
    const q = [
        x1 - rect.x,
        rect.x + rect.width - x1,
        y1 - rect.y,
        rect.y + rect.height - y1
    ];
    let enter = 0;
    let exit = 1;

    for (let i = 0; i < 4; i++) {
        if (Math.abs(p[i]) < 1e-9) {
            if (q[i] < 0) return null;
            continue;
        }
        const t = q[i] / p[i];
        if (p[i] < 0) enter = Math.max(enter, t);
        else exit = Math.min(exit, t);
        if (enter > exit) return null;
    }
    return [enter, exit];
}

function appendPairMaskedLeaderPath(ctx, entry) {
    const dx = entry.x2 - 30 - entry.lastCornerOffsetX - entry.measuredDatablockX;
    const dy = entry.y2 - 10 - entry.lastCornerOffsetY - entry.measuredDatablockY;
    const intervals = [];

    entry.maskRects.forEach(rect => {
        const translatedRect = {
            x: rect.x + dx,
            y: rect.y + dy,
            width: rect.width,
            height: rect.height
        };
        const interval = lineRectangleInterval(
            entry.x1, entry.y1, entry.x2, entry.y2, translatedRect
        );
        if (interval) intervals.push(interval);
    });

    intervals.sort((a, b) => a[0] - b[0]);
    const merged = [];
    intervals.forEach(interval => {
        const previous = merged[merged.length - 1];
        if (previous && interval[0] <= previous[1]) {
            previous[1] = Math.max(previous[1], interval[1]);
        } else {
            merged.push(interval.slice());
        }
    });

    const lineDx = entry.x2 - entry.x1;
    const lineDy = entry.y2 - entry.y1;
    let cursor = 0;
    merged.forEach(([start, end]) => {
        if (start > cursor) {
            ctx.moveTo(entry.x1 + lineDx * cursor, entry.y1 + lineDy * cursor);
            ctx.lineTo(entry.x1 + lineDx * start, entry.y1 + lineDy * start);
        }
        cursor = Math.max(cursor, end);
    });
    if (cursor < 1) {
        ctx.moveTo(entry.x1 + lineDx * cursor, entry.y1 + lineDy * cursor);
        ctx.lineTo(entry.x2, entry.y2);
    }
}

function drawDatablockLeaderLines() {
    if (!leaderCanvasDirty) return;
    const width = map.getContainer().clientWidth;
    const height = map.getContainer().clientHeight;
    const dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (leaderCanvasEl.width !== pixelWidth || leaderCanvasEl.height !== pixelHeight) {
        leaderCanvasEl.width = pixelWidth;
        leaderCanvasEl.height = pixelHeight;
    }

    leaderCanvasCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    leaderCanvasCtx.clearRect(0, 0, width, height);
    leaderCanvasCtx.globalCompositeOperation = 'source-over';
    leaderCanvasCtx.strokeStyle = '#5DEB3D';
    leaderCanvasCtx.lineWidth = 1.5;
    leaderCanvasCtx.beginPath();
    datablockLeaderLines.forEach(entry => {
        if (!entry.visible) return;
        if (entry.measuredDatablockX === null || entry.maskRects.length === 0) {
            leaderCanvasCtx.moveTo(entry.x1, entry.y1);
            leaderCanvasCtx.lineTo(entry.x2, entry.y2);
            return;
        }
        appendPairMaskedLeaderPath(leaderCanvasCtx, entry);
    });
    leaderCanvasCtx.stroke();
    leaderCanvasDirty = false;
}

// ---------------------------------------------------------------
// Datablock dragging (repositioning)
// ---------------------------------------------------------------
// Delegated pointer events on the map container, matching
// initRubberBandSelect's delegation style, rather than binding
// directly to each tooltip's DOM element -- the tooltip element
// is recreated by Leaflet at times outside our control (e.g.
// certain re-renders), and delegation sidesteps needing to know
// when that happens. e.target.closest('.atc-label-clickable')
// identifies a datablock click/drag the same way the click
// handler in initAircraftState already does.
//
// Marker({draggable:true}) was deliberately NOT used here: this
// datablock's clickable/visible surface is the bound Tooltip's own
// DOM element, not the (invisible, interactive:false) marker
// icon -- and Leaflet does not move a draggable marker when you
// drag its tooltip instead of its icon (confirmed via
// https://github.com/Leaflet/Leaflet/issues/6225); dragging the
// tooltip pans the map instead. Manual pointer capture on the
// tooltip element, with map.dragging disabled for the duration
// (same pattern as box-select), avoids that entirely.
const DATABLOCK_DRAG_THRESHOLD_PX = 4;
let datablockDraggingId = null;   // aircraft id currently being dragged, or null
let datablockDraggingTooltipEl = null; // the tooltip DOM element for datablockDraggingId
let datablockDidDrag = false;     // true once movement crossed the threshold this press
let datablockPointerDownX = 0;
let datablockPointerDownY = 0;
let datablockDragStartOffset = { dx: 0, dy: 0 }; // this aircraft's offset at pointerdown

function initDatablockDragging() {
    const container = map.getContainer();

    container.addEventListener('pointerdown', (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        const tooltipEl = e.target.closest && e.target.closest('.atc-label-clickable');
        if (!tooltipEl) return;

        // Find which aircraft this tooltip belongs to. Aircraft
        // counts here are small enough (dozens) that a linear
        // scan on pointerdown -- a rare, user-driven event, not a
        // per-frame one -- is negligible.
        let id = null;
        for (const key of Object.keys(aircraftState)) {
            const t = aircraftState[key].ui.dataBlock.getTooltip();
            if (t && t.getElement() === tooltipEl) { id = key; break; }
        }
        if (id === null) return;

        datablockDraggingId = id;
        datablockDraggingTooltipEl = tooltipEl;
        datablockDidDrag = false;
        datablockPointerDownX = e.clientX;
        datablockPointerDownY = e.clientY;

        const state = aircraftState[id];
        datablockDragStartOffset = state.datablockOffset
            ? { dx: state.datablockOffset.dx, dy: state.datablockOffset.dy }
            : (() => {
                // No offset yet -- derive the equivalent starting
                // offset from the datablock's current default
                // (fixed-angle) screen position so the drag
                // continues smoothly from where the block already
                // is, instead of jumping.
                const aircraftPoint = map.latLngToContainerPoint(state.ui.marker.getLatLng());
                const blockPoint = map.latLngToContainerPoint(state.ui.dataBlock.getLatLng());
                return { dx: blockPoint.x - aircraftPoint.x, dy: blockPoint.y - aircraftPoint.y };
            })();

        map.dragging.disable(); // don't pan the map while dragging a datablock
        // Pointer capture is deliberately NOT taken here. Per the
        // Pointer Events spec, once a pointer is captured, the
        // resulting "click" event (fired on pointerup) is
        // dispatched to the captured element instead of bubbling
        // through the original hit-tree -- which would prevent a
        // plain click from ever reaching the tooltip's own click
        // handler (see initAircraftState) and opening the info
        // panel. Capture is instead taken in pointermove, once
        // movement has crossed the drag threshold and this
        // interaction is confirmed to be a drag, not a click.
    });

    container.addEventListener('pointermove', (e) => {
        if (datablockDraggingId === null) return;

        const movedX = e.clientX - datablockPointerDownX;
        const movedY = e.clientY - datablockPointerDownY;

        if (!datablockDidDrag) {
            if (Math.hypot(movedX, movedY) < DATABLOCK_DRAG_THRESHOLD_PX) return;
            datablockDidDrag = true;
            container.setPointerCapture(e.pointerId);
            if (datablockDraggingTooltipEl) datablockDraggingTooltipEl.classList.add('datablock-dragging');
        }

        const state = aircraftState[datablockDraggingId];
        if (!state) { datablockDraggingId = null; return; }

        state.datablockOffset = {
            dx: datablockDragStartOffset.dx + movedX,
            dy: datablockDragStartOffset.dy + movedY
        };
    });

    function endDatablockDrag(e) {
        if (datablockDraggingId === null) return;
        document.querySelectorAll('.atc-label-clickable.datablock-dragging').forEach(el => el.classList.remove('datablock-dragging'));

        datablockDraggingId = null;
        datablockDraggingTooltipEl = null;
        map.dragging.enable();
        try { container.releasePointerCapture(e.pointerId); } catch (_) {}
        // datablockDidDrag is intentionally left as-is here -- the
        // tooltip's own 'click' handler (see initAircraftState)
        // reads and clears it to decide whether this pointerup
        // should also open the info panel.
    }

    container.addEventListener('pointerup', endDatablockDrag);
    container.addEventListener('pointercancel', endDatablockDrag);
}
initDatablockDragging();


const callsignFormatCheckbox = document.getElementById('callsign-format-long');
const radarSearchInput = document.getElementById('radar-search');

function simplifyWakeCategory(category) {
    const code = String(category || '').trim().toUpperCase();
    if (code === 'A1' || code === 'A2' || code === 'A7') return 'L';
    if (code === 'A3' || code === 'A4') return 'M';
    if (code === 'A5' || code === 'A6') return 'H';
    return '';
}

function formatDatablockAltitude(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '---';
    const belowTA = n < 10000;
    const flValue = Math.round(n / 100);
    const flStr = belowTA
        ? flValue.toString()
        : flValue.toString().padStart(3, '0');
    return `${belowTA ? 'A' : ''}${flStr}`;
}

const MAX_RENDER_FPS = 60;
const MIN_RENDER_FRAME_MS = 1000 / MAX_RENDER_FPS;
let lastRenderedFrameTime = 0;

function renderLoop(frameTime) {
    // requestAnimationFrame follows the display refresh rate, which
    // was 120Hz in the captured Vivaldi trace. Keep requesting frames
    // so the tab remains synchronized with the browser, but perform
    // radar interpolation/DOM/Leaflet work at no more than 60Hz.
    const elapsed = frameTime - lastRenderedFrameTime;
    if (lastRenderedFrameTime && elapsed < MIN_RENDER_FRAME_MS - 0.5) {
        requestAnimationFrame(renderLoop);
        return;
    }
    // Carry a small remainder forward to avoid slowly drifting below
    // 60Hz when callback timestamps do not land exactly on 16.67ms.
    lastRenderedFrameTime = lastRenderedFrameTime
        ? frameTime - (elapsed % MIN_RENDER_FRAME_MS)
        : frameTime;

    const renderTime = Date.now() - RENDER_DELAY_MS;
    const useLongFormat = callsignFormatCheckbox.checked;

    const searchQuery = radarSearchInput ? radarSearchInput.value.toUpperCase().trim() : "";

    // Keep the open aircraft info panel's live fields (squawk,
    // callsign, type) current as new telemetry arrives, without
    // re-fetching the planespotters photo every frame.
    if (openAircraftInfoId) {
        if (aircraftState[openAircraftInfoId]) {
            renderAircraftInfoPanel(openAircraftInfoId);
        } else {
            closeAircraftInfoPanel();
        }
    }

    Object.keys(aircraftState).forEach(id => {
        const state = aircraftState[id];
        if (state.telemetry.length < 2) return;
        if (!state.isFilteredVisible) return;

        let interpLat, interpLon, interpAlt, interpSpd, interpHdg;
        let p1 = null, p2 = null;

        for (let i = 0; i < state.telemetry.length - 1; i++) {
            if (renderTime >= state.telemetry[i].time && renderTime <= state.telemetry[i+1].time) {
                p1 = state.telemetry[i];
                p2 = state.telemetry[i+1];
                break;
            }
        }

        if (p1 && p2) {
            const progress = (renderTime - p1.time) / (p2.time - p1.time);
            interpLat = p1.lat + (p2.lat - p1.lat) * progress;
            interpLon = p1.lon + (p2.lon - p1.lon) * progress;
            interpAlt = p1.alt + (p2.alt - p1.alt) * progress;
            interpSpd = p1.spd + (p2.spd - p1.spd) * progress;

            let diff = p2.hdg - p1.hdg;
            if (diff > 180) diff -= 360;
            if (diff < -180) diff += 360;
            interpHdg = (p1.hdg + diff * progress) % 360;
            if (interpHdg < 0) interpHdg += 360;
        } else {
            const latest = state.telemetry[state.telemetry.length - 1];
            if (renderTime > latest.time) {
                const timeDiffSec = (renderTime - latest.time) / 1000;
                const safeTimeDiff = Math.min(timeDiffSec, 6); 
                const distNM = (latest.spd / 3600) * safeTimeDiff;
                const projected = getOffsetPoint([latest.lat, latest.lon], distNM, latest.hdg);
                interpLat = projected[0];
                interpLon = projected[1];
                interpAlt = latest.alt;
                interpSpd = latest.spd;
                interpHdg = latest.hdg;
            } else {
                const oldest = state.telemetry[0];
                interpLat = oldest.lat;
                interpLon = oldest.lon;
                interpAlt = oldest.alt;
                interpSpd = oldest.spd;
                interpHdg = oldest.hdg;
            }
        }

        const currentPos = [interpLat, interpLon];
        const projectedAircraftPoint = map.latLngToContainerPoint(currentPos);
        const aircraftPositionChanged =
            !state.lastAircraftPoint ||
            Math.hypot(
                projectedAircraftPoint.x - state.lastAircraftPoint.x,
                projectedAircraftPoint.y - state.lastAircraftPoint.y
            ) >= POSITION_UPDATE_THRESHOLD_PX;

        if (aircraftPositionChanged) {
            state.ui.marker.setLatLng(currentPos);
            state.lastAircraftPoint = projectedAircraftPoint;
        }
        if (!state.markerVisible) {
            state.ui.marker.setOpacity(1);
            state.markerVisible = true;
        }

        if (interpSpd > 30 || state.onGround) {
            const predictionVisible = interpSpd > 30;
            if (state.speedLineVisible !== predictionVisible) {
                state.speedLineVisible = predictionVisible;
                state.ui.speedLine.setStyle({ opacity: predictionVisible ? 0.8 : 0 });
            }
            if (predictionVisible &&
                (state.lastPredictionUpdateTime === 0 ||
                 frameTime - state.lastPredictionUpdateTime >= PREDICTION_UPDATE_INTERVAL_MS)) {
                const distanceNM = (interpSpd / 60) * PREDICT_MINUTES;
                const projectedPos = getOffsetPoint(currentPos, distanceNM, interpHdg);
                state.ui.speedLine.setLatLngs([currentPos, projectedPos]);
                state.lastPredictionUpdateTime = frameTime;
            }

            // Datablock placement: once the user has dragged this
            // aircraft's datablock, state.datablockOffset (screen
            // pixels from the aircraft) takes over from the
            // default fixed-angle placement and persists for the
            // life of the aircraft's track (see initAircraftState
            // and the drag handling below).
            let leaderEnd;
            if (state.datablockOffset) {
                const aircraftPoint = map.latLngToContainerPoint(currentPos);
                const anchorPoint = L.point(
                    aircraftPoint.x + state.datablockOffset.dx,
                    aircraftPoint.y + state.datablockOffset.dy
                );
                leaderEnd = map.containerPointToLatLng(anchorPoint);
            } else {
                leaderEnd = getOffsetPoint(currentPos, leaderLineNM, 45);
            }
            const projectedDatablockPoint = map.latLngToContainerPoint(leaderEnd);
            const datablockPositionChanged =
                !state.lastDatablockPoint ||
                Math.hypot(
                    projectedDatablockPoint.x - state.lastDatablockPoint.x,
                    projectedDatablockPoint.y - state.lastDatablockPoint.y
                ) >= POSITION_UPDATE_THRESHOLD_PX;
            if (datablockPositionChanged) {
                state.ui.dataBlock.setLatLng(leaderEnd);
                state.lastDatablockPoint = projectedDatablockPoint;
            }

            const isBelowTA = interpAlt < 10000;
            const altPrefix = isBelowTA ? 'A' : '';
            const flValue = Math.round(interpAlt / 100);
            const flStr = state.onGround ? 'GND' : (isBelowTA ? flValue.toString() : flValue.toString().padStart(3, '0'));
            const altLabel = state.onGround ? flStr : `${altPrefix}${flStr}`;
            const spdStr = `N${Math.round(interpSpd).toString().padStart(3, '0')}`;
            const labelCallsign = getFormattedCallsign(state.callsign, useLongFormat);
            
            let trend = "";
            if (!state.onGround && state.telemetry.length > 1) {
                const oldest = state.telemetry[0];
                const diff = interpAlt - oldest.alt;
                if (diff > 50) trend = " ↑";
                else if (diff < -50) trend = " ↓";
            }

            const isAircraftMatched = searchQuery && (
                state.callsign.toUpperCase().includes(searchQuery) || 
                labelCallsign.toUpperCase().includes(searchQuery)
            );

            const callsignColor = isAircraftMatched ? '#FFFF00' : '#5DEB3D';
            const dataLineColor = isAircraftMatched ? '#FFFF00' : 'rgba(255,255,255,1.0)';
            const acTypeColor   = isAircraftMatched ? '#FFFF00' : 'rgba(255,255,255,0.5)';

            const selectedAltitudeEnabled = document.getElementById('show-selected-altitude').checked;
            const selectedAltitudeLabel = selectedAltitudeEnabled
                ? `${formatDatablockAltitude(state.selectedAltitude)}&nbsp;&nbsp;&nbsp;`
                : '';
            const wakeLabel = simplifyWakeCategory(state.wake);
            const typeLabel = wakeLabel ? `${state.actype}/${wakeLabel}` : state.actype;

            const isEmergency = EMERGENCY_SQUAWKS.has(state.squawk);
            const emergencyRowHTML = isEmergency
                ? `<div class="atc-label-emergency">${EMERGENCY_SQUAWK_LABELS[state.squawk] || 'EMERGENCY'}</div>`
                : '';

            const blockHTML = emergencyRowHTML +
                              `<div style="color:${callsignColor}; font-weight:${isAircraftMatched ? 'bold' : 'normal'};">${labelCallsign}</div>` +
                              `<div style="color:${dataLineColor};">${altLabel}${trend} &nbsp;${spdStr}</div>` +
                              (selectedAltitudeEnabled
                                  ? `<div style="color:${dataLineColor};">${selectedAltitudeLabel}</div><div style="color:${acTypeColor};">${typeLabel}</div>`
                                  : `<div style="color:${acTypeColor};">${typeLabel}</div>`);
            
            if (state.lastHTML !== blockHTML) {
                state.ui.dataBlock.setTooltipContent(blockHTML);
                state.lastHTML = blockHTML;
            }
            state.ui.dataBlock.setOpacity(1);

            const aircraftPoint = state.lastAircraftPoint || projectedAircraftPoint;
            const datablockPoint = state.lastDatablockPoint || projectedDatablockPoint;
            const tooltipEl = state.ui.dataBlock.getTooltip().getElement();
            updateDatablockLeaderLine(
                id,
                aircraftPoint.x, aircraftPoint.y,
                datablockPoint.x, datablockPoint.y,
                tooltipEl,
                blockHTML,
                datablockDraggingId === id
            );
        } else {
            if (state.speedLineVisible) {
                state.speedLineVisible = false;
                state.ui.speedLine.setStyle({ opacity: 0 });
            }
            state.ui.dataBlock.setOpacity(0);
            const entry = datablockLeaderLines.get(id);
            if (entry && entry.visible) {
                entry.visible = false;
                leaderCanvasDirty = true;
            }
        }
    });

    drawDatablockLeaderLines();

    if (revealLeaderCanvasAfterRender) {
        leaderCanvasEl.style.visibility = '';
        revealLeaderCanvasAfterRender = false;
    }

    requestAnimationFrame(renderLoop);
}
function startTrafficRenderer() {
    requestAnimationFrame(renderLoop);
}


function markLeaderCanvasDirty() {
    leaderCanvasDirty = true;
}

function consumeDatablockDrag() {
    const didDrag = datablockDidDrag;
    datablockDidDrag = false;
    return didDrag;
}

export { consumeDatablockDrag, createAircraftDatablock, createDatablockLeaderLine, datablockLeaderLines, markLeaderCanvasDirty, removeDatablockLeaderLine, startTrafficRenderer };
