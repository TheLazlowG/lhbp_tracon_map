# Hungary Air Traffic Map — milestone 1

Static Cesium prototype for Hungary-wide live traffic, 2D/3D/tower modes, tracks, datablocks, and vertical exaggeration. If the live feed cannot be reached, it automatically renders eight moving local demo targets so all interaction can be tested offline.

## Run locally

Use any static HTTP server from this folder, for example:

```powershell
python -m http.server 8080
```

Then open `http://localhost:8080`. Opening `index.html` directly prevents the browser from loading JSON.

## Callsign library

Copy the supplied callsign library to `data/callsigns.json`. The app deliberately has no external callsign fallback; if the file is absent, it retains raw aircraft callsigns.

Expected schema:

```json
{ "WZZ": { "callsign": "WIZZAIR", "company": "WIZZ AIR", "country": "Hungary" } }
```

## Terrain

Set a domain-restricted Cesium ion access token in `app.js` (`CESIUM_ION_TOKEN`) to enable Cesium World Terrain. Without it, the app runs against the WGS84 ellipsoid.

## Next milestone

HungaroControl eAIP import pipeline; local, AIRAC-versioned airspace GeoJSON; procedures; glideslope volumes; RainViewer.
