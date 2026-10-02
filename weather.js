import { formatZuluTime } from './time.js';
import { L } from './leaflet.js';
import { map } from './map.js';

// METAR and precipitation radar.

// ==========================================
// Live METAR Report Engine (LHBP)
// ==========================================
const METAR_STATION = 'LHBP';
const METAR_REFRESH_MS = 5 * 60 * 1000; // refresh every 5 minutes
 
async function updateMetar() {
    const metarEl = document.getElementById('radar-metar');
    const targetUrl = `/api/metar?ids=${encodeURIComponent(METAR_STATION)}`;

    try {
        const response = await fetch(targetUrl, {
            cache: 'no-store'
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = (await response.text()).trim();

        if (text) {
            metarEl.textContent = text;
        } else {
            metarEl.textContent = `METAR ${METAR_STATION}: NO DATA`;
        }
        updateMetarStatusPanel();
    } catch (err) {
        console.error("METAR fetch error:", err);
        metarEl.textContent = `METAR ${METAR_STATION}: UNAVAILABLE`;
    }
}

function updateMetarStatusPanel() {
    const el = document.getElementById('radar-metar-status');
    if (!el) return;
    const nowEpochSeconds = Math.floor(Date.now() / 1000);
    const nextEpochSeconds = nowEpochSeconds + METAR_REFRESH_MS / 1000;
    el.innerHTML = `METAR by aviationweather.gov<br>Last update: ${formatZuluTime(nowEpochSeconds)}<br>Next update: ${formatZuluTime(nextEpochSeconds)}`;
}
setInterval(updateMetar, METAR_REFRESH_MS);
updateMetar(); // Immediate fetch call on parse

// ==========================================
// RainViewer Precipitation Radar Overlay
// ==========================================
// RainViewer publishes a new radar frame every 10 minutes. We poll
// slightly more often than that (every 1 min) so a new frame is
// picked up promptly after it's published, but we only actually
// swap the tile layer when the frame timestamp has changed, so we
// don't reload identical tiles in between.
const RAIN_REFRESH_MS = 1 * 60 * 1000;
let rainLayer = null;
let rainOpacity = 0.7;
let rainLastFrameTime = null;

function buildRainLayer(tilePath) {
    return L.tileLayer(`https://tilecache.rainviewer.com${tilePath}/256/{z}/{x}/{y}/2/1_1.png`, {
        maxNativeZoom: 7,
        maxZoom: 18,
        opacity: rainOpacity,
        zIndex: 450,
        attribution: 'Radar &copy; RainViewer'
    });
}

async function refreshRainLayer() {
    const rainEnabled = document.getElementById('layer-rain').checked;
    if (!rainEnabled) return;

    try {
        const res = await fetch('https://api.rainviewer.com/public/weather-maps.json', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        const frames = data.radar && data.radar.past ? data.radar.past : [];
        if (frames.length === 0) throw new Error('No radar frames returned');

        const latestFrame = frames[frames.length - 1];

        // Skip if this is the same frame we're already displaying
        if (rainLayer && rainLastFrameTime === latestFrame.time) {
            updateRainStatusPanel(latestFrame.time);
            return;
        }

        const newLayer = buildRainLayer(latestFrame.path);

        newLayer.addTo(map);
        if (rainLayer) {
            newLayer.once('load', () => {
                map.removeLayer(rainLayer);
                rainLayer = newLayer;
                rainLastFrameTime = latestFrame.time;
                updateRainStatusPanel(latestFrame.time);
            });
        } else {
            rainLayer = newLayer;
            rainLastFrameTime = latestFrame.time;
            updateRainStatusPanel(latestFrame.time);
        }
    } catch (err) {
        console.error('RainViewer fetch error:', err);
    }
}

function updateRainStatusPanel(lastFrameEpochSeconds) {
    const el = document.getElementById('radar-rain-status');
    if (!el) return;
    const nextEpochSeconds = Math.floor(Date.now() / 1000) + RAIN_REFRESH_MS / 1000;
    el.innerHTML = `Weather radar by Rainviewer<br>Last update: ${formatZuluTime(lastFrameEpochSeconds)}<br>Next update: ${formatZuluTime(nextEpochSeconds)}`;
}

document.getElementById('layer-rain').addEventListener('change', function(e) {
    const opacityContainer = document.getElementById('rain-opacity-container');
    if (e.target.checked) {
        opacityContainer.style.display = 'block';
        refreshRainLayer();
    } else {
        opacityContainer.style.display = 'none';
        if (rainLayer) {
            map.removeLayer(rainLayer);
            rainLayer = null;
            rainLastFrameTime = null;
        }
    }
});

document.getElementById('rain-opacity-slider').addEventListener('input', function(e) {
    rainOpacity = parseInt(e.target.value, 10) / 100;
    document.getElementById('rain-opacity-val').textContent = `${e.target.value}%`;
    if (rainLayer) rainLayer.setOpacity(rainOpacity);
});

setInterval(refreshRainLayer, RAIN_REFRESH_MS);
