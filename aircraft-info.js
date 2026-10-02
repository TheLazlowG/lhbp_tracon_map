import { findICAORange } from './leaflet.js';
import { aircraftState } from './traffic.js';

// Airline directory, registration metadata, and aircraft information panel.

// ==========================================
// Telephony Translation Cache & Utilities
// ==========================================
const AIRLINE_TELEPHONY = {
		"JSD":"ALPOK","SXS":"SUNEXPRESS","AFR":"AIR FRANCE"
};
const AIRLINE_DIRECTORY = {};

// Asynchronously fetch and map thousands of dynamic airline designators on application startup
async function initAirlineDatabase() {
    try {
        const response = await fetch('data/callsigns.json');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const data = await response.json();
        // data/callsigns.json is an object keyed by ICAO code, e.g.
        // { "AAD": { "callsign": "PANABEAR", "company": "...", "country": "..." }, ... }
        Object.keys(data).forEach(icaoKey => {
            const entry = data[icaoKey];
            const key = icaoKey.toUpperCase().trim();
            AIRLINE_DIRECTORY[key] = entry;
            // The database signals "no telephony designator known" as
            // the literal string "(None)" (parentheses included).
            // Strip any surrounding parens before comparing so this
            // also catches "None", "NONE", etc. if the format varies.
            const normalizedCallsign = entry && entry.callsign
                ? entry.callsign.trim().toUpperCase().replace(/^\(|\)$/g, '')
                : '';
            if (entry && entry.callsign && normalizedCallsign !== "NONE") {
                // Prefer predefined script callsigns if they already exist
                if (!AIRLINE_TELEPHONY[key]) {
                    AIRLINE_TELEPHONY[key] = entry.callsign.toUpperCase().trim();
                }
            }
        });
        console.log(`Local callsign database loaded. ${Object.keys(AIRLINE_TELEPHONY).length} telephony profiles.`);
    } catch (err) {
        console.warn("Local callsign directory (data/callsigns.json) unresolvable, relying on expanded core cache:", err);
    }
}

function getAirlineOperator(callsign) {
    const normalized = String(callsign || '').trim().toUpperCase();
    // Airline flight identifiers normally begin with a three-letter
    // ICAO designator followed by a flight number. Requiring a digit
    // avoids treating registration-like callsigns as airline flights.
    if (!/^[A-Z]{3}(?=.*\d)/.test(normalized)) return '';
    const entry = AIRLINE_DIRECTORY[normalized.substring(0, 3)];
    if (!entry || !entry.company) return '';
    const company = String(entry.company).trim();
    return /^\(?none\)?$/i.test(company) ? '' : company;
}

function getRegistrationCountry(hex) {
    const normalized = String(hex || '').trim().toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(normalized) || typeof findICAORange !== 'function') return '';
    const range = findICAORange(normalized);
    return range && range.country !== 'Unassigned' ? range.country : '';
}

// Helper function to format short ICAO callsign to controller spoken telephony
function getFormattedCallsign(callsign, useLongFormat) {
    if (!useLongFormat || !callsign) return callsign;
    
    if (/^[A-Za-z]{5}/.test(callsign.trim())) {
        return callsign;
    }
    
    const prefix = callsign.substring(0, 3).toUpperCase();
    if (AIRLINE_TELEPHONY[prefix]) {
        return AIRLINE_TELEPHONY[prefix] + " " + callsign.substring(3);
    }
    // No known telephony translation for this prefix: keep the
    // original callsign, just separated with a space (e.g.
    // "XTS6UY" -> "XTS 6UY") instead of inventing a placeholder.
    if (/^[A-Za-z]{3}/.test(callsign.trim())) {
        return prefix + " " + callsign.substring(3);
    }
    return callsign;
}

// ---- Aircraft Info Panel ------------------------------------------
// Opens on datablock click. Shows registration/type/squawk pulled
// from the live ADS-B state, plus a photo looked up from
// planespotters.net's public (unofficial) photo endpoint, keyed by
// ICAO hex. Photo lookups are cached per hex for the page's
// lifetime so re-clicking the same aircraft doesn't refetch.
const aircraftInfoPanelEl = document.getElementById('aircraft-info-panel');
const aircraftInfoCallsignEl = document.getElementById('aircraft-info-callsign');
const aircraftInfoRegEl = document.getElementById('aircraft-info-reg');
const aircraftInfoTypeEl = document.getElementById('aircraft-info-type');
const aircraftInfoWakeEl = document.getElementById('aircraft-info-wake');
const aircraftInfoSquawkEl = document.getElementById('aircraft-info-squawk');
const aircraftInfoAltitudeEl = document.getElementById('aircraft-info-altitude');
const aircraftInfoSelectedAltitudeEl = document.getElementById('aircraft-info-selected-altitude');
const aircraftInfoSpeedEl = document.getElementById('aircraft-info-speed');
const aircraftInfoHeadingEl = document.getElementById('aircraft-info-heading');
const aircraftInfoSourceEl = document.getElementById('aircraft-info-source');
const aircraftInfoHexEl = document.getElementById('aircraft-info-hex');
const aircraftInfoPhotoWrapEl = document.getElementById('aircraft-info-photo-wrap');
const aircraftInfoPhotoPlaceholderEl = document.getElementById('aircraft-info-photo-placeholder');
const aircraftInfoCreditEl = document.getElementById('aircraft-info-credit');

