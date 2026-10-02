import { L } from './leaflet.js';
import { buildApproachRadar, holdingGroup, rwy13L, rwy13R, rwy31L, rwy31R, sid13Group, sid31Group, star13Group, star31Group, waypointsGroup } from './map.js';
import { EDITOR_MODE } from './config.js';
import { bindEditableLabel, editableLabels, initLabelEditor, refreshEditableLabelText } from './label-editor.js';
import { buildProcedures } from './procedures.js';
import { getOffsetPoint } from './geo.js';

// Waypoint data, markers, labels, filters, and procedure initialization.

// 6. Define Triangle Icon for fixes
const triangleIcon = L.divIcon({
    className: 'wp-triangle-icon',
    html: '<svg width="10" height="10" viewBox="0 0 10 10" style="display:block;"><polygon points="5,1 9,9 1,9" fill="#000000" stroke="#8A8A8A" stroke-width="1.5"/></svg>',
    iconSize: [10, 10],
    iconAnchor: [5, 5]
});

// Track and map reference instances of Waypoint Markers for search hooks
const waypointMarkers = {};

// Merged runtime waypoint lookup: local/procedure points + AIP-published
// named fixes (fetched from data/waypoints.json). Populated by
// initWaypointsAndProcedures() before any code below reads from it.
let waypoints = {};

// Per-fix label offset overrides, in CSS pixels [dx, dy] relative
// to the original tooltip's direction:'top' base anchor (centered
// above the marker, offset:[0,8] by default -- see
// getLabelOffset()). Loaded from data/labelOffsets.json if
// present; falls back to {} (every fix uses the default) if the
// file is missing, since not every deployment will have run the
// editor yet.
let labelOffsets = {};

// The true, hardcoded default offset -- what a fix uses when it
// has never been touched by the editor at all. This is the
// baseline "modified vs not" is measured against for export,
// independent of whatever labelOffsets.json happened to already
// contain when this session started.
const DEFAULT_LABEL_OFFSET = [0, 8];

function getLabelOffset(fixName) {
    return labelOffsets[fixName] || DEFAULT_LABEL_OFFSET;
}

// Waypoint filter definitions
		const RWY31_FILTER = [
    /^BP8\d\d$/,
    "BP328","BP329","BP331","BEREV","ODVAS","NICRA","ATICO","FUTNA","OFENA"
];

const RWY13_FILTER = [
    /^BP7\d\d$/,
			"HUZTA","ALZUR","CATUZ","ECMAN","TORAZ","GIFRA"
];

function matchesWaypointFilter(name, rules) {
    return rules.some(rule =>
        rule instanceof RegExp ? rule.test(name) : rule === name
    );
}


// Returns the display label for a waypoint, optionally stripping a
// leading "BP" prefix (internal procedure-point naming convention)
// when the "STRIP BP PREFIX" checkbox is checked.
function getWaypointLabel(fixName) {
    const stripBp = document.getElementById('strip-bp-prefix').checked;
    if (stripBp && /^BP/.test(fixName)) {
        return fixName.slice(2);
    }
    return fixName;
}

