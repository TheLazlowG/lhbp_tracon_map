import { GND_VIEW_ZOOM, apronStyle, apronsGroup, map, runwayFillStyle, runwaysGroup, standsGroup, taxiwayLabelsGroup, taxiwayLineStyle, taxiwayLinesGroup, taxiwayStyle, taxiwaysGroup } from './map.js';
import { L } from './leaflet.js';

// Airport ground data loading and zoom-dependent visibility.

// ==========================================
// Zoom-Gated Layers: taxiway labels and stand
// markers only render once zoomed in enough to
// be legible, in addition to their own checkbox.
//   - Taxiway labels: visible from (GND view zoom - 1) and up
//   - Stands: visible from GND view zoom and up
// ==========================================
const TAXIWAY_LABEL_MIN_ZOOM = GND_VIEW_ZOOM - 1;
const STANDS_MIN_ZOOM = GND_VIEW_ZOOM;

function updateZoomGatedLayers() {
    const currentZoom = map.getZoom();

    const groundFeaturesChecked = document.getElementById('layer-ground-features').checked;
    const showTaxiwayLabels = groundFeaturesChecked && currentZoom >= TAXIWAY_LABEL_MIN_ZOOM;
    if (showTaxiwayLabels) {
        if (!map.hasLayer(taxiwayLabelsGroup)) map.addLayer(taxiwayLabelsGroup);
    } else {
        if (map.hasLayer(taxiwayLabelsGroup)) map.removeLayer(taxiwayLabelsGroup);
    }

    const standsChecked = document.getElementById('layer-stands').checked;
    const showStands = standsChecked && currentZoom >= STANDS_MIN_ZOOM;
    if (showStands) {
        if (!map.hasLayer(standsGroup)) map.addLayer(standsGroup);
    } else {
        if (map.hasLayer(standsGroup)) map.removeLayer(standsGroup);
    }
}

map.on('zoomend', updateZoomGatedLayers);
document.getElementById('layer-ground-features').addEventListener('change', updateZoomGatedLayers);
document.getElementById('layer-stands').addEventListener('change', updateZoomGatedLayers);
// Initial sync in case the map loads already zoomed past a threshold
updateZoomGatedLayers();

// Load ground features (runways/taxiways/aprons) parsed from X-Plane apt.dat
async function loadGroundFeatures() {
    try {
        const response = await fetch('data/ground-features.geojson');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const geojson = await response.json();

        let runwayCount = 0;
        let taxiwayCount = 0;
        let apronCount = 0;

        L.geoJSON(geojson, {
            style: function(feature) {
                if (feature.properties.category === 'runway') return runwayFillStyle;
                return feature.properties.category === 'taxiway' ? taxiwayStyle : apronStyle;
            },
            onEachFeature: function(feature, layer) {
                const cat = feature.properties.category;
                let targetGroup;
                if (cat === 'runway') {
                    targetGroup = runwaysGroup;
                    runwayCount++;
                } else if (cat === 'taxiway') {
                    targetGroup = taxiwaysGroup;
                    taxiwayCount++;
                } else {
                    targetGroup = apronsGroup;
                    apronCount++;
                }
                targetGroup.addLayer(layer);
            }
        });

        console.log(`Ground features loaded: ${runwayCount} runways, ${taxiwayCount} taxiways, ${apronCount} aprons.`);
    } catch (err) {
        console.warn("Ground features (data/ground-features.geojson) unavailable:", err);
    }
}

// Load OSM-derived taxiway centerlines (with real taxiway designators)
// and render them as thin white lines with ref labels.
async function loadTaxiwayLines() {
    try {
        const response = await fetch('data/taxiway-lines.geojson');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const geojson = await response.json();

        let lineCount = 0;
        let labelCount = 0;

        L.geoJSON(geojson, {
            filter: function(feature) {
                return feature.geometry.type === 'LineString';
            },
            style: function() {
                return taxiwayLineStyle;
            },
            onEachFeature: function(feature, layer) {
                taxiwayLinesGroup.addLayer(layer);
                lineCount++;

                const ref = feature.properties && feature.properties.ref;
                if (ref && layer.getLatLngs) {
                    const latlngs = layer.getLatLngs();
                    if (latlngs.length > 0) {
                        const mid = latlngs[Math.floor(latlngs.length / 2)];
                        const label = L.marker(mid, {
                            pane: 'taxiwayLinesPane',
                            interactive: false,
                            icon: L.divIcon({
                                className: 'taxiway-label',
                                html: `<span>${ref}</span>`,
                                iconSize: null
                            })
                        });
                        taxiwayLabelsGroup.addLayer(label);
                        labelCount++;
                    }
                }
            }
        });

        console.log(`Taxiway lines loaded: ${lineCount} lines, ${labelCount} labels.`);
    } catch (err) {
        console.warn("Taxiway lines (data/taxiway-lines.geojson) unavailable:", err);
    }
}

// Load aircraft parking stand positions (from AIP Parking/Docking Chart
// INS coordinates) and render each as a small marker + label.
async function loadStands() {
    try {
        const response = await fetch('data/stands.geojson');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const geojson = await response.json();

        let count = 0;

        L.geoJSON(geojson, {
            pointToLayer: function(feature, latlng) {
                const standId = (feature.properties && feature.properties.stand) || '?';
                const marker = L.marker(latlng, {
                    pane: 'taxiwayLinesPane',
                    interactive: false,
                    icon: L.divIcon({
                        className: 'stand-marker',
                        html: `<div class="stand-dot"></div><div class="stand-label">${standId}</div>`,
                        iconSize: null
                    })
                });
                standsGroup.addLayer(marker);
                count++;
                return marker;
            }
        });

        console.log(`Stands loaded: ${count} positions.`);
    } catch (err) {
        console.warn("Stands (data/stands.geojson) unavailable:", err);
    }
}

export { loadGroundFeatures, loadStands, loadTaxiwayLines };
