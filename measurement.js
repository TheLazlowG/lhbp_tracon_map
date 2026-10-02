import { map } from './map.js';
import { L } from './leaflet.js';
import { formatHeading, normalizedHeading, trueBearingDegrees } from './geo.js';

// Interactive multi-segment distance and bearing tool.

// Multi-segment tape measure. Declination at LHBP is fixed at 6°E:
// magnetic heading = true heading - easterly declination.
const MAGNETIC_DECLINATION_DEGREES = 6;
const METERS_PER_NAUTICAL_MILE = 1852;
const measureToolbox = document.getElementById('radar-toolbox');
const measureButton = document.getElementById('radar-measure-btn');
const measureClearButton = document.getElementById('radar-measure-clear');
const measureStatus = document.getElementById('radar-measure-status');
map.createPane('measurePane');
map.getPane('measurePane').style.zIndex = 760;
map.getPane('measurePane').style.pointerEvents = 'none';
const measureLayers = L.layerGroup().addTo(map);
let measureActive = false;
let measurePoints = [];
let measureTotalNM = 0;
let measurePath = null;
let measurePreviewPath = null;
let measurePreviewLabel = null;
let restoreMeasureDoubleClickZoom = false;

function measureSegmentData(start, end) {
    const distanceNM = map.distance(start, end) / METERS_PER_NAUTICAL_MILE;
    const trueHeading = trueBearingDegrees(start, end);
    const magneticHeading = normalizedHeading(trueHeading - MAGNETIC_DECLINATION_DEGREES);
    return {
        distanceNM,
        label: `${distanceNM.toFixed(2)} NM · ${formatHeading(trueHeading)}°T / ${formatHeading(magneticHeading)}°M`
    };
}

function measureMidpoint(start, end) {
    return L.latLng((start.lat + end.lat) / 2, (start.lng + end.lng) / 2);
}

function hideMeasurePreview() {
    if (measurePreviewPath) measureLayers.removeLayer(measurePreviewPath);
    if (measurePreviewLabel) measureLayers.removeLayer(measurePreviewLabel);
    measurePreviewPath = null;
    measurePreviewLabel = null;
}

function setMeasureActive(active) {
    measureActive = active;
    if (active) {
        restoreMeasureDoubleClickZoom = map.doubleClickZoom.enabled();
        map.doubleClickZoom.disable();
    } else {
        hideMeasurePreview();
        if (restoreMeasureDoubleClickZoom) map.doubleClickZoom.enable();
        restoreMeasureDoubleClickZoom = false;
    }
    measureButton.classList.toggle('active', active);
    measureButton.setAttribute('aria-pressed', String(active));
    measureButton.textContent = active ? 'DONE' : 'MEASURE';
    measureToolbox.classList.toggle('measuring', active);
    document.getElementById('radar-scope').classList.toggle('measure-mode', active);
    if (active) {
        measureStatus.textContent = measurePoints.length
            ? 'CLICK MAP TO ADD ANOTHER SEGMENT'
            : 'CLICK MAP TO SET THE START POINT';
    } else if (!measurePoints.length) {
        measureStatus.textContent = 'SELECT MEASURE, THEN CLICK THE MAP';
    }
}

function updateMeasureStatus() {
    const segmentCount = Math.max(0, measurePoints.length - 1);
    measureToolbox.classList.toggle('has-measurement', measurePoints.length > 0);
    if (segmentCount) {
        measureStatus.textContent = `${segmentCount} SEG${segmentCount === 1 ? '' : 'S'} · TOTAL ${measureTotalNM.toFixed(2)} NM${measureActive ? ' · CLICK TO ADD' : ''}`;
    } else if (measurePoints.length) {
        measureStatus.textContent = measureActive ? 'START SET · CLICK MAP FOR NEXT POINT' : 'START POINT SET';
    }
}

