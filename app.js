import './measurement.js';
import './weather.js';
import { SWEEP_INTERVAL_MS, fetchRadarSweep } from './traffic.js';
import { createAirspaceManager } from './airspace-manager.js';
import { L } from './leaflet.js';
import { map } from './map.js';
import { formatZuluTime } from './time.js';
import { initWaypointsAndProcedures } from './waypoints.js';
import { initAirlineDatabase } from './aircraft-info.js';
import { loadGroundFeatures, loadStands, loadTaxiwayLines } from './ground-features.js';
import { applyRwyDirection, currentRwyDirection, initOnOffControls } from './ui.js';
import { startTrafficRenderer } from './traffic-renderer.js';

// Application startup and radar sweep scheduling.

// Main Application Dynamic Bootstrapping Sequence
//
// Chromium (incl. Vivaldi) aggressively throttles setInterval/setTimeout on
// background tabs -- after a few minutes hidden, timers can be clamped to
// firing roughly once a minute, which is why the radar sweep goes sparse
// when this tab isn't focused. Dedicated Web Workers run on a separate
// thread and are exempt from that background-tab clamp, so we use a tiny
// inline worker purely as a precise metronome: it just posts a "tick"
// message on schedule, and the main thread does the actual fetch/render
// work as before. This keeps the sweep interval accurate even when the
// tab is backgrounded, minimized, or in another virtual desktop.
const sweepWorkerSrc = `
    let intervalId = null;
    self.onmessage = function(e) {
        if (e.data && e.data.type === 'start') {
            if (intervalId) clearInterval(intervalId);
            intervalId = setInterval(() => self.postMessage('tick'), e.data.intervalMs);
        }
    };
`;
let sweepWorker = null;
try {
    const workerBlob = new Blob([sweepWorkerSrc], { type: 'application/javascript' });
    sweepWorker = new Worker(URL.createObjectURL(workerBlob));
    sweepWorker.onmessage = function(e) {
        if (e.data === 'tick') fetchRadarSweep();
    };
} catch (err) {
    console.warn('Web Worker unavailable, falling back to setInterval (sweep may go sparse in background tabs):', err);
}

const AirspaceManager = createAirspaceManager({ L, map, formatZuluTime });


async function bootApp() {
    console.log('Data is in accordance with AIRAC AMDT 006/2026: https://ais.hungarocontrol.hu/aip/2026-09-03/');
    await initWaypointsAndProcedures();
    await initAirlineDatabase(); 
    await loadGroundFeatures();
    await loadTaxiwayLines();
    await loadStands();
    await AirspaceManager.init();
    // Initialize the runway-direction-dependent layers (extensions,
    // SID, STAR, 7XX/8XX waypoint filters) to the default direction
    // (31) now that every checkbox's change listener is registered.
    applyRwyDirection(currentRwyDirection);
    fetchRadarSweep();
    if (sweepWorker) {
        sweepWorker.postMessage({ type: 'start', intervalMs: SWEEP_INTERVAL_MS });
    } else {
        setInterval(fetchRadarSweep, SWEEP_INTERVAL_MS);
    }
}

initOnOffControls();
startTrafficRenderer();
bootApp();
