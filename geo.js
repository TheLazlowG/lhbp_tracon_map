// Shared geographic calculations.

function normalizedHeading(degrees) {
    return (degrees % 360 + 360) % 360;
}

function formatHeading(degrees) {
    return String(Math.round(normalizedHeading(degrees)) % 360).padStart(3, '0');
}

function trueBearingDegrees(start, end) {
    const lat1 = start.lat * Math.PI / 180;
    const lat2 = end.lat * Math.PI / 180;
    const deltaLon = (end.lng - start.lng) * Math.PI / 180;
    const y = Math.sin(deltaLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) -
        Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
    return normalizedHeading(Math.atan2(y, x) * 180 / Math.PI);
}

// 4. Helper Function to calculate point offset by Nautical Miles (NM) and Bearing (Degrees)
function getOffsetPoint(startPoint, distanceNM, bearingDegrees) {
    const R = 3440.065; 
    const dist = distanceNM / R;
    const brng = (bearingDegrees * Math.PI) / 180;
    
    const lat1 = (startPoint[0] * Math.PI) / 180;
    const lon1 = (startPoint[1] * Math.PI) / 180;

    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(dist) + Math.cos(lat1) * Math.sin(dist) * Math.cos(brng));
    const lon2 = lon1 + Math.atan2(Math.sin(brng) * Math.sin(dist) * Math.cos(lat1), Math.cos(dist) - Math.sin(lat1) * Math.sin(lat2));

    return [(lat2 * 180) / Math.PI, (lon2 * 180) / Math.PI];
}

export { formatHeading, getOffsetPoint, normalizedHeading, trueBearingDegrees };
