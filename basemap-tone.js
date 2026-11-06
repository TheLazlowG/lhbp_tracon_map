import { L } from './leaflet.js';

// Apply only to label-free raster tiles. A hue mask misses neutral highways
// and cyan streams, so compress all bright map ink to a common dark-grey ceiling.
// The soft knee preserves antialiased edges and leaves dark terrain unchanged.
export function softenBasemapPixels(data) {
    for (let i = 0; i < data.length; i += 4) {
        if (!data[i + 3]) continue;
        const luminance = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        const grey = Math.round(luminance <= 20
            ? luminance
            : 20 + 20 * (1 - Math.exp(-(luminance - 20) / 20)));
        data[i] = data[i + 1] = data[i + 2] = grey;
    }
}

export const SoftBasemapTileLayer = L.TileLayer.extend({
    createTile(coords, done) {
        const tile = document.createElement('img');
        tile.alt = '';
        tile.setAttribute('role', 'presentation');
        tile.crossOrigin = 'anonymous';
        const url = this.getTileUrl(coords);
        tile.onerror = () => {
            // Retry without pixel access if the provider stops allowing CORS.
            tile.removeAttribute('crossorigin');
            tile.style.filter = 'grayscale(1) brightness(0.3)';
            tile.onload = () => done(null, tile);
            tile.onerror = () => done(new Error('Basemap tile failed to load'), tile);
            tile.src = url;
        };
        tile.onload = () => {
            const image = tile;
            try {
                const canvas = document.createElement('canvas');
                canvas.width = image.naturalWidth;
                canvas.height = image.naturalHeight;
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                ctx.drawImage(image, 0, 0);
                const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
                softenBasemapPixels(pixels.data);
                ctx.putImageData(pixels, 0, 0);
                const originalUrl = image.src;
                image.onload = () => done(null, image);
                image.onerror = () => {
                    image.onerror = () => done(new Error('Basemap tile failed to load'), image);
                    image.src = originalUrl;
                };
                image.src = canvas.toDataURL();
            } catch (error) {
                // A provider CORS change must not make otherwise valid tiles vanish.
                image.style.filter = 'grayscale(1) brightness(0.3)';
                console.warn('Basemap pixel correction unavailable; using fallback dimming', error);
                done(null, image);
            }
        };
        tile.src = url;
        return tile;
    }
});