let openAircraftInfoId = null;
const planespottersPhotoCache = new Map(); // hex -> {url, link, photographer} | null

// Squawk codes that denote an emergency/special condition, shown in
// red instead of the normal value color.
const EMERGENCY_SQUAWKS = new Set(['7500', '7600', '7700']);

// ICAO emergency squawk labels, shown as an extra blinking row on
// the datablock (see blockHTML in renderLoop) when a matching
// squawk is set.
const EMERGENCY_SQUAWK_LABELS = {
    '7500': 'HIJACK',
    '7600': 'NORDO',
    '7700': 'EMERGENCY'
};

function closeAircraftInfoPanel() {
    openAircraftInfoId = null;
    aircraftInfoPanelEl.classList.remove('open');
}

const aircraftMetadataCache = new Map();

async function fetchAircraftMetadata(hex, callsign) {
    if (!hex) return null;

    const normalizedHex = String(hex).trim().toLowerCase();
    const normalizedCallsign = String(callsign || '').trim().toUpperCase();
    const key = `${normalizedHex}|${normalizedCallsign}`;
    if (aircraftMetadataCache.has(key)) {
        return aircraftMetadataCache.get(key);
    }

    const callsignQuery = normalizedCallsign
        ? `?callsign=${encodeURIComponent(normalizedCallsign)}`
        : '';
    const promise = fetch(
        `https://api.adsbdb.com/v0/aircraft/${encodeURIComponent(normalizedHex)}${callsignQuery}`,
        {
            cache: 'force-cache',
            headers: { 'Accept': 'application/json' }
        }
    )
        .then(async response => {
            if (!response.ok) {
                throw new Error(`ADSBdb HTTP ${response.status}`);
            }
            const data = await response.json();
            return data && typeof data.response === 'object'
                ? data.response
                : null;
        })
        .catch(error => {
            console.warn('Aircraft metadata lookup failed:', error);
            // Do not retain a rejected/failed lookup for the whole
            // page lifetime; a later panel open may retry it.
            aircraftMetadataCache.delete(key);
            return null;
        });

    aircraftMetadataCache.set(key, promise);
    return promise;
}

async function enrichAircraftInfoPanel(id) {
    const state = aircraftState[id];
    if (!state) return;

    const requestedCallsign = String(state.callsign || '').trim().toUpperCase();
    const metadata = await fetchAircraftMetadata(id, requestedCallsign);
    if (!metadata || !aircraftState[id]) return;

    const current = aircraftState[id];
    const aircraftMetadata = metadata.aircraft || null;
    const airlineMetadata = metadata.flightroute?.airline || null;

    // Keep flight operator and registered owner separate. Country is
    // derived from the ICAO address allocation, not owner metadata.
    if (airlineMetadata?.name && String(current.callsign || '').trim().toUpperCase() === requestedCallsign) {
        current.metadataOperator = airlineMetadata.name;
        current.operator = current.operator || airlineMetadata.name;
    }
    if (aircraftMetadata?.registered_owner) {
        current.metadataRegisteredOwner = aircraftMetadata.registered_owner;
        current.registeredOwner = aircraftMetadata.registered_owner;
    }

    if (openAircraftInfoId === id) {
        renderAircraftInfoPanel(id);
    }
}

function renderAircraftInfoPanel(id) {
    const state = aircraftState[id];
    if (!state) return;

    aircraftInfoCallsignEl.textContent =
        (state.callsign || 'UNK').trim() || 'UNK';

    aircraftInfoRegEl.textContent =
        state.registration || 'UNKNOWN';

    document.getElementById('aircraft-info-country').textContent =
        state.country || 'UNKNOWN';

    document.getElementById('aircraft-info-operator').textContent =
        state.operator || 'UNKNOWN';

    document.getElementById('aircraft-info-owner').textContent =
        state.registeredOwner || 'UNKNOWN';

    aircraftInfoTypeEl.textContent =
        state.actype || 'UNK';

    document.getElementById('aircraft-info-type-name').textContent =
        state.typeName || 'UNKNOWN';

    const squawk = state.squawk || '----';
    aircraftInfoSquawkEl.textContent = squawk;
    aircraftInfoSquawkEl.classList.toggle(
        'squawk-emergency',
        EMERGENCY_SQUAWKS.has(state.squawk)
    );
}

