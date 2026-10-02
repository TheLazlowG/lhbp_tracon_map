// UTC formatting and radar clock.

// ==========================================
// Shared UTC time formatter (HH:MM:SSZ)
// ==========================================
function formatZuluTime(epochSeconds) {
    const d = new Date(epochSeconds * 1000);
    const hours = String(d.getUTCHours()).padStart(2, '0');
    const minutes = String(d.getUTCMinutes()).padStart(2, '0');
    const seconds = String(d.getUTCSeconds()).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}Z`;
}

// ==========================================
// Live Aviation Standard Zulu Clock Engine
// ==========================================
function updateRadarClock() {
    const now = new Date();
    
    // Extract standard UTC definitions for absolute Zulu sync
    const day = String(now.getUTCDate()).padStart(2, '0');
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const year = now.getUTCFullYear();
    
    const hours = String(now.getUTCHours()).padStart(2, '0');
    const minutes = String(now.getUTCMinutes()).padStart(2, '0');
    const seconds = String(now.getUTCSeconds()).padStart(2, '0');
    
    // Output layout formatted natively as YYYY-MM-DD HH:MM:SS Z
    document.getElementById('radar-clock').textContent = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}Z`;
}
setInterval(updateRadarClock, 1000);
updateRadarClock(); // Immediate calculation call on parse

export { formatZuluTime };
