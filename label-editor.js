import { DEFAULT_LABEL_OFFSET, getLabelOffset, getWaypointLabel, waypoints } from './waypoints.js';
import { L } from './leaflet.js';
import { map } from './map.js';

// Waypoint label editing, selection, and offset export.

// ---------------------------------------------------------------
// Label editor internals (only wired up when EDITOR_MODE is true)
// ---------------------------------------------------------------
const editableLabels = {};   // fixName -> { marker, dx, dy, originalDx, originalDy }

// "Changed since page load" per fix -- purely for the yellow
// is-dirty highlight so you can see what you've touched *this
// session*. This is NOT what export uses: export always
// re-derives its list from DEFAULT_LABEL_OFFSET (see
// getAllModifiedFixNames()), so a fix that arrived already-
// modified from labelOffsets.json but wasn't touched this session
// still gets exported, even though it never appears in this set.
const editorDirty = new Set();
let editorSelection = new Set();
let editorPane = null;

function refreshEditableLabelText(fixName) {
    const entry = editableLabels[fixName];
    if (!entry) return;
    const el = entry.marker.getElement();
    const textEl = el && el.querySelector('.editable-label-text');
    if (textEl) textEl.textContent = getWaypointLabel(fixName);
}

function makeEditableLabelIcon(fixName, dx, dy) {
    const label = getWaypointLabel(fixName);
    // -100% (bottom edge at marker point) reproduces _setPosition's
    // subY = tooltipHeight math. The extra -6px reproduces
    // leaflet.css's .leaflet-tooltip-top { margin-top: -6px },
    // which is a separate CSS shift Leaflet applies on top of that
    // for the direction:'top' arrow-pointer accommodation --
    // without it the box sits 6px too low relative to the real
    // tooltip. Confirmed against leaflet@1.9.4's actual source/CSS,
    // not inferred.
    return L.divIcon({
        className: 'editable-label-icon',
        html: `<div class="editable-label-base" style="transform: translate(-50%, calc(-100% - 6px));"><span class="editable-label-text" data-fix="${fixName}" style="transform: translate(${dx}px, ${dy}px);">${label}</span></div>`,
        iconSize: [0, 0],
        iconAnchor: [0, 0]
    });
}

function updateEditableLabelTransform(fixName) {
    const entry = editableLabels[fixName];
    if (!entry) return;
    const el = entry.marker.getElement();
    const textEl = el && el.querySelector('.editable-label-text');
    if (textEl) textEl.style.transform = `translate(${entry.dx}px, ${entry.dy}px)`;
}

function markEditableLabelDirty(fixName) {
    const entry = editableLabels[fixName];
    if (!entry) return;
    const isDirty = entry.dx !== entry.originalDx || entry.dy !== entry.originalDy;
    if (isDirty) editorDirty.add(fixName); else editorDirty.delete(fixName);
    const el = entry.marker.getElement();
    const textEl = el && el.querySelector('.editable-label-text');
    if (textEl) textEl.classList.toggle('is-dirty', isDirty);
}

function setLabelSelected(fixName, selected) {
    const entry = editableLabels[fixName];
    if (!entry) return;
    const el = entry.marker.getElement();
    const textEl = el && el.querySelector('.editable-label-text');
    if (textEl) textEl.classList.toggle('is-selected', selected);
    if (selected) editorSelection.add(fixName); else editorSelection.delete(fixName);
}

function clearEditorSelection() {
    editorSelection.forEach(fixName => setLabelSelected(fixName, false));
    editorSelection.clear();
}

function selectOnly(fixName) {
    clearEditorSelection();
    setLabelSelected(fixName, true);
    refreshEditorHud();
}

function toggleSelection(fixName) {
    setLabelSelected(fixName, !editorSelection.has(fixName));
    refreshEditorHud();
}