function clearMeasurement() {
    measureLayers.clearLayers();
    measurePoints = [];
    measureTotalNM = 0;
    measurePath = null;
    measurePreviewPath = null;
    measurePreviewLabel = null;
    measureToolbox.classList.remove('has-measurement');
    measureStatus.textContent = measureActive
        ? 'CLICK MAP TO SET THE START POINT'
        : 'SELECT MEASURE, THEN CLICK THE MAP';
}

measureButton.addEventListener('click', function() {
    setMeasureActive(!measureActive);
    updateMeasureStatus();
});

measureClearButton.addEventListener('click', clearMeasurement);

map.on('mousemove', function(e) {
    if (!measureActive || !measurePoints.length) return;

    const start = measurePoints[measurePoints.length - 1];
    const end = e.latlng;
    const segment = measureSegmentData(start, end);
    const midpoint = measureMidpoint(start, end);

    if (!measurePreviewPath) {
        measurePreviewPath = L.polyline([start, end], {
            pane: 'measurePane',
            color: '#ffe600',
            weight: 2,
            opacity: .9,
            interactive: false,
            className: 'radar-measure-path'
        }).addTo(measureLayers);
    } else {
        measurePreviewPath.setLatLngs([start, end]);
    }

    const previewIcon = L.divIcon({
        className: 'radar-measure-label-icon',
        html: `<span class="radar-measure-label preview">${segment.label}</span>`,
        iconSize: null
    });
    if (!measurePreviewLabel) {
        measurePreviewLabel = L.marker(midpoint, {
            pane: 'measurePane',
            interactive: false,
            keyboard: false,
            icon: previewIcon
        }).addTo(measureLayers);
    } else {
        measurePreviewLabel.setLatLng(midpoint);
        measurePreviewLabel.setIcon(previewIcon);
    }

    measureStatus.textContent = `NEXT ${segment.label} · TOTAL ${(measureTotalNM + segment.distanceNM).toFixed(2)} NM`;
});

map.on('mouseout', function() {
    if (!measureActive || !measurePoints.length) return;
    hideMeasurePreview();
    updateMeasureStatus();
});

map.on('click', function(e) {
    if (!measureActive) return;

    const nextPoint = e.latlng;
    const previousPoint = measurePoints[measurePoints.length - 1];
    if (previousPoint) {
        const previousPixel = map.latLngToContainerPoint(previousPoint);
        const nextPixel = map.latLngToContainerPoint(nextPoint);
        if (previousPixel.distanceTo(nextPixel) < 4) return;
    }
    hideMeasurePreview();
    measurePoints.push(nextPoint);

    L.marker(nextPoint, {
        pane: 'measurePane',
        interactive: false,
        keyboard: false,
        icon: L.divIcon({ className: '', html: '<div class="radar-measure-point-icon"></div>', iconSize: [1, 1] })
    }).addTo(measureLayers);

    if (!measurePath) {
        measurePath = L.polyline(measurePoints, {
            pane: 'measurePane',
            color: '#ffe600',
            weight: 2,
            opacity: 1,
            interactive: false,
            className: 'radar-measure-path'
        }).addTo(measureLayers);
    } else {
        measurePath.setLatLngs(measurePoints);
    }

    if (previousPoint) {
        const segment = measureSegmentData(previousPoint, nextPoint);
        measureTotalNM += segment.distanceNM;
        L.marker(measureMidpoint(previousPoint, nextPoint), {
            pane: 'measurePane',
            interactive: false,
            keyboard: false,
            icon: L.divIcon({
                className: 'radar-measure-label-icon',
                html: `<span class="radar-measure-label">${segment.label}</span>`,
                iconSize: null
            })
        }).addTo(measureLayers);
    }

    updateMeasureStatus();
});

map.on('dblclick', function(e) {
    if (!measureActive) return;
    if (e.originalEvent) L.DomEvent.preventDefault(e.originalEvent);
    setMeasureActive(false);
    updateMeasureStatus();
});

document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && measureActive) {
        setMeasureActive(false);
        updateMeasureStatus();
    }
});
