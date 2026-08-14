// Vercel serverless function: api/metar.js
//
// AviationWeather.gov does not permit browser CORS. This endpoint fetches
// the METAR server-side and returns it to the same-origin radar page.

export default async function handler(req, res) {
  try {
    const ids = String(req.query?.ids || 'LHBP')
      .split(',')
      .map(s => s.trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 20);

    if (!ids.length) {
      return res.status(400).json({ error: 'Missing ids parameter' });
    }

    const target = new URL('https://aviationweather.gov/api/data/metar');
    target.searchParams.set('ids', ids.join(','));
    target.searchParams.set('format', 'raw');

    const response = await fetch(target, {
      headers: {
        'User-Agent': 'LHBP-Tracon-METAR/1.0 (aviation radar display)'
      }
    });

    const body = await response.text();

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');

    return res.status(response.status).send(body);
  } catch (err) {
    console.error('METAR proxy error:', err);

    return res.status(502).json({
      error: 'Unable to fetch AviationWeather.gov METAR',
      message: err instanceof Error ? err.message : String(err)
    });
  }
}