const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = 8000;
const HOST = "127.0.0.1";

const ADSB_API = "https://opendata.adsb.fi/api/v3";
const METAR_API = "https://aviationweather.gov/api/data/metar";

function send(res, status, body, type="text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store"
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);

    // ============================================================
    // ADS-B.fi proxy
    // ============================================================
    if (url.pathname === "/api/aircraft") {
      const lat = Number(url.searchParams.get("lat"));
      const lon = Number(url.searchParams.get("lon"));
      const dist = Number(url.searchParams.get("dist"));

      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        !Number.isFinite(dist) ||
        lat < -90 ||
        lat > 90 ||
        lon < -180 ||
        lon > 180 ||
        dist < 1 ||
        dist > 250
      ) {
        return send(res, 400, "Invalid lat/lon/dist");
      }

      const target =
        `${ADSB_API}/lat/${lat}/lon/${lon}/dist/${dist}`;

      const response = await fetch(target, {
        headers: {
          "User-Agent": "simple-adsbfi-viewer/1.0"
        }
      });

      const body = await response.text();

      res.writeHead(response.status, {
        "Content-Type":
          response.headers.get("content-type") ||
          "application/json",
        "Cache-Control": "no-store"
      });

      return res.end(body);
    }

    // ============================================================
    // METAR proxy
    // Mirrors Vercel /api/metar
    // ============================================================
    if (url.pathname === "/api/metar") {
      const idsParam = url.searchParams.get("ids") || "LHBP";

      const ids = idsParam
        .split(",")
        .map(s => s.trim().toUpperCase())
        .filter(Boolean)
        .slice(0, 20);

      if (!ids.length) {
        return send(res, 400, "Missing ids parameter");
      }

      const target = new URL(METAR_API);
      target.searchParams.set("ids", ids.join(","));
      target.searchParams.set("format", "raw");

      const response = await fetch(target, {
        headers: {
          "User-Agent":
            "LHBP-Tracon-METAR/1.0 (aviation radar display)"
        }
      });

      const body = await response.text();

      res.writeHead(response.status, {
        "Content-Type":
          response.headers.get("content-type") ||
          "text/plain; charset=utf-8",
        "Cache-Control": "no-store"
      });

      return res.end(body);
    }

    // ============================================================
    // Static files
    // ============================================================
    let file = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = path.join(__dirname, file);

    if (!filePath.startsWith(__dirname) || !fs.existsSync(filePath)) {
      return send(res, 404, "Not found");
    }

    const ext = path.extname(filePath);

    const type =
      ext === ".html"
        ? "text/html; charset=utf-8"
        : ext === ".js"
        ? "text/javascript; charset=utf-8"
        : ext === ".css"
        ? "text/css; charset=utf-8"
        : "application/octet-stream";

    send(res, 200, fs.readFileSync(filePath), type);

  } catch (err) {
    console.error(err);
    send(res, 502, `Proxy error: ${err.message}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ADS-B.fi viewer: http://${HOST}:${PORT}`);
});