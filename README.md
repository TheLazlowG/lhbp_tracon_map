# LHBP Radar

Run `node server.js`, then open `http://127.0.0.1:8000`.
Serve the page over HTTP: the frontend uses native JavaScript modules and fetches
its datasets. No frontend build step is required.

## Frontend structure

`index.html` contains the page markup and loads `styles.css`, the browser
libraries, and the `app.js` module entry point.

| File | Responsibility |
| --- | --- |
| `app.js` | Startup, data initialization, airspace manager creation, and radar sweep scheduling |
| `config.js` | Developer settings, including `EDITOR_MODE` |
| `leaflet.js` | Bridge to Leaflet and the registration-country lookup loaded by the page |
| `map.js` | Map creation, pane ordering, basemap, runway geometry, and shared layer groups |
| `geo.js` | Bearings, heading formatting, and geographic offsets |
| `time.js` | UTC formatting and the displayed radar clock |
| `ui.js` | Settings panels, view presets, runway direction, and layer switches |
| `weather.js` | METAR and RainViewer fetching, controls, and refresh timers |
| `measurement.js` | Interactive distance and bearing measurements |
| `waypoints.js` | Waypoint loading, markers, labels, filters, and procedure initialization |
| `label-editor.js` | Waypoint label dragging, selection, and offset export |
| `procedures.js` | SID/STAR and holding geometry rendering |
| `ground-features.js` | Airport surface data, taxiway labels, stands, and zoom visibility |
| `aircraft-info.js` | Airline directory, registration metadata, aircraft panel, and photos |
| `traffic.js` | Traffic fetching, aircraft state, filtering, and track selection |
| `traffic-renderer.js` | Animation, datablocks, dragging, and canvas leader lines |
| `airspace-manager.js` | PilotNet synchronization, normalization, rendering, and filters |

Procedure definitions live in `data/procedures.json`; waypoint coordinates live
in `data/waypoints.json`. Label offsets and other datasets remain in `data/`.

Modules share named imports rather than application globals. The map module owns
the common layer groups, and the traffic module owns aircraft state. The renderer
owns its mutable drawing and drag flags; callers use its functions to change them.
The label editor and waypoint modules share the loaded waypoint data through live
imports. Their cross-module functions run after module initialization.

The application starts animation after the module graph has loaded, then loads
waypoints/procedures, airline data, and ground features, initializes airspaces,
applies the runway preset, and starts traffic polling. Airspace and procedure
renderers receive their dependencies explicitly from their callers.
