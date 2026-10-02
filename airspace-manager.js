// ==========================================================
// AirspaceManager
//
// Owns the entire airspace subsystem. PilotNet is the sole data
// source (no static GeoJSON): every record it returns is rendered
// as exactly one polygon. A record can carry a static
// classification entry (CTR, TMA, D, P, R, ...), a LARA_FUA
// entry, or both:
//   - static only: drawn and styled by its static type.
//   - static + LARA_FUA (matched): drawn ONCE, using the static
//     geometry, but STYLED by the LARA_FUA activation state
//     (scheduled/activated) instead of its static type. This is a
//     style substitution on the one polygon, not a second overlay.
//   - LARA_FUA only (no static match): treated as ADHOC. Still
//     drawn through the same pipeline, filed under its own
//     LARA_FUA_TYPE bucket, filtered by its own STATIC/SCHEDULED/
//     ACTIVATED row in the type filter matrix instead of a
//     dedicated ADHOC checkbox.
// Polls every 5 minutes; on each refresh only the airspaces that
// actually changed (added/removed/geometry/activation) are
// touched -- nothing is blindly redrawn.
//
// The main script creates one manager and calls its init() from bootApp.
// All airspace state, styles, rendering, and controls remain private.
// ==========================================================
function createAirspaceManager({ L, map, formatZuluTime }) {
    // Airspace boundary styles. Preserves the existing visual language
    // (red outlines for the highest-significance categories, neutral
    // gray for everything else) but is now applied by AirspaceManager
    // dynamically, keyed by the PilotNet record's own `type` value,
    // since the set of types is discovered from the live API data
    // rather than fixed in advance.
    const airspaceStyleByType = {
        // P (Prohibited) and R (Restricted) have no entry here --
        // they fall back to airspaceStyleDefault below (their SHOW
        // ACTIVATED-off style) since they're flagged permanently
        // active via isActive/isPublished (see AirspaceManager) and
        // get the shared LARA_FUA highlight style whenever SHOW
        // ACTIVATED is on, same as any matched LARA_FUA record.
        // D (Danger) also has no entry for now -- reverted to
        // airspaceStyleDefault until its styling is revisited.
        'FIR': { color: '#9E9E9E', weight: 1.4, opacity: 0.55, fill: false },
    };
    const airspaceStyleDefault = { color: '#9E9E9E', weight: 1, opacity: 0.8, fill: false };

    // LARA_FUA overlays are independent of the static airspace styling
    // above -- drawn as separate overlay polygons per spec, not merged
    // into or replacing the underlying static airspace's own style.
    const laraFuaPublishedStyle = { color: '#FFC107', weight: 1, opacity: 1, fill: true, fillColor: '#FFC107', fillOpacity: 0.05 };
    const laraFuaActiveStyle = { color: '#FF3B30', weight: 1, opacity: 1, fill: true, fillColor: '#FF3B30', fillOpacity: 0.1 };

    // Per-type hover highlight colors (AIRSPACE INFO, see
    // AirspaceManager's hover engine). Keyed by the exact `type`
    // values PilotNet's own TYPE list uses (confirmed against the
    // live filter panel): COUNTRY_CTA, CTA, CTR, D, DRONE_ZONE,
    // DROPZONE, GLDR, MCTR, MTMA, "NATURE RESERVE AREA", P, R, RAS,
    // TIZ, TMA, TRA, plus ADHOC for unmatched LARA_FUA-only records
    // (see LARA_FUA_TYPE). Distinct hue per type so hovering over a
    // stack of overlapping airspaces visually separates them at a
    // glance; falls back to airspaceHoverDefaultColor for any type
    // not listed here (e.g. a new type PilotNet starts sending).
    const airspaceHoverColorByType = {
        'NATURE RESERVE AREA': '#4CAF50', // green
        'TRA': '#FF9800',                 // orange
        'D': '#E91E63',                   // pink
        'TMA': '#2196F3',                 // blue
        'GLDR': '#1DE9B6',                // turquoise
        'DROPZONE': '#9C27B0',            // purple
        'CTR': '#FFEB3B',                 // yellow
        'CTA': '#03A9F4',                 // light blue
        'COUNTRY_CTA': '#3F51B5',         // indigo
        'MTMA': '#00BCD4',                // cyan
        'MCTR': '#CDDC39',                // lime
        'TIZ': '#FF5722',                 // deep orange
        'RAS': '#8BC34A',                 // light green
        'DRONE_ZONE': '#F44336',          // red
        'P': '#D32F2F',                   // dark red (Prohibited)
        'R': '#C62828',                   // dark red (Restricted)
        // Keyed by the LARA_FUA_TYPE constant's actual value
        // ('LARA_FUA'), not the "ADHOC" display label used for it in
        // buildAirspaceInfoEntryHTML/renderTypeFilterUI -- entry.type
        // for an unmatched LARA_FUA-only record is 'LARA_FUA' (see
        // getStaticType), so keying this by the string 'ADHOC' would
        // never actually match and would silently fall back to the
        // default color.
        'LARA_FUA': '#B39DDB',            // light purple
    };
    const airspaceHoverDefaultColor = '#E0E0E0';

    // Applied on top of a hovered airspace's normal style (see
    // AirspaceManager's hover engine) when AIRSPACE INFO is on.
    // Color varies by type (see airspaceHoverColorByType) so a stack
    // of overlapping airspaces is visually distinguishable at a
    // glance; weight/opacity/fill stay fixed across types.
    function airspaceHoverStyleForType(type) {
        const color = airspaceHoverColorByType[type] || airspaceHoverDefaultColor;
        return { color, weight: 2.5, opacity: 1, fill: true, fillColor: color, fillOpacity: 0.15 };
    }



    // ---- Config -------------------------------------------------

    const PILOTNET_URL = 'https://api.pilotnet.hu/rest/airspace';
    const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes, per spec
    const LARA_FUA_TYPE = 'LARA_FUA';

    // ---- State ----------------------------------------------------

    // Every airspace, static and adhoc alike: id -> {
    //   record, layer, type, signature, label
    // }. `signature` is a cheap fingerprint of the fields that
    // matter for redraw decisions (geometry + activation), so a
    // refresh can tell "unchanged" apart from "needs updating"
    // without a deep object diff every poll. A record that carries
    // a matched LARA_FUA entry keeps its static `type` here but is
    // STYLED by its LARA_FUA activation state (see
    // styleForAirspace) rather than getting a second overlaid
    // polygon. A record with no static classification at all --
    // only a LARA_FUA entry -- gets type === LARA_FUA_TYPE and is
    // treated as ADHOC (see isAdhocRecord).
    const airspaceIndex = new Map();

    // 0 is used only for the initial full snapshot. After that,
    // latestUpdatedAt becomes the Unix timestamp of the successful sync checkpoint.
    let latestUpdatedAt = 0;
    let hasInitialSnapshot = false;
    let pollTimer = null;
    let showAll = true;

    // Per-type visibility, replacing the old flat enabledTypes
    // Set plus the global showActivated/showScheduled/showAdhoc
    // booleans. Each discovered type (including LARA_FUA_TYPE,
    // i.e. ADHOC) gets its own { static, scheduled, activated }
    // triple, each independently hiding/showing a different
    // subset of that type's records (see isRecordVisible):
    //   static    - unpublished (plain, not currently published
    //               via LARA_FUA) records of this type.
    //   scheduled - published, NOT active records of this type.
    //   activated - published AND active records of this type.
    // Unchecking one only removes that subset -- e.g. turning off
    // `static` still leaves that type's scheduled/activated
    // (highlighted) records visible and independently toggleable.
    // null = "not yet populated" (before the first renderTypeFilterUI).
    let typeVisibility = null;
    const discoveredTypes = new Set();

    const DEFAULT_TYPE_VISIBILITY = Object.freeze({
        static: false,
        scheduled: true,
        activated: true
    });

    // ---- Altitude range filter -------------------------------------
    //
    // Two independent [low, high] bands, in feet, set by the Floor
    // Range / Ceiling Range dual sliders. An airspace is visible
    // only when its OWN floor sits inside floorMin..floorMax AND
    // its own ceiling sits inside ceilMin..ceilMax -- so e.g.
    // setting Floor to 0-0 and Ceiling to 60000-60000 isolates
    // airspace running from the surface to unlimited, while a
    // narrower Ceiling band (say 5000-10000) shows only airspace
    // topping out in that slice regardless of where it starts.
    // Bounds are in feet; UNBOUNDED_CEILING stands in for UNL
    // (no numeric top) so it sorts above any real slider value.
    const UNBOUNDED_CEILING = 999999;
    const ALTITUDE_FILTER_MAX_FT = 60000; // slider's top step (FL600)

    let altitudeFilter = {
        floorMin: 0,
        floorMax: ALTITUDE_FILTER_MAX_FT,
        ceilMin: 0,
        ceilMax: ALTITUDE_FILTER_MAX_FT
    };

    // A record's floor/ceiling for filtering purposes, in feet.
    // Pulled from the same static (non-LARA_FUA) types[] entry
    // used elsewhere for height display (see buildPermanentLabelHTML
    // /getTooltipAltitudeBand); ADHOC records (no static entry,
    // only a LARA_FUA band) fall back to their LARA_FUA entry's
    // own heightFrom/heightTo, same as getTooltipAltitudeBand
    // does. Missing floor defaults to the surface (0);
    // missing/non-finite ceiling defaults to UNBOUNDED_CEILING
    // (UNL) rather than 0, so an airspace with no stated top
    // isn't filtered out by a low Ceiling Range setting.
    function getAltitudeBand(record) {
        const types = Array.isArray(record?.types) ? record.types : [];
        const staticEntry = types.find(t =>
            t && t.type !== LARA_FUA_TYPE && (t.heightFrom !== undefined || t.heightTo !== undefined)
        );
        const laraEntry = types.find(t => t && t.type === LARA_FUA_TYPE);
        const entry = staticEntry || laraEntry;

        const floorRaw = entry ? entry.heightFrom : undefined;
        const ceilRaw = entry ? entry.heightTo : undefined;

        const floor = Number.isFinite(Number(floorRaw)) ? Number(floorRaw) : 0;
        const ceil = Number.isFinite(Number(ceilRaw)) ? Number(ceilRaw) : UNBOUNDED_CEILING;

        return { floor, ceil };
    }

    // True if the record's floor/ceiling both fall inside the
    // currently-set Floor Range / Ceiling Range sliders. The top
    // slider step (ALTITUDE_FILTER_MAX_FT) is treated as "and
    // above" for the ceiling side, so dragging the Ceiling Range's
    // high thumb all the way up still includes UNL airspace
    // instead of excluding it for having no finite top.
    function isWithinAltitudeFilter(record) {
        const { floor, ceil } = getAltitudeBand(record);
        const f = altitudeFilter;

        if (floor < f.floorMin || floor > f.floorMax) return false;

        const ceilMaxIsOpen = f.ceilMax >= ALTITUDE_FILTER_MAX_FT;
        if (ceil < f.ceilMin) return false;
        if (!ceilMaxIsOpen && ceil > f.ceilMax) return false;

        return true;
    }

    function getOrCreateTypeVisibility(type) {
        let v = typeVisibility.get(type);
        if (!v) {
            v = Object.assign({}, DEFAULT_TYPE_VISIBILITY);
            typeVisibility.set(type, v);
        }
        return v;
    }

    // ---- Leaflet layer groups ------------------------------------

    // One sub-group per discovered `type`, all nested under one
    // parent so the master "SHOW AIRSPACES" toggle can act on
    // everything at once while per-type filtering still works.
    const typeGroups = new Map(); // type -> L.LayerGroup
    const airspaceParentGroup = L.layerGroup().addTo(map);

    function getOrCreateTypeGroup(type) {
        let group = typeGroups.get(type);
        if (!group) {
            group = L.layerGroup().addTo(airspaceParentGroup);
            typeGroups.set(type, group);
        }
        return group;
    }

    // ---- Styling --------------------------------------------------

    // ---- Canonical PilotNet model helpers ---------------------------
    //
    // record.types is an array of { type, isActive, ... } entries.
    // A record can carry more than one entry (e.g. a static
    // classification entry alongside a LARA_FUA entry for the same
    // airspace), so these helpers each search `types` for the
    // entry that answers their specific question, rather than
    // assuming a single type per record.

    // The record's static airspace type (CTR, TMA, D, P, R, etc.)
    // -- the first types[] entry that ISN'T LARA_FUA. Returns
    // "OTHER" if types is missing/empty, or "LARA_FUA" if every
    // entry present is a LARA_FUA entry (i.e. this record has no
    // static classification at all, only a LARA/FUA overlay).
    function getStaticType(record) {
        if (!Array.isArray(record?.types)) return "OTHER";
        const staticEntry = record.types.find(t => t && t.type !== LARA_FUA_TYPE);
        return staticEntry ? staticEntry.type : LARA_FUA_TYPE;
    }

    // True if this record carries a LARA_FUA entry at all
    // (published or active) -- i.e. it should get a LARA/FUA
    // overlay drawn, regardless of that entry's isActive state.
    // True if this record carries a LARA_FUA entry at all
    // (published or active) -- i.e. it should get a LARA/FUA
    // overlay drawn, regardless of that entry's isActive state.
    // P and R airspace is treated as always published+active (see
    // isActive below) even with no real LARA_FUA entry, since
    // they're permanently-effective airspace classes.
    function isPublished(record) {
        const type = getStaticType(record);
        if (type === 'P' || type === 'R') return true;
        if (!Array.isArray(record?.types)) return false;
        return record.types.some(t => t && t.type === LARA_FUA_TYPE);
    }

    // True only if this record's LARA_FUA entry is currently
    // active (isActive === true). A published-but-not-yet-active
    // LARA_FUA entry returns false here (renders yellow, not red).
    // P and R are flagged active unconditionally, independent of
    // any real LARA_FUA data on the record, so they flow through
    // the same styleForAirspace highlight/fallback logic as a
    // matched LARA_FUA record -- turning ACTIVATED off for that
    // type in the filter matrix drops them back to their own
    // default style, same as everything else.
    function isActive(record) {
        const type = getStaticType(record);
        if (type === 'P' || type === 'R') return true;
        if (!Array.isArray(record?.types)) return false;
        const laraEntry = record.types.find(t => t && t.type === LARA_FUA_TYPE);
        return !!laraEntry && laraEntry.isActive === true;
    }

    function styleForType(type) {
        return airspaceStyleByType[type] || airspaceStyleDefault;
    }

    function styleForLaraFua(active) {
        return active ? laraFuaActiveStyle : laraFuaPublishedStyle;
    }

    // Pane selection is based on actual LARA/FUA data, not on the
    // current filter/highlight state. A matched record can temporarily
    // fall back to its static style when Published/Activated is hidden,
    // but once highlighted again it must already be in the guaranteed
    // upper pane. P/R records are treated as active for styling/filter
    // purposes, yet remain static here because they carry no LARA_FUA
    // entry of their own.
    function airspacePaneFor(record) {
        return getLaraFuaEntry(record) ? 'laraFuaAirspacePane' : 'airspacePane';
    }

    function airspaceLabelPaneFor(record) {
        return getLaraFuaEntry(record) ? 'laraFuaAirspaceLabelPane' : 'airspaceLabelPane';
    }

    // A static airspace that also carries a matched LARA_FUA entry
    // is styled by its LARA_FUA activation state instead of its
    // static type -- this is a style substitution, not a second
    // overlaid polygon. Unmatched (adhoc) LARA_FUA records use the
    // plain LARA_FUA style since they have no static type of their
    // own to fall back on.
    //
    // True if a published record's LARA_FUA state should currently
    // be shown as a highlight (red/yellow style, LARA/FUA label
    // text) rather than falling back to its plain static
    // appearance. False for anything unpublished. This is the
    // single source of truth for "highlighted or fallback",
    // shared by styleForAirspace, labelHTMLFor, and applyFilters
    // (label opacity) so the polygon style, label content, and
    // label visibility can never disagree with each other.
    function isHighlighted(record, type) {
        if (!isPublished(record)) return false;
        const v = typeVisibility ? typeVisibility.get(type) : null;
        const active = isActive(record);
        return v ? (active ? v.activated : v.scheduled) : true;
    }

    // isRecordVisible (see applyFilters) already gates published
    // records on isHighlighted before they reach here for any
    // type EXCEPT one with a real static classification (CTR,
    // TMA, D, R, GLDR, etc.), where a record can be visible via
    // its `static` box while NOT highlighted -- that's exactly
    // the plain-static fallback case handled below.
    function styleForAirspace(record, type) {
        if (isPublished(record)) {
            if (isHighlighted(record, type)) return styleForLaraFua(isActive(record));
            return type === LARA_FUA_TYPE ? airspaceStyleDefault : styleForType(type);
        }
        return styleForType(type);
    }

    // ---- Change detection ------------------------------------------

    // Cheap fingerprint covering exactly the fields that should
    // trigger a redraw/restyle if they change: coordinates and
    // the types array (which carries both static classification
    // and LARA_FUA activation state). Deliberately excludes
    // fields that wouldn't need the polygon itself touched.
    function computeSignature(record) {
        const coordsKey = record.coordinates ? JSON.stringify(record.coordinates) : '';
        const typesKey = record.types ? JSON.stringify(record.types) : '';
        return `${coordsKey}|${typesKey}|${record.name || ''}`;
    }

    // ---- AIRSPACE INFO (multi-airspace hover tooltip) --------------
    //
    // Everything below supports the AIRSPACE INFO toggle. Layers
    // themselves have no bound tooltip at all (see renderAirspace)
    // -- this builds one entry per record and the hover engine
    // (see initHoverInfo) concatenates every currently-hovered,
    // visible record -- including whichever ones are stacked
    // underneath the topmost polygon -- into a single combined
    // tooltip, shown only while the AIRSPACE INFO checkbox is on.

    // Human-readable status label + color. Plain static airspace
    // with no LARA_FUA involvement at all reports STATIC in the
    // same neutral gray used for its own outline.
    function getStatusInfo(record, type) {
        if (type !== 'P' && type !== 'R' && isPublished(record)) {
            return isActive(record)
                ? { label: 'ACTIVATED', color: '#FF3B30' }
                : { label: 'PUBLISHED', color: '#FFC107' };
        }
        return { label: 'STATIC', color: '#9E9E9E' };
    }

    // Formats a LARA_FUA entry's fromDate/toDate as a validity
    // range. Both fields are ISO timestamps with a local offset
    // (see formatLaraFuaTime); displayed in UTC as DD.MM HH:MM.
    // The end date is abbreviated to just HH:MM when it falls on
    // the same UTC day as the start, since that's the common case
    // for same-day LARA/FUA reservations.
    function formatValidityRange(fromValue, toValue) {
        if (!fromValue && !toValue) return null;
        const fromDate = fromValue ? new Date(fromValue) : null;
        const toDate = toValue ? new Date(toValue) : null;
        const validFrom = fromDate && !Number.isNaN(fromDate.getTime());
        const validTo = toDate && !Number.isNaN(toDate.getTime());
        if (!validFrom && !validTo) return null;

        const fmt = (d) => {
            const day = String(d.getUTCDate()).padStart(2, '0');
            const month = String(d.getUTCMonth() + 1).padStart(2, '0');
            const hours = String(d.getUTCHours()).padStart(2, '0');
            const minutes = String(d.getUTCMinutes()).padStart(2, '0');
            return { date: `${day}.${month}`, time: `${hours}:${minutes}` };
        };

        if (!validFrom) { const t = fmt(toDate); return `until ${t.date} ${t.time}Z`; }
        if (!validTo) { const f = fmt(fromDate); return `from ${f.date} ${f.time}Z`; }

        const f = fmt(fromDate);
        const t = fmt(toDate);
        return f.date === t.date
            ? `${f.date} ${f.time} - ${t.time}Z`
            : `${f.date} ${f.time}Z - ${t.date} ${t.time}Z`;
    }

    // Floor/ceiling for the tooltip, in the app's existing
    // FL-style display convention (see buildPermanentLabelHTML's
    // formatPermanentAlt): the record's own top-level lower/upper
    // fields don't exist on real PilotNet records (confirmed by
    // getAltitudeBand, which reads heightFrom/heightTo off
    // types[] instead) -- reading them here always fell through
    // to '?'. Pulls the static (non-LARA_FUA) types[] entry's
    // heightFrom/heightTo first, matching getAltitudeBand's own
    // priority, falling back to the LARA_FUA entry's own
    // heightFrom/heightTo for adhoc records with no static entry.
    function formatTooltipAltitude(value, fallback) {
        if (value === null || value === undefined || value === '') return fallback;
        const n = Number(value);
        if (!Number.isFinite(n)) return String(value);
        if (n <= 0) return 'SFC';
        return `FL${String(Math.round(n / 100)).padStart(3, '0')}`;
    }

    function getTooltipAltitudeBand(record, laraEntry) {
        const staticEntry = Array.isArray(record?.types)
            ? record.types.find(t => t && t.type !== LARA_FUA_TYPE && (t.heightFrom !== undefined || t.heightTo !== undefined))
            : null;
        const entry = staticEntry || laraEntry;
        const lower = formatTooltipAltitude(entry?.heightFrom, 'SFC');
        const upper = formatTooltipAltitude(entry?.heightTo, 'UNL');
        return { lower, upper };
    }

    // One record's block of HTML inside the combined tooltip:
    // name, model (the record's airspace type/class, e.g. CTR,
    // TMA, D -- there is no separate "model" field in the
    // PilotNet data, this is the same classification already
    // shown elsewhere as e.g. "(CTR)"), status, floor/ceiling,
    // and validity (only present for records carrying a real
    // LARA_FUA entry -- plain static airspace has no validity
    // window to show).
    function buildAirspaceInfoEntryHTML(record) {
        const name = record.name || 'AIRSPACE';
        const type = getStaticType(record);
        const isAdhoc = type === LARA_FUA_TYPE;
        const laraEntry = getLaraFuaEntry(record);
        const modelLabel = isAdhoc ? 'ADHOC' : type;
        const modelColor = airspaceHoverColorByType[type] || airspaceHoverDefaultColor;
        const { lower, upper } = getTooltipAltitudeBand(record, laraEntry);
        const status = getStatusInfo(record, type);
        const validity = laraEntry ? formatValidityRange(laraEntry.fromDate, laraEntry.toDate) : null;

        let html = `<div class="airspace-info-entry">`;
        html += `<div class="airspace-info-entry-name">${name}</div>`;
        html += `<div class="airspace-info-entry-row">MODEL: <b style="color:${modelColor};">${modelLabel}</b></div>`;
        html += `<div class="airspace-info-entry-row">STATUS: <b style="color:${status.color};">${status.label}</b></div>`;
        html += `<div class="airspace-info-entry-row">FLOOR/CEIL: <b>${lower} - ${upper}</b></div>`;
        if (validity) {
            html += `<div class="airspace-info-entry-row">VALID: <b>${validity}</b></div>`;
        }
        html += `</div>`;
        return html;
    }

    // Converts record.coordinates -- the canonical PilotNet
    // geometry field -- into the [[lat,lon],...] (or
    // [[[lat,lon],...],...] for multi-ring) shape Leaflet's
    // L.polygon expects. Coordinates are already [lat, lon]
    // pairs (confirmed against live API data), so no axis-order
    // conversion is needed. No GeoJSON handling here at all --
    // record.geometry is never referenced by this subsystem.
    // Computes the polygon centroid (area-weighted, not the
    // vertex average) so labels sit at the visual "middle" of
    // the shape rather than the bounding-box center, which for
    // L-shaped/concave airspace can land outside the polygon.
    // Accepts either a single ring [[lat,lon],...] or multiple
    // rings [[[lat,lon],...],...]; with multiple rings, the
    // outer boundary is taken to be the ring with the largest
    // |area| and any remaining rings are treated as holes and
    // subtracted, matching standard polygon-with-holes
    // semantics. Falls back to the plain vertex average for
    // degenerate (near-zero-area, e.g. a straight line or a
    // single point) rings.
    function ringCentroidAndArea(ring) {
        let area = 0, cx = 0, cy = 0;
        const n = ring.length;
        for (let i = 0; i < n; i++) {
            const [x1, y1] = ring[i];
            const [x2, y2] = ring[(i + 1) % n];
            const cross = x1 * y2 - x2 * y1;
            area += cross;
            cx += (x1 + x2) * cross;
            cy += (y1 + y2) * cross;
        }
        area = area / 2;
        if (Math.abs(area) < 1e-12) return null;
        return { area, cx: cx / (6 * area), cy: cy / (6 * area) };
    }

    function polygonCentroid(latlngs) {
        const isMultiRing = Array.isArray(latlngs[0][0]);
        const rings = isMultiRing ? latlngs : [latlngs];

        const solved = rings.map(ringCentroidAndArea);
        const outerIdx = solved.reduce((best, r, i) => {
            if (!r) return best;
            if (best === -1 || Math.abs(r.area) > Math.abs(solved[best].area)) return i;
            return best;
        }, -1);

        if (outerIdx === -1) {
            // Every ring is degenerate: fall back to averaging
            // every vertex across every ring.
            const flat = rings.flat();
            const sum = flat.reduce((acc, [lat, lon]) => [acc[0] + lat, acc[1] + lon], [0, 0]);
            return [sum[0] / flat.length, sum[1] / flat.length];
        }

        // Composite centroid of the outer ring with holes
        // subtracted (holes contribute negative area/moment).
        let totalArea = solved[outerIdx].area;
        let mx = solved[outerIdx].cx * solved[outerIdx].area;
        let my = solved[outerIdx].cy * solved[outerIdx].area;

        rings.forEach((ring, i) => {
            if (i === outerIdx || !solved[i]) return;
            const holeArea = -Math.abs(solved[i].area);
            totalArea += holeArea;
            mx += solved[i].cx * holeArea;
            my += solved[i].cy * holeArea;
        });

        if (Math.abs(totalArea) < 1e-12) {
            return [solved[outerIdx].cx, solved[outerIdx].cy];
        }
        return [mx / totalArea, my / totalArea];
    }

    function extractLatLngs(record) {
        const coords = record?.coordinates;
        if (!Array.isArray(coords) || coords.length === 0) return null;

        // Single ring: [[lat, lon], [lat, lon], ...]
        if (Array.isArray(coords[0]) && typeof coords[0][0] === "number") {
            return coords.map(([lat, lon]) => [lat, lon]);
        }

        // Multiple rings: [[[lat,lon],...], [[lat,lon],...]]
        return coords.map(ring => ring.map(([lat, lon]) => [lat, lon]));
    }

    // Standard ray-casting point-in-ring test (even-odd rule).
    // [lat, lon] pairs throughout, matching extractLatLngs --
    // the axes are only ever used relative to each other here,
    // so lat/lon vs x/y doesn't matter as long as both the ring
    // and the point use the same convention.
    function pointInRing(lat, lon, ring) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [latI, lonI] = ring[i];
            const [latJ, lonJ] = ring[j];
            const intersects = ((lonI > lon) !== (lonJ > lon)) &&
                (lat < (latJ - latI) * (lon - lonI) / (lonJ - lonI) + latI);
            if (intersects) inside = !inside;
        }
        return inside;
    }

    // True if [lat, lon] falls inside the polygon described by
    // latlngs -- the same single-ring-or-multi-ring shape
    // extractLatLngs produces. With multiple rings, a point
    // counts as inside only if it's inside the largest-area
    // (outer) ring and NOT inside any other ring (holes),
    // mirroring the outer/hole split polygonCentroid uses.
    function pointInAirspacePolygon(lat, lon, latlngs) {
        if (!latlngs || latlngs.length === 0) return false;
        const isMultiRing = Array.isArray(latlngs[0][0]);
        if (!isMultiRing) return pointInRing(lat, lon, latlngs);

        const rings = latlngs;
        const areas = rings.map(ring => {
            const solved = ringCentroidAndArea(ring);
            return solved ? Math.abs(solved.area) : 0;
        });
        const outerIdx = areas.reduce((best, a, i) => a > areas[best] ? i : best, 0);

        if (!pointInRing(lat, lon, rings[outerIdx])) return false;
        for (let i = 0; i < rings.length; i++) {
            if (i === outerIdx) continue;
            if (pointInRing(lat, lon, rings[i])) return false;
        }
        return true;
    }

    // ---- Normal airspace rendering (add / update in place / remove) ----

    // Builds the permanently-active-style label used for P/R
    // airspace (24/7 effective, no LARA_FUA schedule). Kept
    // separate from the LARA_FUA label builder since it has no
    // from/to time fields to show, only altitude limits.
    function buildPermanentLabelHTML(record, type) {
        const name = record.name || record.id || type;
        const staticEntry = Array.isArray(record.types)
            ? record.types.find(t =>
                t &&
                t.type &&
                t.type !== LARA_FUA_TYPE &&
                t.heightFrom !== undefined &&
                t.heightTo !== undefined
            )
            : null;

        const lower = staticEntry?.heightFrom;
        const upper = staticEntry?.heightTo;

        const formatPermanentAlt = (value, fallback) => {
            if (value === null || value === undefined || value === '') return fallback;
            // PilotNet altitude values are already expressed in feet.
            const n = Number(value);
            if (!Number.isFinite(n)) return String(value);
            return String(Math.round(n / 100));
        };

        const lowerText = formatPermanentAlt(lower, 'SFC');
        const upperText = formatPermanentAlt(upper, 'UNL');
        const safeName = String(name).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

        return `<div class="lara-fua-label active permanent-airspace-label">
            <div class="lara-fua-label-name">${safeName}</div>
            <div class="lara-fua-label-details">
                <span class="lara-fua-label-alt">
                    <span class="lara-fua-label-alt-top">${upperText}</span>
                    <span class="lara-fua-label-alt-bottom">${lowerText}</span>
                </span>
            </div>
        </div>`;
    }

    // A static airspace record needs a label in two cases: it's
    // permanently active (P/R, no schedule) or it carries a
    // matched LARA_FUA entry (scheduled/activated, with a
    // from/to time). Everything else (CTR, TMA, D, FIR, ...)
    // gets no label, same as before. Adhoc (unmatched LARA_FUA,
    // type === LARA_FUA_TYPE) records always carry a LARA_FUA
    // entry by definition, so they fall into the second case.
    function needsLabel(record, type) {
        return type === 'P' || type === 'R' || isPublished(record);
    }

    // P/R always uses the altitude-only permanent-style label,
    // even though isPublished(record) is now also true for them
    // (see isPublished) -- they have no real fromDate/toDate to
    // show, so the LARA_FUA time+altitude label would just render
    // blank time fields. Everything else with a genuine LARA_FUA
    // entry uses the full time+altitude label, but only while
    // that entry is actually highlighted (see isRecordVisible /
    // styleForAirspace) -- if scheduled/activated is unchecked
    // for this type, the polygon falls back to plain static
    // styling, so the label falls back to the plain permanent
    // one too, rather than showing LARA/FUA time text next to a
    // polygon that no longer looks published.
    function labelHTMLFor(record, type) {
        if (type === 'P' || type === 'R') return buildPermanentLabelHTML(record, type);
        if (!isPublished(record)) return buildPermanentLabelHTML(record, type);
        return isHighlighted(record, type) ? buildLaraFuaLabelHTML(record) : buildPermanentLabelHTML(record, type);
    }

    function renderAirspace(record) {
        // Keyed by record.id, NOT record.name -- PilotNet reuses
        // the same `name` across genuinely distinct airspaces that
        // happen to share an identifier (e.g. LHPA covers both an
        // MTMA+LARA_FUA record id 108648 and a separate MCTR
        // record id 108651; same for LHBP, LHKE, LHPR). Keying by
        // name meant the second one silently overwrote the first
        // in airspaceIndex, so one of the two airspaces vanished
        // entirely -- not a filter/visibility issue, it never
        // reached the index at all. record.id is unique per
        // record (verified against a live snapshot), so it's the
        // correct primary key; record.name is kept only as a
        // last-resort fallback for malformed records with no id.
        const id = record.id != null ? String(record.id) : record.name;
        if (!id) {
            console.warn('AirspaceManager: skipping record with no id', record);
            return;
        }

        const type = getStaticType(record);

        // Adhoc airspaces (type === LARA_FUA_TYPE, i.e. a LARA_FUA
        // record with no matching static classification) still get
        // their own filterable "type" bucket so the ADHOC checkbox
        // can show/hide them independently of everything else.
        discoveredTypes.add(type);

        const signature = computeSignature(record);
        const existing = airspaceIndex.get(id);

        if (existing && existing.signature === signature) {
            // Nothing that affects the drawn polygon changed --
            // just refresh the stored record so the AIRSPACE INFO
            // tooltip picks up any display-only field changes on
            // its next hover; skip touching the layer/style.
            existing.record = record;
            return;
        }

        const latlngs = extractLatLngs(record);
        if (!latlngs) {
            console.warn(`AirspaceManager: record "${id}" has no usable geometry, skipping`, record);
            return;
        }

        const style = styleForAirspace(record, type);
        const polygonPane = airspacePaneFor(record);
        const labelPane = airspaceLabelPaneFor(record);

        if (existing) {
            // Geometry and/or activation changed: update the
            // EXISTING layer in place (setLatLngs + setStyle)
            // rather than removing and recreating it.
            existing.layer.setLatLngs(latlngs);
            existing.layer.setStyle(style);
            existing.latlngs = latlngs;

            // A refresh can add/remove a LARA_FUA entry on an existing
            // record. Leaflet chooses a Path renderer from its pane when
            // the layer is added, so detach and re-add it when the pane
            // class changes instead of only mutating layer.options.
            if (existing.layer.options.pane !== polygonPane) {
                const currentGroup = typeGroups.get(existing.type);
                if (currentGroup) currentGroup.removeLayer(existing.layer);
                existing.layer.options.pane = polygonPane;
                (currentGroup || getOrCreateTypeGroup(existing.type)).addLayer(existing.layer);
            }

            if (needsLabel(record, type)) {
                const center = polygonCentroid(latlngs);
                if (existing.label) {
                    if (existing.label.options.pane !== labelPane) {
                        map.removeLayer(existing.label);
                        existing.label.options.pane = labelPane;
                        existing.label.addTo(map);
                    }
                    existing.label.setLatLng(center);
                    existing.label.setIcon(L.divIcon({
                        className: 'lara-fua-label-icon',
                        html: labelHTMLFor(record, type),
                        iconSize: null
                    }));
                } else {
                    existing.label = L.marker(center, {
                        pane: labelPane,
                        interactive: false,
                        icon: L.divIcon({
                            className: 'lara-fua-label-icon',
                            html: labelHTMLFor(record, type),
                            iconSize: null
                        })
                    });
                    existing.label.addTo(map);
                }
            } else if (existing.label) {
                map.removeLayer(existing.label);
                existing.label = null;
            }

            existing.record = record;
            existing.signature = signature;

            // The type itself could change between polls; if so,
            // move the layer to the correct type group rather
            // than leaving it filed under its old type.
            if (existing.type !== type) {
                const oldGroup = typeGroups.get(existing.type);
                if (oldGroup) oldGroup.removeLayer(existing.layer);
                getOrCreateTypeGroup(type).addLayer(existing.layer);
                existing.type = type;
            }
            return;
        }

        // New airspace: create once. No tooltip is bound directly
        // to the layer -- all airspace tooltips go through the
        // AIRSPACE INFO combined system (see initHoverInfo),
        // which is the only thing that can show every stacked
        // airspace at a point rather than just the topmost one,
        // and which is itself gated entirely by the AIRSPACE INFO
        // checkbox so no tooltip appears until that's turned on.
        const layer = L.polygon(latlngs, {
            ...style,
            pane: polygonPane
        });

        // P/R (permanently active) and LARA_FUA-matched records get
        // a label; everything else (CTR, TMA, D, FIR, ...) does not.
        let label = null;
        if (needsLabel(record, type)) {
            const center = polygonCentroid(latlngs);
            label = L.marker(center, {
                pane: labelPane,
                interactive: false,
                icon: L.divIcon({
                    className: 'lara-fua-label-icon',
                    html: labelHTMLFor(record, type),
                    iconSize: null
                })
            });
            label.addTo(map);
        }

        getOrCreateTypeGroup(type).addLayer(layer);

        airspaceIndex.set(id, { record, layer, type, signature, label, latlngs });
    }

    function removeAirspace(id) {
        const existing = airspaceIndex.get(id);
        if (!existing) return;
        const group = typeGroups.get(existing.type);
        if (group) group.removeLayer(existing.layer);
        if (existing.label) map.removeLayer(existing.label);
        airspaceIndex.delete(id);
    }

    // ---- Source-data workaround: split multi-band records ----------
    //
    // Some PilotNet records bundle more than one genuinely distinct
    // airspace into a single record's `types[]`, all sharing that
    // one record's `coordinates` -- e.g. LHSNA (id 108576) carries
    // TWO altitude bands, each with its own LARA_FUA activation
    // (LHSN MTMA/A: 2000-5500ft, LHSN MTMA/B: 5500-9500ft), PLUS a
    // third MTMA entry spanning the full 0-98425ft column -- the
    // parent MTMA airspace that the two bands sit inside. Left as
    // one record, getStaticType()'s types.find() silently picks
    // only the FIRST non-LARA_FUA entry in array order (here: the
    // TMA-A sub-band's own type, "TMA" -- not "MTMA") to classify
    // the whole record, and getLaraFuaEntry()/isActive() likewise
    // only ever see the first LARA_FUA entry, silently discarding
    // the second band's activation state entirely, and the parent
    // MTMA classification is never shown as its own airspace at
    // all. Confirmed via a scan of a live snapshot: LHSNA, LHKE1A,
    // LHKE2A, LHKE3A, and LHKE (id 108649, MCTR+CTR+LARA_FUA) all
    // show this shape.
    //
    // Fix: split each affected record into one synthetic record
    // PER distinct height band found in its `types[]`, all cloned
    // from the original (same coordinates, id-prefix), each
    // carrying only that band's entries -- INCLUDING a band with
    // no LARA_FUA entry of its own, such as LHSN's full-column
    // MTMA parent, which becomes its own MTMA airspace rather than
    // being folded into or dropped in favor of its two internal
    // sub-bands. Bands are identified by grouping types[] on
    // numeric (heightFrom, heightTo) -- NOT the heightFromType/
    // heightToType unit strings, which several paired static/
    // LARA_FUA entries for the exact same band disagree on (e.g.
    // CTR at heightFromType "AGL" vs its own LARA_FUA entry at
    // "AMSL" for the identical numeric floor), so unit-string
    // equality alone would wrongly treat them as different bands.
    //
    // Each split record's top-level `name` is taken from its OWN
    // band's static (non-LARA_FUA) entry -- NOT copied from the
    // original record's top-level name. The original record's
    // name only ever matches ONE of its bands (whichever one
    // PilotNet happened to name the parent record after -- e.g.
    // record 108612 is named "LHTRA53L" after its low band, while
    // its high band's own static entry is separately named
    // "LHTRA53H"). Before this fix, every band cloned the SAME
    // top-level name ("LHTRA53L") regardless of which band it
    // actually was, so the high band silently masqueraded as the
    // low band's name. That's mostly a cosmetic problem UNTIL
    // PilotNet later sends a genuine top-level LARA_FUA record
    // actually named "LHTRA53H" for that band's activation --
    // mergeSplitLaraFuaRecords matches by exact top-level name,
    // finds no static record named "LHTRA53H" (both split bands
    // were misnamed "LHTRA53L"), and the LARA_FUA record falls
    // through unmerged, rendering as ADHOC instead of TRA. A band
    // with no static entry of its own (shouldn't normally happen,
    // since a LARA_FUA-only band wouldn't need splitting from a
    // sibling in the first place) falls back to the original
    // record's name.
    //
    // A record with only one height-band group needs no split and
    // is returned unchanged.
    function splitMultiBandRecords(records) {
        const result = [];
        records.forEach((record) => {
            const types = Array.isArray(record.types) ? record.types : [];

            // PilotNet stores some glider areas as two distinct
            // logical airspaces in one top-level record: a /S and a
            // /V GLDR entry with the same geometry and altitude band.
            // They must remain separate because LARA/FUA can activate
            // only one variant (for example LHSG123/V). The ordinary
            // altitude-band splitter below cannot distinguish them,
            // since their numeric bands are identical.
            //
            // Keep this rule intentionally narrow: exactly two static
            // GLDR entries, the same base name and band, with one /S
            // and one /V suffix. Broader same-band name splitting would
            // incorrectly break apart combined TIZ/RMZ/TMZ records.
            const staticEntries = types.filter(t => t && t.type !== LARA_FUA_TYPE);
            const laraEntries = types.filter(t => t && t.type === LARA_FUA_TYPE);
            const gliderVariants = staticEntries.map((entry) => {
                const match = typeof entry.name === 'string' ? entry.name.match(/^(.+)\/(S|V)$/) : null;
                return match && entry.type === 'GLDR'
                    ? { entry, baseName: match[1], suffix: match[2], band: `${entry.heightFrom}|${entry.heightTo}` }
                    : null;
            });
            const variantNames = new Set(gliderVariants.filter(Boolean).map(v => v.entry.name));
            const isSameBandGliderPair =
                staticEntries.length === 2 &&
                gliderVariants.every(Boolean) &&
                new Set(gliderVariants.map(v => v.baseName)).size === 1 &&
                new Set(gliderVariants.map(v => v.band)).size === 1 &&
                new Set(gliderVariants.map(v => v.suffix)).size === 2 &&
                laraEntries.every(entry =>
                    variantNames.has(entry.name) &&
                    `${entry.heightFrom}|${entry.heightTo}` === gliderVariants[0].band
                );

            if (isSameBandGliderPair) {
                console.log(`AirspaceManager: splitting same-band GLDR siblings "${gliderVariants[0].baseName}/S" and "${gliderVariants[0].baseName}/V" from record id ${record.id}`);
                gliderVariants.forEach((variant, i) => {
                    const matchingLaraEntries = laraEntries.filter(entry => entry.name === variant.entry.name);
                    result.push({
                        ...record,
                        id: `${record.id}#glider-${i}`,
                        name: variant.entry.name,
                        types: [variant.entry, ...matchingLaraEntries]
                    });
                });
                return;
            }

            const groups = new Map(); // "from|to" -> types[]
            types.forEach((t) => {
                if (!t) return;
                const from = t.heightFrom;
                const to = t.heightTo;
                const key = `${from}|${to}`;
                let g = groups.get(key);
                if (!g) {
                    g = { from, to, entries: [] };
                    groups.set(key, g);
                }
                g.entries.push(t);
            });

            if (groups.size <= 1) {
                result.push(record);
                return;
            }

            const bandGroups = Array.from(groups.values());
            console.log(`AirspaceManager: splitting multi-band record "${record.name}" (id ${record.id}) into ${bandGroups.length} band(s)`, bandGroups.map(g => `${g.from}-${g.to}`));
            bandGroups.forEach((g, i) => {
                const staticEntry = g.entries.find(t => t && t.type !== LARA_FUA_TYPE);
                const bandName = staticEntry && staticEntry.name ? staticEntry.name : record.name;
                result.push({
                    ...record,
                    id: `${record.id}#${i}`,
                    name: bandName,
                    types: g.entries
                });
            });
        });
        return result;
    }

    // ---- Source-data workaround: known name mismatches between a
    // ---- LARA_FUA-only record and its real static counterpart ----
    //
    // mergeSplitLaraFuaRecords (below) matches a LARA_FUA-only
    // record to its static counterpart by exact `record.name`
    // equality. That covers every split pair found EXCEPT LHUD:
    // PilotNet names the static TIZ records "LHUD1"/"LHUD2" but
    // their LARA_FUA activation records "LHUD_TIZ1"/"LHUD_TIZ2" --
    // different name, though same numeric suffix, same height
    // range (LHUD1: 0-9500ft matches LHUD_TIZ1; LHUD2: 2000-9500ft
    // matches LHUD_TIZ2), and both are clearly the LARA_FUA
    // activation for the neighbouring static TIZ record.
    //
    // This is NOT handled as a general "match by height range"
    // rule -- checked against the full dataset, height range alone
    // is far too noisy a signal (e.g. a LARA_FUA-only drone-zone
    // record can coincidentally share a height range with a dozen
    // unrelated NATURE RESERVE AREA polygons that just happen to
    // start at ground level). Only these two pairs have BOTH a
    // clear name relationship AND a matching height range, so
    // they're listed explicitly here rather than inferred.
    //
    // Each entry remaps the LARA_FUA-only record's name to its
    // static counterpart's name before the by-name grouping in
    // mergeSplitLaraFuaRecords runs, so the existing merge logic
    // picks it up with no other changes needed. If PilotNet ever
    // starts naming these consistently, this table just stops
    // matching anything and can be deleted.
    const LARA_FUA_NAME_ALIASES = Object.freeze({
        'LHUD_TIZ1': 'LHUD1',
        'LHUD_TIZ2': 'LHUD2'
    });

    function applyLaraFuaNameAliases(records) {
        records.forEach((record) => {
            if (!record || !record.name) return;
            const alias = LARA_FUA_NAME_ALIASES[record.name];
            if (!alias) return;
            const types = Array.isArray(record.types) ? record.types : [];
            const isLaraOnly = types.length > 0 && types.every(t => t && t.type === LARA_FUA_TYPE);
            if (!isLaraOnly) return;
            console.log(`AirspaceManager: renaming LARA_FUA-only record "${record.name}" (id ${record.id}) to "${alias}" to match its static counterpart`);
            record.name = alias;
        });
        return records;
    }

    // ---- Source-data workaround: merge split static/LARA_FUA pairs ----
    //
    // PilotNet is documented (and mostly behaves) as one record per
    // airspace, with a static classification entry and a LARA_FUA
    // entry living together in the same record's `types[]`. In
    // practice it sometimes instead sends the static classification
    // and the LARA_FUA activation as two SEPARATE top-level records
    // that share the same `name` (different `id`, near-identical
    // coordinates) -- e.g. one record with types:[GLDR] and another
    // with types:[LARA_FUA], both named "LHSG123/S". Confirmed via
    // a scan of a live snapshot: LHSG100, LHSG114, LHSG123/S, LHPR,
    // LHPA, LHZX_DRDRONE9, LHNY2, LHD52, LHPA1 all showed this split
    // in the same poll where LHBP and LHKE correctly carried both
    // entries in one record -- so the source CAN merge them, it just
    // doesn't always.
    //
    // Left alone, `refresh()` keys records by `name`, so the second
    // record silently overwrites the first in airspaceIndex: the
    // static (e.g. GLDR) polygon/label is discarded and the airspace
    // ends up rendered as a bare LARA_FUA_TYPE record, i.e. filed
    // under ADHOC instead of its real type.
    //
    // Fix: before any record reaches the render loop, group same-
    // name records and fold any LARA_FUA-only ones into the static
    // one(s) sharing that name, combining their `types[]`. The
    // merged record keeps the static record's id/geometry -- the
    // LARA_FUA-only record contributes only its `types` entries and
    // is then dropped from the array, so getStaticType() sees both
    // entries together exactly as if the source had merged them
    // itself. Names with only static records, only LARA_FUA
    // records, or already-merged records pass through unchanged.
    // Names with more than one static record (ambiguous -- which
    // one should absorb the LARA_FUA entry?) are left untouched and
    // fall through to the existing per-id rendering, same as today.
    // Same fallback applies to a LARA_FUA-only record arriving on
    // its own during an incremental sync, with no static sibling
    // present in that particular batch to merge into -- it renders
    // under ADHOC as before, and gets merged retroactively next
    // time its static sibling is included in a batch (e.g. the
    // next full sync).
    function mergeSplitLaraFuaRecords(records) {
        const byName = new Map();
        records.forEach((record) => {
            if (!record || !record.name) return;
            let group = byName.get(record.name);
            if (!group) {
                group = { statics: [], laraOnly: [] };
                byName.set(record.name, group);
            }
            const types = Array.isArray(record.types) ? record.types : [];
            const hasStatic = types.some(t => t && t.type !== LARA_FUA_TYPE);
            if (hasStatic) group.statics.push(record);
            else group.laraOnly.push(record);
        });

        const laraOnlyToDrop = new Set();
        byName.forEach((group) => {
            if (group.statics.length !== 1 || group.laraOnly.length === 0) return;
            const staticRecord = group.statics[0];
            group.laraOnly.forEach((laraRecord) => {
                const laraTypes = (laraRecord.types || []).filter(t => t && t.type === LARA_FUA_TYPE);
                staticRecord.types = [...(staticRecord.types || []), ...laraTypes];
                laraOnlyToDrop.add(laraRecord);
                console.log(`AirspaceManager: merged LARA_FUA record (id ${laraRecord.id}) into static record (id ${staticRecord.id}), both named "${staticRecord.name}"`);
            });
        });

        return laraOnlyToDrop.size === 0 ? records : records.filter(r => !laraOnlyToDrop.has(r));
    }

    // ---- LARA_FUA overlay rendering (independent of normal airspaces) ----

    function getLaraFuaEntry(record) {
        if (!Array.isArray(record?.types)) return null;
        return record.types.find(t => t && t.type === LARA_FUA_TYPE) || null;
    }

    function formatLaraFuaTime(value) {
        if (!value) return '--.--';

        // PilotNet supplies ISO timestamps with their local offset
        // (e.g. +02:00). Convert them to UTC before displaying.
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '--.--';

        const hours = String(date.getUTCHours()).padStart(2, '0');
        const minutes = String(date.getUTCMinutes()).padStart(2, '0');
        return `${hours}:${minutes}`;
    }

    function formatLaraFuaAltitude(value) {
        if (value === null || value === undefined || value === '') return '--';
        const feetHundreds = Math.round(Number(value) / 100);
        if (!Number.isFinite(feetHundreds)) return '--';
        return String(feetHundreds).padStart(2, '0');
    }

    function getLaraFuaLabelData(record) {
        const entry = getLaraFuaEntry(record);
        return {
            name: record.name || entry?.name || String(record.id || 'LARA/FUA'),
            fromTime: formatLaraFuaTime(entry?.fromDate),
            toTime: formatLaraFuaTime(entry?.toDate),
            upper: formatLaraFuaAltitude(entry?.heightTo),
            lower: formatLaraFuaAltitude(entry?.heightFrom)
        };
    }

    function buildLaraFuaLabelHTML(record) {
        const active = isActive(record);
        const d = getLaraFuaLabelData(record);
        return `
            <div class="lara-fua-label ${active ? 'active' : 'published'}">
                <div class="lara-fua-label-name">${d.name}</div>
                <div class="lara-fua-label-details">
                    <span class="lara-fua-label-time">${d.fromTime}</span>
                    <span class="lara-fua-label-alt">
                        <span class="lara-fua-label-alt-top">${d.upper}</span>
                        <span class="lara-fua-label-alt-bottom">${d.lower}</span>
                    </span>
                    <span class="lara-fua-label-time">${d.toTime}</span>
                </div>
            </div>`;
    }

    // ---- PilotNet fetch + diff --------------------------------------

    async function fetchPilotnet(updatedAt) {
        const url = `${PILOTNET_URL}?updatedAt=${encodeURIComponent(updatedAt)}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
    }

    async function refresh() {
        const requestedUpdatedAt = latestUpdatedAt;
        const requestStartedAt = Math.floor(Date.now() / 1000);
        const requestMode = requestedUpdatedAt === 0 ? 'INITIAL FULL SYNC' : 'INCREMENTAL SYNC';

        console.groupCollapsed(`AirspaceManager: ${requestMode} ${new Date().toISOString()}`);
        console.log('PilotNet request:', {
            mode: requestMode,
            updatedAt: requestedUpdatedAt,
            updatedAtISO: requestedUpdatedAt ? new Date(requestedUpdatedAt * 1000).toISOString() : 'FULL DATASET',
            url: `${PILOTNET_URL}?updatedAt=${encodeURIComponent(requestedUpdatedAt)}`
        });

        let response;
        try {
            response = await fetchPilotnet(latestUpdatedAt);
        } catch (err) {
            console.warn('AirspaceManager: PilotNet fetch failed, keeping last known state:', err);
            console.groupEnd();
            return;
        }

        // Live response shape is an envelope, not a bare array:
        // { result: boolean, messages: [...], data: [...] }
        let records = response;
        if (response && !Array.isArray(response) && Array.isArray(response.data)) {
            if (response.result === false) {
                console.warn('AirspaceManager: PilotNet reported an error result:', response.messages);
                console.groupEnd();
                return;
            }
            if (Array.isArray(response.messages) && response.messages.length > 0) {
                console.warn('AirspaceManager: PilotNet returned messages alongside data:', response.messages);
            }
            records = response.data;
        }

        if (!Array.isArray(records)) {
            console.warn('AirspaceManager: unexpected PilotNet response shape, expected an array (or {data: array})', response);
            console.groupEnd();
            return;
        }

        records = splitMultiBandRecords(records);
        records = applyLaraFuaNameAliases(records);
        records = mergeSplitLaraFuaRecords(records);

        const seenAirspaceIds = new Set();
        const addedAirspaces = [];
        const changedAirspaces = [];

        records.forEach((record) => {
            if (!record) return;
            // Same key construction as renderAirspace -- must
            // match exactly, since this id is used to detect
            // added/changed/removed airspaces against
            // airspaceIndex, which renderAirspace populates using
            // its own id. See renderAirspace for why record.id
            // (not record.name) is the primary key.
            const id = record.id != null ? String(record.id) : record.name;
            if (!id) return;

            if (record.updatedAt && record.updatedAt > latestUpdatedAt) {
                console.log(`AirspaceManager: source updatedAt advanced ${latestUpdatedAt} -> ${record.updatedAt} (record "${id}")`);
                latestUpdatedAt = record.updatedAt;
            }

            // Every record is rendered as exactly one airspace
            // polygon, whether it carries a static classification,
            // a LARA_FUA entry, or both. A record with both gets
            // its static polygon STYLED by the LARA_FUA activation
            // state (see styleForAirspace) instead of a second
            // overlaid polygon. A record with only a LARA_FUA entry
            // (no static match) is rendered too, filed under the
            // ADHOC bucket (see isAdhocRecord/getStaticType).
            seenAirspaceIds.add(id);
            const before = airspaceIndex.get(id);
            const beforeSignature = before?.signature;
            renderAirspace(record);
            const afterSignature = computeSignature(record);
            if (!before) addedAirspaces.push(id);
            else if (beforeSignature !== afterSignature) changedAirspaces.push(id);
        });

        // Only a full snapshot can prove that an airspace was removed.
        // Incremental PilotNet responses contain changed records, so
        // treating every omitted record as removed would incorrectly
        // delete unchanged airspaces on every poll.
        const removedAirspaces = [];
        if (requestedUpdatedAt === 0) {
            Array.from(airspaceIndex.keys()).forEach((id) => {
                if (!seenAirspaceIds.has(id)) {
                    removeAirspace(id);
                    removedAirspaces.push(id);
                }
            });
        }

        // Regenerating the type-filter checkbox list is cheap
        // (a couple dozen DOM nodes at most) so it's simply
        // rebuilt whenever anything was added or removed, rather
        // than trying to cheaply detect "did the SET of types
        // change" separately from "did the counts change" --
        // that distinction isn't worth the extra bookkeeping.
        const changedCount = addedAirspaces.length + changedAirspaces.length;
        const removedCount = removedAirspaces.length;

        if (changedCount > 0 || removedCount > 0) {
            renderTypeFilterUI();
            applyFilters();
        }

        console.log('AirspaceManager: refresh summary', {
            added: addedAirspaces.length,
            changed: changedAirspaces.length,
            removed: removedAirspaces.length,
            recordsReceived: records.length
        });

        if (addedAirspaces.length) console.log('AirspaceManager: added:', addedAirspaces);
        if (changedAirspaces.length) console.log('AirspaceManager: changed:', changedAirspaces);
        if (removedAirspaces.length) console.log('AirspaceManager: removed:', removedAirspaces);

        // The initial request is intentionally a full snapshot. Once
        // it succeeds, use the request timestamp as the checkpoint for
        // subsequent five-minute incremental requests.
        if (requestedUpdatedAt === 0) hasInitialSnapshot = true;
        latestUpdatedAt = requestStartedAt;
        console.log(`AirspaceManager: next incremental updatedAt=${latestUpdatedAt} (${new Date(latestUpdatedAt * 1000).toISOString()})`);
        console.groupEnd();

        updateAirspaceStatusPanel(requestStartedAt, requestStartedAt + POLL_INTERVAL_MS / 1000);
    }

    // ---- Status panel (top-left "Airspaces by PilotNet.hu") -------

    function updateAirspaceStatusPanel(lastUpdateEpochSeconds, nextUpdateEpochSeconds) {
        const el = document.getElementById('radar-airspace-status');
        if (!el) return;
        el.innerHTML = `Airspaces by PilotNet.hu<br>Last update: ${formatZuluTime(lastUpdateEpochSeconds)}<br>Next update: ${formatZuluTime(nextUpdateEpochSeconds)}`;
    }

    // ---- Filters (type checkboxes generated from real data + master toggle) ----

    function renderTypeFilterUI() {
        const container = document.getElementById('airspace-type-filters');
        if (!container) return;

        if (typeVisibility === null) typeVisibility = new Map();
        discoveredTypes.forEach((t) => {
            if (!typeGroups.has(t)) getOrCreateTypeGroup(t);
            getOrCreateTypeVisibility(t);
        });

        container.innerHTML = '';

        const header = document.createElement('div');
        header.className = 'airspace-type-header';
        header.innerHTML = '<div>TYPE</div><div class="airspace-type-header-check static-h">S</div><div class="airspace-type-header-check scheduled-h">P</div><div class="airspace-type-header-check activated-h">A</div>';
        container.appendChild(header);

        const CHECK_DEFS = [
            { key:'static', cls:'static-cell', title:'Static' },
            { key:'scheduled', cls:'scheduled-cell', title:'Published' },
            { key:'activated', cls:'activated-cell', title:'Activated' }
        ];

        Array.from(discoveredTypes).sort((a,b) => {
            if (a === LARA_FUA_TYPE) return 1;
            if (b === LARA_FUA_TYPE) return -1;
            return a.localeCompare(b);
        }).forEach(type => {
            const displayName = type === LARA_FUA_TYPE ? 'ADHOC' : type;
            const v = getOrCreateTypeVisibility(type);
            const row = document.createElement('div');
            row.className = 'airspace-type-row';

            const nameEl = document.createElement('div');
            nameEl.className = 'airspace-type-name';
            nameEl.textContent = displayName;
            row.appendChild(nameEl);

            CHECK_DEFS.forEach(({key, cls, title}) => {
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.className = `airspace-matrix-check ${cls}`;
                checkbox.title = `${displayName}: ${title}`;
                checkbox.checked = !!v[key];
                checkbox.addEventListener('change', () => {
                    v[key] = checkbox.checked;
                    applyFilters();
                });
                row.appendChild(checkbox);
            });
            container.appendChild(row);
        });
    }

    // Sets every discovered type's checkbox for one column
    // (static/scheduled/activated) to the same state in a single
    // action, then re-renders the checkbox UI and re-applies
    // filters once. Toggles rather than always turning on: if
    // ANY type currently has that column unchecked, the button
    // turns the whole column on (the more useful "restore
    // everything" action); only when every type already has it
    // checked does it turn the whole column off. This avoids the
    // ambiguity of a plain toggle when rows are in a mixed state.
    function toggleAllForKey(key) {
        if (typeVisibility === null) typeVisibility = new Map();
        discoveredTypes.forEach((t) => getOrCreateTypeVisibility(t));

        const nextState = !Array.from(typeVisibility.values()).every(v => v[key]);
        typeVisibility.forEach((v) => { v[key] = nextState; });

        renderTypeFilterUI();
        applyFilters();
    }

    // Wired once here (not inside renderTypeFilterUI, which reruns
    // every time a new type is discovered) so the 3 column buttons
    // never accumulate duplicate listeners.
    const staticToggleBtn = document.getElementById('airspace-toggle-static-btn');
    const scheduledToggleBtn = document.getElementById('airspace-toggle-scheduled-btn');
    const activatedToggleBtn = document.getElementById('airspace-toggle-activated-btn');
    if (staticToggleBtn) staticToggleBtn.addEventListener('click', () => toggleAllForKey('static'));
    if (scheduledToggleBtn) scheduledToggleBtn.addEventListener('click', () => toggleAllForKey('scheduled'));
    if (activatedToggleBtn) activatedToggleBtn.addEventListener('click', () => toggleAllForKey('activated'));

    // Hides/shows a single layer via setStyle (opacity/fillOpacity
    // 0) rather than removing it from its group -- this works
    // correctly under both Leaflet's SVG and Canvas renderers
    // (this app runs with preferCanvas: true, and Canvas-rendered
    // layers have no _path DOM element to toggle directly), and
    // avoids having to recompute/reapply the layer's real style
    // (type color, active-state fill, etc.) every time it's shown
    // again -- restoreLayerVisualStyle() does that instead.
    const HIDDEN_STYLE = { opacity: 0, fillOpacity: 0, interactive: false };

    function restoreLayerVisualStyle(layer, style) {
        layer.setStyle(Object.assign({ interactive: true }, style));
    }

    // `static` only gates unpublished records (the plain, non-
    // LARA_FUA airspace outline). Published records are gated by
    // their own scheduled/activated flag instead, independent of
    // `static` -- so unchecking static removes only the inactive/
    // plain rendering of a type, while scheduled/activated
    // records of that type stay controllable by their own boxes.
    // P and R are always isPublished()+isActive() (see isActive),
    // so their `static` checkbox has no effect at all -- they're
    // gated entirely by `activated`; there is no "unpublished
    // P/R" state to gate.
    // Whether a record's polygon is drawn at all. This is
    // deliberately NOT the same question as "is it highlighted"
    // (see styleForAirspace): a record with a real static
    // classification (CTR, TMA, D, R, GLDR, etc.) has a shape
    // that exists independent of any LARA_FUA overlay, so
    // unchecking `activated`/`scheduled` should only drop the
    // highlight and fall back to the plain static polygon --
    // not remove the polygon. It should disappear only when
    // `static` is ALSO off. `static` is therefore a union with
    // whichever of scheduled/activated currently applies, for
    // any record that has a static type at all.
    //
    // A true ADHOC record (type === LARA_FUA_TYPE, no static
    // classification -- see getStaticType) has no fallback shape
    // to drop back to, so for those the scheduled/activated
    // checkbox alone gates existence, same as before.
    function isRecordVisible(record, type) {
        if (!isWithinAltitudeFilter(record)) return false;

        const v = typeVisibility ? typeVisibility.get(type) : null;
        if (!v) return true;
        if (!isPublished(record)) return v.static;
        const highlighted = isActive(record) ? v.activated : v.scheduled;
        if (type === LARA_FUA_TYPE) return highlighted;
        return v.static || highlighted;
    }

    // Selecting multiple types shows their union: each type's own
    // sub-group is simply shown/hidden independently, so multiple
    // enabled types are naturally a union with no extra logic.
    // Type-group-level show/hide tracks `static` only, matching
    // isRecordVisible.
    function applyFilters() {
        if (!showAll) {
            if (map.hasLayer(airspaceParentGroup)) map.removeLayer(airspaceParentGroup);

            // Labels are standalone markers, so hide them
            // explicitly when the master airspace switch is off.
            airspaceIndex.forEach((entry) => {
                if (entry.label) entry.label.setOpacity(0);
            });
            return;
        }
        if (!map.hasLayer(airspaceParentGroup)) map.addLayer(airspaceParentGroup);

        typeGroups.forEach((group, type) => {
            const v = typeVisibility ? typeVisibility.get(type) : null;
            // The whole group is only removed from the map when
            // ALL 3 boxes are off -- static gates unpublished
            // records within the group, scheduled/activated gate
            // published ones, and isRecordVisible below decides
            // per-record. Removing the group here on static alone
            // would also hide that type's scheduled/activated
            // records, which is exactly what we don't want.
            const typeEnabled = !v || v.static || v.scheduled || v.activated;
            if (typeEnabled) {
                if (!airspaceParentGroup.hasLayer(group)) airspaceParentGroup.addLayer(group);
            } else {
                if (airspaceParentGroup.hasLayer(group)) airspaceParentGroup.removeLayer(group);
            }
        });

        // Per-record visibility: unpublished records gated by
        // `static`, ADHOC (LARA_FUA-only, no static shape) records
        // gated by `scheduled`/`activated` alone, and everything
        // else with a real static type visible whenever EITHER
        // `static` OR the applicable scheduled/activated box is
        // checked (see isRecordVisible) -- so unchecking
        // scheduled/activated alone drops the highlight and falls
        // back to the plain static polygon instead of hiding it.
        // Highlight vs plain-static styling is decided separately
        // by styleForAirspace/labelHTMLFor using the same
        // scheduled/activated flags, independent of visibility.
        //
        // Labels only carry LARA/FUA (or P/R permanent-altitude)
        // information, so a label should be shown only while that
        // information is actually being displayed on the polygon
        // -- i.e. while highlighted -- not merely while the
        // polygon itself is visible. A record showing as its
        // plain static fallback (scheduled/activated unchecked,
        // static checked) is visible but not highlighted, so its
        // label hides along with the highlight, same as if the
        // whole record were hidden -- P/R included: even though
        // isPublished/isActive force them into the published
        // branch unconditionally (see isPublished/isActive), their
        // `activated` checkbox still gates their label the same
        // way it does for every other type. Unchecking `activated`
        // for P/R hides the label; the polygon itself stays
        // visible via `static`, same as any other type falling
        // back to its plain static appearance.
        airspaceIndex.forEach((entry) => {
            const visible = isRecordVisible(entry.record, entry.type);
            const labelVisible = visible && isHighlighted(entry.record, entry.type);

            if (visible) {
                restoreLayerVisualStyle(entry.layer, styleForAirspace(entry.record, entry.type));
            } else {
                entry.layer.setStyle(HIDDEN_STYLE);
            }
            if (entry.label) entry.label.setOpacity(labelVisible ? 1 : 0);
        });
    }

    // ---- AIRSPACE INFO hover engine ---------------------------------
    //
    // Leaflet's Canvas renderer only ever fires mouseover/tooltip
    // events for the single topmost polygon under the cursor (it
    // hit-tests in reverse draw order and stops at the first
    // match), so a per-layer bound tooltip would be structurally
    // incapable of showing more than one airspace at a time --
    // which is why layers have no bound tooltip at all (see
    // renderAirspace). This is an independent, map-wide mousemove
    // listener that hit-tests every visible airspace's own
    // geometry directly (see pointInAirspacePolygon) and reports
    // every match, not just the topmost.

    let airspaceInfoEnabled = false;
    let hoveredIds = [];
    let infoTooltip = null;

    // Smaller polygons are listed first -- when a small CTR sits
    // entirely inside a larger TMA, the more specific airspace is
    // almost always what the user is actually pointing at, so it
    // reads best at the top of the list.
    function ringArea(latlngs) {
        if (!latlngs || latlngs.length === 0) return Infinity;
        const isMultiRing = Array.isArray(latlngs[0][0]);
        const outer = isMultiRing
            ? latlngs.reduce((best, ring) => {
                const a = ringCentroidAndArea(ring);
                const area = a ? Math.abs(a.area) : 0;
                return area > best ? area : best;
            }, 0)
            : (ringCentroidAndArea(latlngs) ? Math.abs(ringCentroidAndArea(latlngs).area) : 0);
        return outer;
    }

    function findHoveredIds(lat, lon) {
        const matches = [];
        airspaceIndex.forEach((entry, id) => {
            if (!isRecordVisible(entry.record, entry.type)) return;
            if (!entry.latlngs) return;
            if (pointInAirspacePolygon(lat, lon, entry.latlngs)) {
                matches.push(id);
            }
        });
        matches.sort((a, b) => {
            const ea = airspaceIndex.get(a);
            const eb = airspaceIndex.get(b);
            return ringArea(ea.latlngs) - ringArea(eb.latlngs);
        });
        return matches;
    }

    function setHighlighted(ids) {
        const idSet = new Set(ids);
        // Un-highlight anything that was highlighted before but
        // isn't in the new set, restoring its normal computed
        // style (not just the highlight style) in case its own
        // static/published/active state changed while hovered.
        hoveredIds.forEach((id) => {
            if (idSet.has(id)) return;
            const entry = airspaceIndex.get(id);
            if (!entry) return;
            restoreLayerVisualStyle(entry.layer, styleForAirspace(entry.record, entry.type));
        });
        ids.forEach((id) => {
            const entry = airspaceIndex.get(id);
            if (!entry) return;
            entry.layer.setStyle(Object.assign({ interactive: true }, airspaceHoverStyleForType(entry.type)));
        });
        hoveredIds = ids;
    }

    function showInfoTooltip(ids, latlng) {
        if (ids.length === 0) {
            if (infoTooltip) {
                map.closeTooltip(infoTooltip);
                infoTooltip = null;
            }
            return;
        }

        const html = ids
            .map((id) => airspaceIndex.get(id))
            .filter(Boolean)
            .map((entry) => buildAirspaceInfoEntryHTML(entry.record))
            .join('');

        if (infoTooltip) {
            infoTooltip.setLatLng(latlng);
            infoTooltip.setContent(html);
        } else {
            infoTooltip = L.tooltip({
                className: 'airspace-info-tooltip',
                sticky: false,
                direction: 'top',
                offset: [0, -8],
                interactive: false,
                pane: 'airspaceInfoTooltipPane'
            })
                .setLatLng(latlng)
                .setContent(html)
                .addTo(map);
        }
    }

    function handleAirspaceInfoMouseMove(e) {
        if (!airspaceInfoEnabled || !showAll) {
            if (hoveredIds.length > 0 || infoTooltip) clearAirspaceInfoHover();
            return;
        }
        const { lat, lng } = e.latlng;
        const ids = findHoveredIds(lat, lng);
        setHighlighted(ids);
        showInfoTooltip(ids, e.latlng);
    }

    function clearAirspaceInfoHover() {
        setHighlighted([]);
        if (infoTooltip) {
            map.closeTooltip(infoTooltip);
            infoTooltip = null;
        }
    }

    function setAirspaceInfoEnabled(enabled) {
        airspaceInfoEnabled = enabled;
        if (!enabled) clearAirspaceInfoHover();
    }

    function initHoverInfo() {
        map.on('mousemove', handleAirspaceInfoMouseMove);
        map.on('mouseout', clearAirspaceInfoHover);

        const checkbox = document.getElementById('airspace-info-toggle');
        if (checkbox) {
            setAirspaceInfoEnabled(checkbox.checked);
            checkbox.addEventListener('change', () => setAirspaceInfoEnabled(checkbox.checked));
        }
    }

    // Formats a slider value (hundreds of feet, i.e. FL) as the
    // altitude label text used above the Floor/Ceiling sliders.
    // 0 reads as "SFC" (surface) and the slider's top step reads
    // as "UNL" (unlimited) to match how the airspace labels
    // themselves already render SFC/UNL (see
    // buildPermanentLabelHTML) -- everything in between is shown
    // as a flight level, e.g. FL065.
    function formatAltitudeFilterBound(ft, isTop) {
        if (ft <= 0) return 'SFC';
        if (isTop && ft >= ALTITUDE_FILTER_MAX_FT) return 'UNL';
        return `FL${Math.round(ft / 100).toString().padStart(3, '0')}`;
    }

    // Wires one Floor/Ceiling dual-thumb slider: two overlapping
    // native range inputs (low/high) plus a label div and a fill
    // bar. Keeps the low thumb from crossing above the high thumb
    // (and vice versa) by clamping on input, updates the fill
    // bar's left/width to visually span the selected range, and
    // calls onChange(low, high) -- in feet -- whenever either
    // thumb moves, which is where the caller re-applies filters.
    function wireDualSlider(lowId, highId, fillId, labelId, labelPrefix, onChange) {
        const lowEl = document.getElementById(lowId);
        const highEl = document.getElementById(highId);
        const fillEl = document.getElementById(fillId);
        const labelEl = document.getElementById(labelId);
        if (!lowEl || !highEl) return;

        const sliderMax = Number(lowEl.max);

        function update() {
            let low = Number(lowEl.value);
            let high = Number(highEl.value);

            // Keep the two thumbs from swapping past each other --
            // if the user drags one thumb across the other, pin
            // both to the same value at the crossing point rather
            // than letting low > high (which would make the
            // filter reject everything).
            if (low > high) {
                if (document.activeElement === lowEl) {
                    high = low;
                    highEl.value = String(high);
                } else {
                    low = high;
                    lowEl.value = String(low);
                }
            }

            const lowPct = (low / sliderMax) * 100;
            const highPct = (high / sliderMax) * 100;
            if (fillEl) {
                fillEl.style.left = `${lowPct}%`;
                fillEl.style.width = `${Math.max(0, highPct - lowPct)}%`;
            }
            if (labelEl) {
                const lowText = formatAltitudeFilterBound(low * 100, false);
                const highText = formatAltitudeFilterBound(high * 100, true);
                labelEl.textContent = `${lowText} – ${highText}`;
            }

            // Slider units are hundreds of feet (FL-style, step 5
            // = 500ft); onChange wants feet.
            onChange(low * 100, high * 100);
        }

        lowEl.addEventListener('input', update);
        highEl.addEventListener('input', update);
        update();
    }

    function wireFilterControls() {
        const showAllCheckbox = document.getElementById('layer-airspace-all');
        if (showAllCheckbox) {
            showAll = showAllCheckbox.checked;
            showAllCheckbox.addEventListener('change', () => {
                showAll = showAllCheckbox.checked;
                applyFilters();
            });
        }

        // SHOW ACTIVATED / SHOW SCHEDULED / SHOW ADHOC are no
        // longer global checkboxes -- each type (including ADHOC,
        // i.e. LARA_FUA_TYPE) now gets its own STATIC/SCHEDULED/
        // ACTIVATED row, wired up in renderTypeFilterUI instead.

        // Floor Range / Ceiling Range dual sliders (see
        // isWithinAltitudeFilter). Each pair of thumbs updates
        // altitudeFilter and re-applies filters live as the user
        // drags, same as the existing single-thumb sliders.
        wireDualSlider(
            'airspace-floor-filter-low',
            'airspace-floor-filter-high',
            'airspace-floor-filter-fill',
            'airspace-floor-filter-val',
            'Floor',
            (low, high) => {
                altitudeFilter.floorMin = low;
                altitudeFilter.floorMax = high;
                applyFilters();
            }
        );

        wireDualSlider(
            'airspace-ceiling-filter-low',
            'airspace-ceiling-filter-high',
            'airspace-ceiling-filter-fill',
            'airspace-ceiling-filter-val',
            'Ceiling',
            (low, high) => {
                altitudeFilter.ceilMin = low;
                altitudeFilter.ceilMax = high;
                applyFilters();
            }
        );
    }

    // ---- Public API -------------------------------------------------

    async function init() {
        wireFilterControls();
        initHoverInfo();
        await refresh();
        renderTypeFilterUI();
        applyFilters();
        pollTimer = setInterval(refresh, POLL_INTERVAL_MS);
    }

    return { init };
}

export { createAirspaceManager };