// Binds drag + click/multiselect behavior to a waypoint's marker
// and creates its paired draggable label marker. Called once per
// fix from initWaypointsAndProcedures() when EDITOR_MODE is true.
function bindEditableLabel(waypointMarker, fixName) {
    const [dx, dy] = getLabelOffset(fixName);
    const labelMarker = L.marker(waypoints[fixName], {
        icon: makeEditableLabelIcon(fixName, dx, dy),
        pane: 'editorLabelsPane',
        draggable: true,
        autoPan: true
    }).addTo(map);

    editableLabels[fixName] = {
        marker: labelMarker,
        dx, dy,
        originalDx: dx, originalDy: dy
    };

    let dragStartOffsets = null; // fixName -> [dx,dy] for every selected label, captured at dragstart

    labelMarker.on('dragstart', () => {
        // Dragging a label that isn't part of the current
        // selection replaces the selection with just that label;
        // dragging a label that IS selected drags the whole
        // group together.
        if (!editorSelection.has(fixName)) selectOnly(fixName);

        const el = labelMarker.getElement();
        const textEl = el && el.querySelector('.editable-label-text');
        if (textEl) textEl.classList.add('is-dragging');

        dragStartOffsets = {};
        editorSelection.forEach(selFix => {
            const e = editableLabels[selFix];
            dragStartOffsets[selFix] = [e.dx, e.dy];
        });
        editableLabels[fixName]._dragAnchorContainerPoint = map.latLngToContainerPoint(labelMarker.getLatLng());
    });

    labelMarker.on('drag', () => {
        const anchor = editableLabels[fixName]._dragAnchorContainerPoint;
        const newPoint = map.latLngToContainerPoint(labelMarker.getLatLng());
        const dxDelta = newPoint.x - anchor.x;
        const dyDelta = newPoint.y - anchor.y;

        editorSelection.forEach(selFix => {
            const entry = editableLabels[selFix];
            const start = dragStartOffsets[selFix];
            if (!start) return;
            entry.dx = Math.round(start[0] + dxDelta);
            entry.dy = Math.round(start[1] + dyDelta);
            updateEditableLabelTransform(selFix);
            // Every selected label's own marker LatLng must stay
            // pinned to its waypoint -- only the dragged marker
            // actually moves geographically during a Leaflet
            // drag, so snap it back and let the CSS transform
            // carry the visual offset instead.
            if (selFix === fixName) {
                entry.marker.setLatLng(waypoints[fixName]);
            }
        });
        refreshEditorHud();
    });

    labelMarker.on('dragend', () => {
        const el = labelMarker.getElement();
        const textEl = el && el.querySelector('.editable-label-text');
        if (textEl) textEl.classList.remove('is-dragging');
        editorSelection.forEach(selFix => markEditableLabelDirty(selFix));
        refreshEditorHud();
    });

    labelMarker.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        const additive = e.originalEvent.shiftKey || e.originalEvent.ctrlKey || e.originalEvent.metaKey;
        if (additive) {
            toggleSelection(fixName);
        } else {
            selectOnly(fixName);
        }
    });
}

// Nudges every currently-selected label by [ddx, ddy] pixels.
function nudgeSelection(ddx, ddy) {
    if (editorSelection.size === 0) return;
    editorSelection.forEach(fixName => {
        const entry = editableLabels[fixName];
        if (!entry) return;
        entry.dx += ddx;
        entry.dy += ddy;
        updateEditableLabelTransform(fixName);
        markEditableLabelDirty(fixName);
    });
    refreshEditorHud();
}

function resetSelection() {
    if (editorSelection.size === 0) return;
    editorSelection.forEach(fixName => {
        const entry = editableLabels[fixName];
        if (!entry) return;
        entry.dx = entry.originalDx;
        entry.dy = entry.originalDy;
        updateEditableLabelTransform(fixName);
        markEditableLabelDirty(fixName);
    });
    refreshEditorHud();
}

// A fix counts as "ever modified" if its current offset differs
// from the true hardcoded default, regardless of whether it was
// touched in this session or arrived already-modified from a
// previously loaded labelOffsets.json.
function isModifiedFromDefault(fixName) {
    const entry = editableLabels[fixName];
    if (!entry) return false;
    return entry.dx !== DEFAULT_LABEL_OFFSET[0] || entry.dy !== DEFAULT_LABEL_OFFSET[1];
}

function getAllModifiedFixNames() {
    return Object.keys(editableLabels).filter(isModifiedFromDefault);
}

