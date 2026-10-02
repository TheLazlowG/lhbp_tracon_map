import { APP_VIEW_ZOOM, GND_VIEW_ZOOM, INITIAL_VIEW_CENTER, TWR_VIEW_ZOOM, extensions13Group, extensions31Group, groundFeaturesGroup, holdingGroup, map, sid13Group, sid31Group, star13Group, star31Group, trafficGroup, waypointsGroup } from './map.js';
import { applyFiltering } from './traffic.js';

// Settings panels, view presets, runway direction, and layer controls.

// ==========================================
// Modern Settings Launcher / Independent Panels
// ==========================================
const uiWrapper = document.getElementById('radar-ui-wrapper');
const launcherButtons = document.querySelectorAll('.radar-launch-btn[data-panel]');
const uiPanels = document.querySelectorAll('.radar-ui-panel[data-panel-view]');

function closeAllSettings() {
    uiPanels.forEach(panel => panel.classList.remove('is-open'));
    launcherButtons.forEach(btn => btn.classList.remove('active'));
}

launcherButtons.forEach(btn => {
    btn.addEventListener('click', function() {
        const name = btn.dataset.panel;
        const panel = document.querySelector(`.radar-ui-panel[data-panel-view="${name}"]`);
        const wasOpen = panel && panel.classList.contains('is-open');
        closeAllSettings();
        if (!wasOpen && panel) {
            panel.classList.add('is-open');
            btn.classList.add('active');
        }
    });
});

document.querySelectorAll('.radar-panel-close').forEach(btn => {
    btn.addEventListener('click', closeAllSettings);
});

// ==========================================
// View Presets
// ==========================================
function setCheckbox(id, checked) {
    const el = document.getElementById(id);
    if (!el) return;
    el.checked = checked;
    el.dispatchEvent(new Event('change'));
}

document.querySelectorAll('[data-view-preset]').forEach(btn => {
    btn.addEventListener('click', function() {
        document.querySelectorAll('[data-view-preset]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const preset = btn.dataset.viewPreset;
        if (preset === 'APP') {
            map.setView(INITIAL_VIEW_CENTER, APP_VIEW_ZOOM);
            setCheckbox('layer-ground-features', false);
            setCheckbox('layer-stands', false);
            setCheckbox('show-ground-traffic', false);
            setCheckbox('layer-airspace-all', true);
        } else if (preset === 'TWR') {
            map.setView(INITIAL_VIEW_CENTER, TWR_VIEW_ZOOM);
            setCheckbox('layer-ground-features', true);
            setCheckbox('layer-stands', true);
            setCheckbox('show-ground-traffic', true);
            setCheckbox('layer-airspace-all', false);
        } else if (preset === 'GND') {
            map.setView(INITIAL_VIEW_CENTER, GND_VIEW_ZOOM);
            setCheckbox('layer-ground-features', true);
            setCheckbox('layer-stands', true);
            setCheckbox('show-ground-traffic', true);
            setCheckbox('layer-airspace-all', false);
        }
    });
});

// ==========================================
// Runway Direction Toggle + preset-state indicator
// ==========================================
let currentRwyDirection = "31";
let rwyApplyingPreset = false;
const rwyDirectionBtn = document.getElementById('rwy-direction-btn');
const rwyPresetIds = ['layer-extensions-13','layer-extensions-31','layer-sid13','layer-sid31','layer-star13','layer-star31','filter-waypoints-8xx','filter-waypoints-7xx'];

function setRwyPristine(pristine) {
    rwyDirectionBtn.classList.toggle('rwy-pristine', pristine);
    rwyDirectionBtn.classList.toggle('rwy-modified', !pristine);
}

function applyRwyDirection(direction) {
    currentRwyDirection = direction;
    rwyApplyingPreset = true;
    rwyDirectionBtn.querySelector('span').textContent = direction;
    const is13 = direction === "13";
    setCheckbox('layer-extensions-13', is13);
    setCheckbox('layer-extensions-31', !is13);
    setCheckbox('layer-sid13', is13);
    setCheckbox('layer-sid31', !is13);
    setCheckbox('layer-star13', is13);
    setCheckbox('layer-star31', !is13);
    setCheckbox('filter-waypoints-8xx', is13);
    setCheckbox('filter-waypoints-7xx', !is13);
    rwyApplyingPreset = false;
    setRwyPristine(true);
}

rwyDirectionBtn.addEventListener('click', function() {
    applyRwyDirection(currentRwyDirection === "13" ? "31" : "13");
});

rwyPresetIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', function() {
        if (!rwyApplyingPreset) setRwyPristine(false);
    });
});