function renderAircraftInfoPhoto(entry) {
    aircraftInfoPhotoWrapEl.innerHTML = '';
    if (entry && entry.url) {
        const link = document.createElement('a');
        link.href = entry.link || entry.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.style.display = 'block';
        link.style.width = '100%';
        const img = document.createElement('img');
        img.src = entry.url;
        img.alt = 'Aircraft photo';
        if (entry.width && entry.height) img.setAttribute('width', entry.width);
        if (entry.width && entry.height) img.setAttribute('height', entry.height);
        link.appendChild(img);
        aircraftInfoPhotoWrapEl.appendChild(link);
        if (entry.photographer) {
            aircraftInfoCreditEl.style.display = 'block';
            if (entry.link) {
                aircraftInfoCreditEl.innerHTML = `Photo: <a href="${entry.link}" target="_blank" rel="noopener">${entry.photographer}</a>`;
            } else {
                aircraftInfoCreditEl.textContent = `Photo: ${entry.photographer}`;
            }
        } else {
            aircraftInfoCreditEl.style.display = 'none';
            aircraftInfoCreditEl.innerHTML = '';
        }
    } else {
        const placeholder = document.createElement('span');
        placeholder.className = 'aircraft-info-panel-photo-placeholder';
        placeholder.textContent = 'NO PHOTO';
        aircraftInfoPhotoWrapEl.appendChild(placeholder);
        aircraftInfoCreditEl.style.display = 'none';
        aircraftInfoCreditEl.innerHTML = '';
    }
}

// Looks up a photo for the given ICAO hex via planespotters.net's
// public photo endpoint (the same unofficial endpoint used by
// globe.adsbexchange.com / tar1090-family ADS-B front ends). Falls
// back to no photo on any error or unexpected response shape.
async function fetchPlanespottersPhoto(hex, reg, actype) {
    if (planespottersPhotoCache.has(hex)) {
        return planespottersPhotoCache.get(hex);
    }
    try {
        const params = new URLSearchParams();
        if (reg) params.set('reg', reg);
        if (actype && actype !== 'UNK') params.set('icaoType', actype);
        const qs = params.toString();
        const url = `https://api.planespotters.net/pub/photos/hex/${encodeURIComponent(hex)}${qs ? '?' + qs : ''}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const photo = Array.isArray(data.photos) && data.photos.length > 0 ? data.photos[0] : null;
        let entry = null;
        if (photo) {
            const src = (photo.image && photo.image.src)
                || (photo.thumbnail_large && photo.thumbnail_large.src)
                || (photo.thumbnail && photo.thumbnail.src)
                || null;
            if (src) {
                entry = {
                    url: src,
                    link: photo.link || null,
                    photographer: photo.photographer || null,
                    width: Number(photo.image?.width || photo.width || photo.thumbnail_large?.width || photo.thumbnail?.width) || null,
                    height: Number(photo.image?.height || photo.height || photo.thumbnail_large?.height || photo.thumbnail?.height) || null
                };
            }
        }
        planespottersPhotoCache.set(hex, entry);
        return entry;
    } catch (err) {
        console.warn('Planespotters photo lookup failed:', err.message);
        planespottersPhotoCache.set(hex, null);
        return null;
    }
}

function openAircraftInfoPanel(id) {
    const state = aircraftState[id];
    if (!state) return;

    openAircraftInfoId = id;
    aircraftInfoPanelEl.classList.add('open');
    renderAircraftInfoPanel(id);
    enrichAircraftInfoPanel(id);
    renderAircraftInfoPhoto(null);
    aircraftInfoPhotoPlaceholderEl.textContent = 'LOADING...';

    const hex = id;
    const reg = state.registration;
    const actype = state.actype;
    fetchPlanespottersPhoto(hex, reg, actype).then(entry => {
        // Only apply if the panel is still showing this aircraft
        // (avoids a slow response clobbering a later selection).
        if (openAircraftInfoId === id) {
            renderAircraftInfoPhoto(entry);
        }
    });
}

document.getElementById('aircraft-info-close').addEventListener('click', function(e) {
    e.stopPropagation();
    closeAircraftInfoPanel();
});
aircraftInfoPanelEl.addEventListener('click', function(e) {
    e.stopPropagation();
});

// Close the aircraft info panel whenever the user clicks elsewhere.
document.addEventListener('click', function(e) {
    if (!openAircraftInfoId) return;
    if (aircraftInfoPanelEl.contains(e.target)) return;
    const tooltip = e.target.closest && e.target.closest('.atc-label-clickable');
    if (tooltip) return;
    closeAircraftInfoPanel();
}, true);

export { EMERGENCY_SQUAWKS, EMERGENCY_SQUAWK_LABELS, closeAircraftInfoPanel, getAirlineOperator, getFormattedCallsign, getRegistrationCountry, initAirlineDatabase, openAircraftInfoId, openAircraftInfoPanel, renderAircraftInfoPanel };
