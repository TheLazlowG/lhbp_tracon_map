export default async function handler(req, res) {
    const lat = Number(req.query.lat || 47.4369);
    const lon = Number(req.query.lon || 19.2556);
    const dist = Number(req.query.dist || 150);

    const url =
        `https://opendata.adsb.fi/api/v3/lat/${lat}/lon/${lon}/dist/${dist}`;

    try {
        const response = await fetch(url);

        const body = await response.text();

        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Cache-Control", "no-store");

        res.status(response.status).send(body);
    } catch (error) {
        res.status(502).json({
            error: "Failed to reach ADS-B.fi",
            message: error.message
        });
    }
}