function exportLabelOffsets() {
    const modified = getAllModifiedFixNames();
    if (modified.length === 0) {
        alert('No label offsets differ from the default -- nothing to export.');
        return;
    }
    const out = {};
    modified.forEach(fixName => {
        const entry = editableLabels[fixName];
        out[fixName] = [entry.dx, entry.dy];
    });
    // Match data/labelOffsets.json: one waypoint and coordinate pair per line.
    const json = `{\n${Object.entries(out)
        .map(([fixName, offset]) => `  ${JSON.stringify(fixName)}: ${JSON.stringify(offset)}`)
        .join(',\n')}\n}\n`;
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'labelOffsets.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    // Re-baseline every exported fix's "original" (session-load)
    // value to what was just saved, so the is-dirty highlight
    // reflects "changed since last export" going forward. This
    // does NOT affect what counts as exportable next time --
    // that's always re-derived from DEFAULT_LABEL_OFFSET, so
    // fixes that are still non-default keep being included in
    // every future export even if untouched since the last one.
    modified.forEach(fixName => {
        const entry = editableLabels[fixName];
        entry.originalDx = entry.dx;
        entry.originalDy = entry.dy;
        markEditableLabelDirty(fixName);
    });
    refreshEditorHud();
}

// ---------------------------------------------------------------
// HUD: dirty/selection counts, the selection's current offset
// value, and Reset/Export buttons. Built once with a fixed
// structure and stable child element IDs so refreshEditorHud()
// can just update text content on every call without re-creating
// (and re-listener-ing) the buttons each time.
// ---------------------------------------------------------------
let editorHudEl = null;

function buildEditorHud() {
    editorHudEl.innerHTML = `
        <span class="hud-title">LABEL EDITOR</span>
        <span class="hud-count">Selected: <span class="n" id="hud-selected-count">0</span></span>
        <span class="hud-count">Modified: <span class="n" id="hud-dirty-count">0</span></span>
        <span class="hud-offset" id="hud-offset-wrap" style="display:none;">Offset: <span class="n" id="hud-offset-value">--</span></span>
        <button type="button" class="hud-btn" id="hud-reset-btn" disabled>Reset Selection</button>
        <button type="button" class="hud-btn save-btn" id="hud-export-btn">Export labelOffsets.json</button>
        <span class="hud-hint">Click/Shift+Click select &middot; Drag box multiselect &middot; Arrows nudge (Shift = 10px) &middot; Esc clear selection</span>
    `;
    document.getElementById('hud-reset-btn').addEventListener('click', () => resetSelection());
    document.getElementById('hud-export-btn').addEventListener('click', () => exportLabelOffsets());
}

function refreshEditorHud() {
    if (!editorHudEl) return;

    document.getElementById('hud-selected-count').textContent = editorSelection.size;
    document.getElementById('hud-dirty-count').textContent = getAllModifiedFixNames().length;
    document.getElementById('hud-reset-btn').disabled = editorSelection.size === 0;

    const offsetWrap = document.getElementById('hud-offset-wrap');
    const offsetValue = document.getElementById('hud-offset-value');
    if (editorSelection.size === 1) {
        const fixName = [...editorSelection][0];
        const entry = editableLabels[fixName];
        offsetValue.textContent = `${fixName} [${entry.dx}, ${entry.dy}]`;
        offsetWrap.style.display = '';
    } else if (editorSelection.size > 1) {
        // Multiple labels selected, possibly at different offsets
        // (e.g. only some were nudged/dragged before extending the
        // selection) -- show each one so it's unambiguous rather
        // than picking one arbitrarily. Capped so a huge rubber-
        // band selection doesn't blow out the HUD bar.
        const selected = [...editorSelection];
        const MAX_SHOWN = 6;
        const parts = selected.slice(0, MAX_SHOWN).map(fixName => {
            const entry = editableLabels[fixName];
            return `${fixName} [${entry.dx}, ${entry.dy}]`;
        });
        if (selected.length > MAX_SHOWN) {
            parts.push(`+${selected.length - MAX_SHOWN} more`);
        }
        offsetValue.textContent = parts.join('  ·  ');
        offsetWrap.style.display = '';
    } else {
        offsetWrap.style.display = 'none';
    }
}

