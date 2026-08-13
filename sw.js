// mtbrrrr service worker — fast, cache-first for map data.
// Bump APP_CACHE whenever app.js/sw.js change meaningfully: activate() drops caches not in the
// keep-list, so install() refetches the shell instead of relying on stale-while-revalidate to
// notice. Leave TILE_CACHE alone — renaming it would throw away the map tiles, DEM and trail
// data that make cached areas work offline.
const APP_CACHE = 'app-v4';
const TILE_CACHE = 'tiles-v1';

// Local app shell to precache on install.
const SHELL = [
  './',
  './index.html',
  './app.js',
  './manifest.webmanifest',
  'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/+esm',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css',
];

// Hosts whose responses are map data — cache-first so revisits are instant/offline.
const TILE_HOSTS = [
  'tiles.openfreemap.org',
  'api.maptiler.com',            // MapTiler Outdoor base (tiles, sprite, glyphs)
  's3.amazonaws.com',            // terrarium DEM
  'overpass.ivarnilsen.com',     // self-hosted Overpass (Norway) — see deploy/overpass/
  'overpass-api.de',             // MTB trail queries (public mirrors)
  'overpass.kumi.systems',
  'maps.mail.ru',
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

// Marker the app appends to force a network refetch of one URL (see revalidateStaleCells
// in app.js). It never reaches the network or the cache key — we strip it below.
const REVALIDATE_PARAM = '_rv';

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (TILE_HOSTS.includes(url.hostname)) {
    if (url.searchParams.has(REVALIDATE_PARAM)) {
      event.respondWith(revalidate(url, req, TILE_CACHE));
      return;
    }
    event.respondWith(cacheFirst(req, TILE_CACHE));
    return;
  }
  // App shell + everything else: stale-while-revalidate.
  event.respondWith(staleWhileRevalidate(req, APP_CACHE));
});

// Network-first for a single URL, replacing whatever is cached under it.
//
// Two details are load-bearing:
//
// 1. The marker param is STRIPPED from both the network request and the cache key. Refetching
//    with a cache-busting URL instead would leave the stale entry untouched and add a second
//    one beside it, so the cache would grow forever and never actually refresh. Stripping it
//    means we overwrite the entry the normal cache-first path reads.
// 2. The cached copy is only replaced on success, and is returned as the fallback on failure.
//    Deleting first and then fetching would lose the offline copy whenever the refresh fails —
//    exactly when you're out of signal and need it most.
//
// A marker param is used rather than `fetch(url, {cache: 'reload'})` because reading
// Request.cache back inside a service worker isn't reliable across browsers, and a custom
// header would turn these simple cross-origin GETs into preflighted requests.
// Remove the marker while leaving every other byte of the URL untouched.
//
// This is deliberately string surgery rather than URL/searchParams. Round-tripping through
// URLSearchParams re-encodes the whole query as application/x-www-form-urlencoded — spaces
// become "+", "(" becomes "%28" — so the result no longer matches the encodeURIComponent form
// the app requested with. That would be a DIFFERENT cache key: the refresh would write a
// second entry and the stale one it was meant to replace would live forever. Splitting on raw
// "&" is safe because encodeURIComponent escapes any literal ampersand in the query as %26.
function stripMarker(rawUrl) {
  const cut = rawUrl.indexOf('?');
  if (cut === -1) return rawUrl;
  const base = rawUrl.slice(0, cut);
  const kept = rawUrl.slice(cut + 1).split('&').filter((p) => !p.startsWith(REVALIDATE_PARAM + '='));
  return kept.length ? `${base}?${kept.join('&')}` : base;
}

async function revalidate(url, req, cacheName) {
  const cleanReq = new Request(stripMarker(req.url), { headers: req.headers, mode: req.mode });
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(cleanReq);
    if (res && (res.ok || res.type === 'opaque')) {
      await cache.put(cleanReq, res.clone());
      return res;
    }
    return (await cache.match(cleanReq)) || res;
  } catch (err) {
    return (await cache.match(cleanReq)) || Response.error();
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