// ==========================================
// ATC Radio Links -> Open in a small popup window
// ==========================================
const ATC_POPUP_WIDTH = 420;
const ATC_POPUP_HEIGHT = 320;

document.querySelectorAll('[data-atc-popup]').forEach(function(link) {
    link.addEventListener('click', function(e) {
        e.preventDefault();
        const url = link.getAttribute('href');

        const left = Math.round((window.screen.width - ATC_POPUP_WIDTH) / 2);
        const top = Math.round((window.screen.height - ATC_POPUP_HEIGHT) / 2);
        const features = `width=${ATC_POPUP_WIDTH},height=${ATC_POPUP_HEIGHT},left=${left},top=${top},` +
            `resizable=yes,scrollbars=yes,toolbar=no,location=no,menubar=no,status=no`;

        const popupName = 'lhbp_atc_' + link.textContent.trim().replace(/[^A-Za-z0-9]+/g, '_');
        const popup = window.open(url, popupName, features);
        if (popup) {
            popup.focus();
        } else {
            // Popup blocked by browser -> fall back to a normal new tab
            window.open(url, '_blank', 'noopener,noreferrer');
        }
    });
});

// UI Layer Visibility Selectors
const toggles = {
    'layer-traffic': trafficGroup,
    'layer-waypoints': waypointsGroup,
    'layer-extensions-13': extensions13Group,
    'layer-extensions-31': extensions31Group,
    'layer-holding': holdingGroup,
    'layer-ground-features': groundFeaturesGroup,
    'layer-sid31': sid31Group,
    'layer-sid13': sid13Group,
    'layer-star31': star31Group,
    'layer-star13': star13Group
};

Object.keys(toggles).forEach(id => {
    const checkbox = document.getElementById(id);
    if (checkbox && checkbox.checked) {
        map.addLayer(toggles[id]);
    } else if (checkbox && !checkbox.checked) {
        map.removeLayer(toggles[id]);
    }

    if (checkbox) {
        checkbox.addEventListener('change', function(e) {
            if (e.target.checked) {
                map.addLayer(toggles[id]);
            } else {
                map.removeLayer(toggles[id]);
            }
            if (id === 'layer-traffic') {
                applyFiltering();
            }
        });
    }
});


function initOnOffControls() {
    function syncOnOff(btn, input) {
        const state = btn.querySelector('.onoff-state');
        if (!state) return;
        state.textContent = input.checked ? 'ON' : 'OFF';
        state.classList.toggle('ON', input.checked);
        state.classList.toggle('OFF', !input.checked);
    }
    document.querySelectorAll('.radar-onoff-control').forEach(btn => {
        const input = document.getElementById(btn.dataset.checkboxId);
        if (!input) return;
        syncOnOff(btn, input);
        input.addEventListener('change', () => syncOnOff(btn, input));
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            input.checked = !input.checked;
            input.dispatchEvent(new Event('change', {bubbles:true}));
        });
    });

    // Keep the real waypoint layer enabled on initial load; its existing
    // application logic remains responsible for subsequent view/filter changes.
    const waypointInput = document.getElementById('layer-waypoints');
    if (waypointInput) waypointInput.checked = true;
}

export { applyRwyDirection, currentRwyDirection, initOnOffControls };
