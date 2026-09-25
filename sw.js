// mtbrrrr service worker — fast, cache-first for map data.
// Bump APP_CACHE whenever app.js/sw.js change meaningfully: activate() drops caches not in the
// keep-list, so install() refetches the shell instead of relying on stale-while-revalidate to
// notice. Leave TILE_CACHE alone — renaming it would throw away the map tiles, DEM and trail
// data that make cached areas work offline.
const APP_CACHE = 'app-v15';
const TILE_CACHE = 'tiles-v1';

// Local app shell to precache on install.
const SHELL = [
  './',
  './index.html',
  './app.js',
  './manifest.webmanifest',
  'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/+esm',
  'https://cdn.jsdelivr.net/npm/pmtiles@4.3.0/+esm',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css',
];

// Base-map data is cache-first. PMTiles stays online-first because range responses must not
// pass through Cache Storage.
const TILE_HOSTS = [
  'tiles.openfreemap.org',
  'api.maptiler.com',
  's3.amazonaws.com',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE).then((c) =>
      // Cache entries individually so one flaky CDN URL can't fail the whole install.
      Promise.allSettled(SHELL.map((u) => c.add(u)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => ![APP_CACHE, TILE_CACHE].includes(k)).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // PMTiles is fetched with byte ranges. Cache Storage cannot safely cache partial responses.
  if (url.pathname.endsWith('.pmtiles')) return;
  if (url.pathname.endsWith('/data/latest.json')) {
    event.respondWith(networkFirst(req, APP_CACHE));
    return;
  }

  if (TILE_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(req, TILE_CACHE));
    return;
  }
  // App shell + everything else: stale-while-revalidate.
  event.respondWith(staleWhileRevalidate(req, APP_CACHE));
});

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) await cache.put(req, res.clone());
    return res;
  } catch (err) {
    return (await cache.match(req)) || Response.error();
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    // Store opaque + ok responses alike (tiles fetched no-cors are opaque).
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
    return res;
  } catch (err) {
    return hit || Response.error();
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const fetching = fetch(req).then((res) => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => hit);
  return hit || fetching;
}