// ---------------------------------------------------------------
// Rubber-band multiselect: mousedown+drag on empty map area draws
// a selection box; on mouseup, every label whose screen position
// falls inside it gets selected.
// ---------------------------------------------------------------
function initRubberBandSelect() {
    const container = map.getContainer();
    let selecting = false;
    let startPoint = null;
    let boxEl = null;

    container.addEventListener('mousedown', (e) => {
        // Only start a rubber-band if the mousedown didn't land on
        // a label itself (labels handle their own click/drag).
        if (e.target.closest('.editable-label-text')) return;
        if (e.button !== 0) return;

        selecting = true;
        startPoint = { x: e.clientX, y: e.clientY };
        boxEl = document.createElement('div');
        boxEl.className = 'editor-select-box';
        document.body.appendChild(boxEl);
        map.dragging.disable(); // don't pan the map while box-selecting
    });

    window.addEventListener('mousemove', (e) => {
        if (!selecting) return;
        const x = Math.min(startPoint.x, e.clientX);
        const y = Math.min(startPoint.y, e.clientY);
        const w = Math.abs(e.clientX - startPoint.x);
        const h = Math.abs(e.clientY - startPoint.y);
        boxEl.style.left = `${x}px`;
        boxEl.style.top = `${y}px`;
        boxEl.style.width = `${w}px`;
        boxEl.style.height = `${h}px`;
    });

    window.addEventListener('mouseup', (e) => {
        if (!selecting) return;
        selecting = false;
        map.dragging.enable();

        const rect = boxEl.getBoundingClientRect();
        boxEl.remove();
        boxEl = null;

        // A near-zero-size box means this was just a click, not a
        // drag -- treat it as "click on empty map = deselect".
        if (rect.width < 3 && rect.height < 3) {
            clearEditorSelection();
            refreshEditorHud();
            return;
        }

        const additive = e.shiftKey || e.ctrlKey || e.metaKey;
        if (!additive) clearEditorSelection();

        Object.keys(editableLabels).forEach(fixName => {
            const entry = editableLabels[fixName];
            const el = entry.marker.getElement();
            const textEl = el && el.querySelector('.editable-label-text');
            if (!textEl) return;
            const labelRect = textEl.getBoundingClientRect();
            const overlaps = !(labelRect.right < rect.left || labelRect.left > rect.right ||
                                labelRect.bottom < rect.top || labelRect.top > rect.bottom);
            if (overlaps) setLabelSelected(fixName, true);
        });
        refreshEditorHud();
    });
}

function initEditorKeyboard() {
    window.addEventListener('keydown', (e) => {
        // Ignore arrow keys / Escape while focus is in a text
        // input elsewhere on the page (e.g. the search box) so
        // normal typing/cursor movement isn't hijacked.
        const tag = document.activeElement && document.activeElement.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;

        const step = e.shiftKey ? 10 : 1;
        switch (e.key) {
            case 'ArrowUp': nudgeSelection(0, -step); e.preventDefault(); break;
            case 'ArrowDown': nudgeSelection(0, step); e.preventDefault(); break;
            case 'ArrowLeft': nudgeSelection(-step, 0); e.preventDefault(); break;
            case 'ArrowRight': nudgeSelection(step, 0); e.preventDefault(); break;
            case 'Escape': clearEditorSelection(); refreshEditorHud(); break;
        }
    });
}

function initLabelEditor() {
    editorHudEl = document.createElement('div');
    editorHudEl.className = 'editor-hud';
    document.body.appendChild(editorHudEl);
    buildEditorHud();
    refreshEditorHud();

    map.on('click', () => {
        clearEditorSelection();
        refreshEditorHud();
    });

    initRubberBandSelect();
    initEditorKeyboard();

    console.log(`Label editor mode active: ${Object.keys(editableLabels).length} editable labels. Click/drag to move, Shift/Ctrl/Cmd+click or drag-box to multiselect, arrow keys to nudge.`);
}

export { bindEditableLabel, editableLabels, initLabelEditor, refreshEditableLabelText };