async function initWaypointsAndProcedures() {
    try {
        const response = await fetch('data/waypoints.json');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        waypoints = await response.json();
        console.log(`Waypoint database loaded: ${Object.keys(waypoints).length} fixes.`);
    } catch (err) {
        console.error("Waypoint database (data/waypoints.json) failed to load:", err);
    }

    try {
        const offsetsResponse = await fetch('data/labelOffsets.json');
        if (offsetsResponse.ok) {
            labelOffsets = await offsetsResponse.json();
            console.log(`Label offsets loaded: ${Object.keys(labelOffsets).length} overrides.`);
        }
    } catch (err) {
        console.warn("Label offsets (data/labelOffsets.json) unavailable, using defaults:", err);
    }

    Object.keys(waypoints).forEach(fixName => {
        // interactive:false -- these triangle markers have never
        // had any click/hover behavior bound to them (bindEditableLabel
        // creates its own separate, draggable labelMarker and never
        // reads this one back). They were only clickable because
        // overlayPane's canvas above them silently absorbed clicks
        // before they could reach any layer; now that that canvas
        // passes events through, this default needs to be explicit.
        const marker = L.marker(waypoints[fixName], { icon: triangleIcon, interactive: false })
         .addTo(waypointsGroup);

        if (EDITOR_MODE) {
            bindEditableLabel(marker, fixName);
        } else {
            marker.bindTooltip(getWaypointLabel(fixName), {
                permanent: true,
                direction: 'top',
                className: 'fix-label',
                offset: getLabelOffset(fixName)
            });
        }

        waypointMarkers[fixName] = marker;
    });

    if (EDITOR_MODE) initLabelEditor();

    buildApproachRadar(rwy13R, 312.5, "13R");
    buildApproachRadar(rwy13L, 312.5, "13L");
    buildApproachRadar(rwy31L, 132.5, "31L");
    buildApproachRadar(rwy31R, 132.5, "31R");

    try {
        const response = await fetch('data/procedures.json');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const procedures = await response.json();
        buildProcedures({
            L, waypoints, procedures, getOffsetPoint,
            rwy13R, rwy13L, rwy31L, rwy31R,
            sid31Group, sid13Group, star31Group, star13Group, holdingGroup
        });
    } catch (err) {
        console.error("Procedure database (data/procedures.json) failed to load:", err);
    }
}

// ==========================================
// Waypoint 7XX/8XX Filters: hide BP7xx or BP8xx
// procedure points (e.g. to declutter the display
// to whichever runway direction is currently in use).
// ==========================================
		function updateWaypointFilters() {
			const hide13 = document.getElementById('filter-waypoints-7xx').checked;
			const hide31 = document.getElementById('filter-waypoints-8xx').checked;

			Object.keys(waypointMarkers).forEach(fixName => {
				const marker = waypointMarkers[fixName];

				const is13 = matchesWaypointFilter(fixName, RWY13_FILTER);
				const is31 = matchesWaypointFilter(fixName, RWY31_FILTER);

				const shouldHide =
					(hide13 && is13) ||
					(hide31 && is31);

				if (shouldHide) {
					if (waypointsGroup.hasLayer(marker))
						waypointsGroup.removeLayer(marker);
				} else {
					if (!waypointsGroup.hasLayer(marker))
						marker.addTo(waypointsGroup);
				}
			});
		}

document.getElementById('filter-waypoints-7xx').addEventListener('change', updateWaypointFilters);
document.getElementById('filter-waypoints-8xx').addEventListener('change', updateWaypointFilters);

// Input Engine Hooks monitoring search field typing events (Real-time tracking of FIX labels)
document.getElementById('radar-search').addEventListener('input', function(e) {
    if (EDITOR_MODE) return; // labels aren't tooltips in editor mode
    const query = e.target.value.toUpperCase().trim();
    
    Object.keys(waypointMarkers).forEach(fixName => {
        const marker = waypointMarkers[fixName];
        const label = getWaypointLabel(fixName);
        if (query && fixName.includes(query)) {
            marker.setTooltipContent(`<span style="color: #FFFF00; font-weight: bold;">${label}</span>`);
        } else {
            marker.setTooltipContent(label);
        }
    });
});

// Refresh all waypoint labels when the BP-prefix-stripping preference changes
document.getElementById('strip-bp-prefix').addEventListener('change', function() {
    if (EDITOR_MODE) {
        Object.keys(editableLabels).forEach(fixName => refreshEditableLabelText(fixName));
        return;
    }
    const query = document.getElementById('radar-search').value.toUpperCase().trim();
    Object.keys(waypointMarkers).forEach(fixName => {
        const marker = waypointMarkers[fixName];
        const label = getWaypointLabel(fixName);
        if (query && fixName.includes(query)) {
            marker.setTooltipContent(`<span style="color: #FFFF00; font-weight: bold;">${label}</span>`);
        } else {
            marker.setTooltipContent(label);
        }
    });
});

export { DEFAULT_LABEL_OFFSET, getLabelOffset, getWaypointLabel, initWaypointsAndProcedures, waypoints };
