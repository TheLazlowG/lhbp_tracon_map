// SID/STAR routes, overfly turns, and holding patterns.
// Called after waypoint and procedure data loading; the main script owns layer visibility.
function buildProcedures({
    L, waypoints, procedures, getOffsetPoint,
    rwy13R, rwy13L, rwy31L, rwy31R,
    sid31Group, sid13Group, star31Group, star13Group, holdingGroup
}) {
    const wp = waypoints;
    const runways = { "13R": rwy13R, "13L": rwy13L, "31L": rwy31L, "31R": rwy31R };
    const sid31Style = { color: '#ffffff', weight: 1, dashArray: '3, 4', opacity: 0.7, interactive: false };
    const sid13Style = { color: '#ffffff', weight: 1, dashArray: '3, 4', opacity: 0.7, interactive: false };
    const star31Style = { color: '#ffffff', weight: 1, dashArray: '8, 4', opacity: 0.7, interactive: false };
    const star13Style = { color: '#ffffff', weight: 1, dashArray: '8, 4', opacity: 0.7, interactive: false };
    const holdingStyle = { color: '#ffffff', weight: 1, dashArray: '6, 4', opacity: 0.7, interactive: false };

    // Bearing (great-circle initial course) from point a to point b, in degrees.
    function getBearing(a, b) {
        const lat1 = (a[0] * Math.PI) / 180;
        const lat2 = (b[0] * Math.PI) / 180;
        const dLon = ((b[1] - a[1]) * Math.PI) / 180;
        const y = Math.sin(dLon) * Math.cos(lat2);
        const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
        return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
    }

    // Planar (flat-earth) distance in NM between two [lat,lon] points.
    // Fine at this map's scale (a few dozen NM) and much simpler than
    // full great-circle trig for the tangent-circle construction below.
    function planarDistanceNM(a, b) {
        const NM_PER_DEG_LAT = 60;
        const nmPerDegLon = 60 * Math.cos((a[0] * Math.PI) / 180);
        const dy = (b[0] - a[0]) * NM_PER_DEG_LAT;
        const dx = (b[1] - a[1]) * nmPerDegLon;
        return Math.sqrt(dx * dx + dy * dy);
    }

    // Draws a procedure (SID/STAR) as a sequence of legs between points.
    // `points` is an array where each entry is either:
    //   - a plain [lat,lon] pair or a fix-name string ("BP821") for a
    //     normal fly-by vertex (sharp corner, straight legs in/out), or
    //   - { at: "BP821", overfly: { inbound: 200, turn: "R", radius: 1.2 } }
    //     for a DF (direct-to-fix) overfly point: the track curves at
    //     constant `radius` (NM) in the `turn` direction ("L"/"R"),
    //     starting from `inbound` course, until it points directly at
    //     the NEXT point in the array -- then a straight leg is flown
    //     from that roll-out point to the next fix.
    // Requires an overfly point to have a next point to aim at; the
    // last point in a procedure cannot itself be an overfly point.
    function resolvePoint(entry) {
        if (typeof entry === 'string') return wp[entry];
        if (Array.isArray(entry)) return entry;
        if (entry && entry.runway) return runways[entry.runway];
        if (entry && entry.at) {
            return typeof entry.at === 'string' ? wp[entry.at] : entry.at;
        }
        return null;
    }

    function drawProcedure(points, style, group) {
        const line = [];

        // Helper to normalize angle differences into [-180, 180] degrees
        const normalizeAngle = (deg) => {
            let a = deg % 360;
            if (a > 180) a -= 360;
            if (a < -180) a += 360;
            return a;
        };

        for (let i = 0; i < points.length; i++) {
            const entry = points[i];
            const fixPos = resolvePoint(entry);
            if (!fixPos) continue;

            const isOverfly = entry && typeof entry === 'object' && !Array.isArray(entry) && entry.overfly;

            if (!isOverfly || i === points.length - 1) {
                line.push(fixPos);
                continue;
            }

            const nextPos = resolvePoint(points[i + 1]);
            if (!nextPos) {
                line.push(fixPos);
                continue;
            }

            const { inbound, nextInbound, turn } = entry.overfly;

            if (nextInbound === undefined) {
                line.push(fixPos);
                continue;
            }

            // 1. Calculate turn difference with 360/0 wrap handling
            const rawDiff = normalizeAngle(nextInbound - inbound);

            // Determine Turn Direction (+1 = Right / Clockwise, -1 = Left / Counter-Clockwise)
            let turnSign = 1;
            if (turn) {
                turnSign = turn === 'R' ? 1 : -1;
            } else {
                turnSign = rawDiff >= 0 ? 1 : -1;
            }

            // Calculate absolute turn change (0° to 180°)
            let turnAngleDeg;
            if (turn) {
                turnAngleDeg = turnSign === 1 ? (rawDiff + 360) % 360 : (-rawDiff + 360) % 360;
            } else {
                turnAngleDeg = Math.abs(rawDiff);
            }

            // Straight leg or invalid turn check
            if (turnAngleDeg <= 0.1 || turnAngleDeg >= 179.9) {
                line.push(fixPos);
                continue;
            }

            const delta = (turnAngleDeg * Math.PI) / 180;

            // 2. Compute Perpendicular Distance from A to line through B along nextInbound
            const line2NormalBearing = (nextInbound - turnSign * 90 + 360) % 360;

            const distAB = planarDistanceNM(fixPos, nextPos);
            const bearingAB = getBearing(fixPos, nextPos);

            // Angle between vector AB and line2NormalBearing
            const alpha = ((bearingAB - line2NormalBearing) * Math.PI) / 180;

            const d_perp = distAB * Math.cos(alpha);

            // 3. Radius Solution
            let radius = d_perp / (1 - Math.cos(delta));

            if (isNaN(radius) || radius <= 0.01) {
                line.push(fixPos);
                continue;
            }

            // 4. Circle Center & Start Bearing
            const centerBearing = (inbound + turnSign * 90 + 360) % 360;
            const center = getOffsetPoint(fixPos, radius, centerBearing);

            const startBearing = (centerBearing + 180) % 360;

            // 5. Arc Generation
            const ARC_STEPS = 16;
            for (let s = 0; s <= ARC_STEPS; s++) {
                const stepAngle = turnSign * (turnAngleDeg * (s / ARC_STEPS));
                const currentBearing = (startBearing + stepAngle + 720) % 360;
                line.push(getOffsetPoint(center, radius, currentBearing));
            }
        }

        L.polyline(line, style).addTo(group);
    }

    // Route entries are fix names, runway references, or overfly definitions.
    for (const [routes, style, group] of [
        [procedures.sid31, sid31Style, sid31Group],
        [procedures.sid13, sid13Style, sid13Group],
        [procedures.star31, star31Style, star31Group],
        [procedures.star13, star13Style, star13Group]
    ]) {
        routes.forEach(points => drawProcedure(points, style, group));
    }
    procedures.holdings.forEach(({ fix, inboundTrack, isRightHand }) => {
        buildHoldingPattern(fix, inboundTrack, isRightHand);
    });

    // ==========================================
    // Real-world Precision Holding Pattern Vectors
    // ==========================================
    function buildHoldingPattern(fixName, inboundTrack, isRightHand) {
        const fix = waypoints[fixName];
        if (!fix) return;

        const turnRadiusNM = 2;
        const legLengthNM = 5.0;
        const points = [];

        const outboundTrack = (inboundTrack + 180) % 360;
        const turnSign = isRightHand ? 1 : -1;

        const centerAngle1 = (inboundTrack + turnSign * 90 + 360) % 360;
        const centerPoint1 = getOffsetPoint(fix, turnRadiusNM, centerAngle1);

        const startRadial1 = (centerAngle1 + 180) % 360;
        for (let i = 0; i <= 16; i++) {
            const currentRadial = (startRadial1 + turnSign * (180 * i / 16) + 720) % 360;
            points.push(getOffsetPoint(centerPoint1, turnRadiusNM, currentRadial));
        }

        const outboundStart = points[points.length - 1];
        const outboundEnd = getOffsetPoint(outboundStart, legLengthNM, outboundTrack);

        const centerAngle2 = (outboundTrack + turnSign * 90 + 360) % 360;
        const centerPoint2 = getOffsetPoint(outboundEnd, turnRadiusNM, centerAngle2);

        const startRadial2 = (centerAngle2 + 180) % 360;
        for (let i = 0; i <= 16; i++) {
            const currentRadial = (startRadial2 + turnSign * (180 * i / 16) + 720) % 360;
            points.push(getOffsetPoint(centerPoint2, turnRadiusNM, currentRadial));
        }

        points.push(fix);
        L.polyline(points, holdingStyle).addTo(holdingGroup);
    }
}

export { buildProcedures };
