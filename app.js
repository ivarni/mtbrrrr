import maplibregl from 'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/+esm';

// ---------- tiny helpers ----------
const $ = (id) => document.getElementById(id);
let statusTimer;
function status(msg, sticky = false) {
  const el = $('status');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(statusTimer);
  if (!sticky) statusTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ---------- persisted view ----------
const saved = JSON.parse(localStorage.getItem('view') || 'null') ||
  { center: [10.75, 59.91], zoom: 12 }; // Oslo-ish default

// ---------- base map ----------
// MapTiler Outdoor gives topo cartography (contours + hillshade + terrain) close to
// mtbmap.no. It needs a free key that rides in the client on this static site — so you
// MUST restrict it by HTTP referrer in the MapTiler dashboard (see deploy/MAPTILER.md).
// With no key set we fall back to keyless OpenFreeMap Liberty, so the app still works.
const MAPTILER_KEY = 'L2nUk7GSupVoqaX7eQ7m'; // referrer-restricted (public client key)
const USING_MAPTILER = !!MAPTILER_KEY;
const STYLE_URL = USING_MAPTILER
  ? `https://api.maptiler.com/maps/outdoor-v2/style.json?key=${MAPTILER_KEY}`
  : 'https://tiles.openfreemap.org/styles/liberty';

const map = new maplibregl.Map({
  container: 'map',
  style: STYLE_URL,
  center: saved.center,
  zoom: saved.zoom,
  hash: false,
  maxPitch: 75,
  attributionControl: { compact: true },
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-left');

const geolocate = new maplibregl.GeolocateControl({
  positionOptions: { enableHighAccuracy: true },
  trackUserLocation: true,
  showUserHeading: true,
});
map.addControl(geolocate, 'top-left');

map.on('moveend', () => {
  localStorage.setItem('view', JSON.stringify({
    center: map.getCenter().toArray(),
    zoom: map.getZoom(),
  }));
});

// ---------- layers added once style is ready ----------
map.on('load', () => {
  // MapTiler Outdoor already ships hillshade + contours, so only add our own keyless
  // Terrarium DEM hillshade on the Liberty fallback (which has none).
  if (!USING_MAPTILER) {
    map.addSource('dem', {
      type: 'raster-dem',
      tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
      encoding: 'terrarium',
      tileSize: 256,
      maxzoom: 13,
      attribution: 'Terrain © Mapzen / AWS',
    });
    map.addLayer({
      id: 'hillshade',
      type: 'hillshade',
      source: 'dem',
      paint: {
        // The Terrarium DEM maxes at z13; past that MapLibre stretches those tiles and the
        // shaded relief goes soft/hazy over the whole map. Fade the effect to nothing by z15
        // (there's no hillshade-opacity, so we ramp exaggeration — 0 renders flat/invisible).
        'hillshade-exaggeration': ['interpolate', ['linear'], ['zoom'], 13, 0.5, 15, 0],
        'hillshade-shadow-color': '#33251b',
      },
    });
  }

  // MapTiler Outdoor draws no wetland fill, so marshes/bogs fall through to the pale
  // background and look white. Render them the classic blue-hatched way (like mtbmap.no):
  // a pale base fill + a generated horizontal-blue-line pattern on top. Inserted at the
  // landcover level (before 'Water'), so it sits under water/roads/trails/labels.
  if (map.getSource('maptiler_planet') && map.getLayer('Water')) {
    const S = 12, cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const ctx = cv.getContext('2d');
    ctx.strokeStyle = 'hsl(206, 68%, 55%)';
    ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.moveTo(0, S / 2); ctx.lineTo(S * 0.6, S / 2); ctx.stroke(); // a dash
    map.addImage('wetland-hatch', ctx.getImageData(0, 0, S, S), { pixelRatio: 2 });

    const wetland = ['==', 'class', 'wetland'];
    map.addLayer({
      id: 'wetland-fill', type: 'fill', source: 'maptiler_planet', 'source-layer': 'landcover',
      filter: wetland, paint: { 'fill-color': 'hsl(200, 45%, 95%)' },
    }, 'Water');
    map.addLayer({
      id: 'wetland-lines', type: 'fill', source: 'maptiler_planet', 'source-layer': 'landcover',
      filter: wetland, paint: { 'fill-pattern': 'wetland-hatch', 'fill-opacity': 0.9 },
    }, 'Water');
  }

  // Empty sources we fill on demand.
  map.addSource('trails', { type: 'geojson', data: emptyFC() });

  // class:bicycle:mtb casings, drawn UNDER the trail line (added first) and wider so they
  // peek out. Positive value (good for MTB) → bright yellow highlight; negative value
  // (poor for MTB) → a faint translucent tan. mtbclass is a string; to-number("") → 0 so
  // untagged/zero paths get neither.
  map.addLayer({
    id: 'trails-highlight',
    type: 'line',
    source: 'trails',
    filter: ['>', ['to-number', ['get', 'mtbclass'], 0], 0],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#facc15',
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 6, 16, 11],
      'line-opacity': 0.9,
      'line-blur': 0.5,
    },
  });
  map.addLayer({
    id: 'trails-fade',
    type: 'line',
    source: 'trails',
    filter: ['<', ['to-number', ['get', 'mtbclass'], 0], 0],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#b08968',
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 6, 16, 11],
      'line-opacity': 0.45,
      'line-blur': 1,
    },
  });

  // The trail line, colored by mtb:scale. line-dasharray can't be data-driven, so the
  // way TYPE (path vs track-by-grade vs bridleway vs cycleway) is split across one layer
  // per dash pattern — like mtbmap.no's "Ways" legend — all sharing these expressions.
  const TRAIL_COLOR = [
    'match', ['get', 'grade'],
    '0', '#22c55e',   // green
    '1', '#3b82f6',   // blue
    '2', '#ef4444',   // red
    '3', '#111111',   // black
    '4', '#facc15', '5', '#facc15', '6', '#facc15', // yellow base under black dashes
    /* fallback: untagged */ '#9ca3af',
  ];
  const TRAIL_WIDTH = ['interpolate', ['linear'], ['zoom'], 11, 2, 16, 5];
  // Fade lines poor for MTB (class:bicycle:mtb < 0) so they recede into the tan casing.
  const TRAIL_OPACITY = ['case', ['<', ['to-number', ['get', 'mtbclass'], 0], 0], 0.4, 1];

  // dash is a dasharray in line-width units, or null for a solid line. Dots use a round
  // cap over a zero-length dash; dashes use a butt cap so they stay crisp.
  const addTrailLine = (id, filter, dash, cap = 'butt') => {
    const paint = { 'line-color': TRAIL_COLOR, 'line-width': TRAIL_WIDTH, 'line-opacity': TRAIL_OPACITY };
    if (dash) paint['line-dasharray'] = dash;
    map.addLayer({
      id, type: 'line', source: 'trails', filter,
      layout: { 'line-cap': cap, 'line-join': 'round' },
      paint,
    });
  };

  const isTrack = ['==', ['get', 'highway'], 'track'];
  const trackGrade = (g) => ['all', isTrack, ['==', ['get', 'tracktype'], g]];
  // Path/Trail + Footway → dotted.
  addTrailLine('trails-path', ['in', ['get', 'highway'], ['literal', ['path', 'footway']]], [0, 2], 'round');
  // Tracks → solid (G1/ungraded, smooth & firm) grading to broken (G5, bumpy/loose).
  addTrailLine('trails-track-g1', ['all', isTrack, ['in', ['get', 'tracktype'], ['literal', ['grade1', '']]]], null, 'round');
  addTrailLine('trails-track-g2', trackGrade('grade2'), [3, 2]);
  addTrailLine('trails-track-g3', trackGrade('grade3'), [3, 2, 0.8, 2]);
  addTrailLine('trails-track-g4', trackGrade('grade4'), [2, 1.5, 0.8, 1.5, 0.8, 1.5]);
  addTrailLine('trails-track-g5', trackGrade('grade5'), [0.8, 1.5, 3, 1.5]);
  // Bridleway → dashed; Cycleway → solid.
  addTrailLine('trails-bridleway', ['==', ['get', 'highway'], 'bridleway'], [4, 2]);
  addTrailLine('trails-cycleway', ['==', ['get', 'highway'], 'cycleway'], null, 'round');

  // Black dashes over the yellow base → black-with-yellow-stripes for grade 4+.
  map.addLayer({
    id: 'trails-line-hard',
    type: 'line',
    source: 'trails',
    filter: ['in', ['get', 'grade'], ['literal', ['4', '5', '6']]],
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: {
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 2, 16, 5],
      'line-color': '#111111',
      'line-dasharray': [2, 2],
    },
  });

  map.addSource('gpx', { type: 'geojson', data: emptyFC() });
  map.addLayer({
    id: 'gpx-line', type: 'line', source: 'gpx',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#a855f7', 'line-width': 5, 'line-opacity': 0.9 },
  });

  // Restore trail mode across reloads — cells come back from the SW cache offline.
  $('trails').setAttribute('aria-pressed', String(trailsOn));
  if (trailsOn) loadTrailCells();

  status('Ready. 📍 to find yourself, 🚵 for trails.');
});

const emptyFC = () => ({ type: 'FeatureCollection', features: [] });

// ---------- Locate ----------
$('locate').addEventListener('click', () => geolocate.trigger());

// ---------- MTB trails via Overpass, on a fixed grid so URLs repeat & cache ----------
// The old handler queried the exact viewport once: every pan made a new bbox URL
// (never a cache hit) and never re-ran. Instead we snap queries to a fixed lat/lon
// grid — the same cell yields a byte-identical Overpass URL every visit, so the
// service worker's cache-first strategy hits (instant/offline revisits) — and we
// auto-load cells as the map moves.
const CELL = 0.05;             // grid cell size in degrees (~5.5 km of latitude)
const TRAILS_MINZOOM = 11;     // below this a viewport spans too many cells
const MAX_CELLS_PER_LOAD = 16; // guard against huge multi-cell fetches
let trailsOn = localStorage.getItem('trailsOn') === '1';
const loadedCells = new Set();   // "ix_iy" keys already fetched this session
const trailFeatures = new Map(); // OSM way id -> feature (dedupe across cells)
const cellFeatures = new Map();  // "ix_iy" -> Set<way id> that cell last returned

const cellKey = (ix, iy) => `${ix}_${iy}`;

// How long a cell's data is trusted before a background refresh. Geofabrik cuts the Norway
// extract once a day, and the server polls hourly, so anything under ~24h would refetch data
// that cannot have changed. See deploy/overpass/INFRA.md.
const CELL_TTL_MS = 24 * 60 * 60 * 1000;
const CELL_TS_KEY = 'cellFetchedAt';
const CELL_TS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // drop entries for cells long unvisited

let cellFetchedAt = {};
try {
  const raw = JSON.parse(localStorage.getItem(CELL_TS_KEY) || '{}');
  const cutoff = Date.now() - CELL_TS_MAX_AGE_MS;
  for (const [k, t] of Object.entries(raw)) if (typeof t === 'number' && t > cutoff) cellFetchedAt[k] = t;
} catch (e) {
  cellFetchedAt = {}; // corrupt entry: treat every cell as stale rather than throwing
}

let cellTsTimer;
function touchCell(key) {
  cellFetchedAt[key] = Date.now();
  // Debounced: a multi-cell load would otherwise serialise JSON once per cell.
  clearTimeout(cellTsTimer);
  cellTsTimer = setTimeout(() => {
    try { localStorage.setItem(CELL_TS_KEY, JSON.stringify(cellFetchedAt)); } catch (e) { /* quota — freshness just falls back to per-session */ }
  }, 500);
}

// Replace what one cell contributes, so a way deleted or retagged in OSM actually disappears.
// Ways legitimately span cell boundaries, so an id is only dropped once NO cell still claims
// it — deleting on absence from this one cell alone would erase trails that are still present
// in the neighbour.
function applyCellData(key, features) {
  const previous = cellFeatures.get(key);
  const current = new Set();
  for (const f of features) {
    trailFeatures.set(f.id, f);
    current.add(f.id);
  }
  cellFeatures.set(key, current);
  if (!previous) return;
  for (const id of previous) {
    if (current.has(id)) continue;
    let claimedElsewhere = false;
    for (const owned of cellFeatures.values()) {
      if (owned.has(id)) { claimedElsewhere = true; break; }
    }
    if (!claimedElsewhere) trailFeatures.delete(id);
  }
}

// All grid cells whose bbox intersects the current view.
function cellsInView() {
  const b = map.getBounds();
  const ix0 = Math.floor(b.getWest() / CELL), ix1 = Math.floor(b.getEast() / CELL);
  const iy0 = Math.floor(b.getSouth() / CELL), iy1 = Math.floor(b.getNorth() / CELL);
  const cells = [];
  for (let ix = ix0; ix <= ix1; ix++)
    for (let iy = iy0; iy <= iy1; iy++) cells.push([ix, iy]);
  return cells;
}

// Overpass query for one grid cell — bbox snapped to the grid at fixed precision,
// so the resulting URL string is identical on every revisit.
function cellQuery(ix, iy) {
  const s = (iy * CELL).toFixed(4), w = (ix * CELL).toFixed(4);
  const n = ((iy + 1) * CELL).toFixed(4), e = ((ix + 1) * CELL).toFixed(4);
  return `[out:json][timeout:25];
    (way["highway"~"^(path|track|bridleway|cycleway|footway)$"](${s},${w},${n},${e}););
    out geom;`;
}

function renderTrails() {
  const src = map.getSource('trails');
  if (src) src.setData({ type: 'FeatureCollection', features: [...trailFeatures.values()] });
}

// Load every not-yet-loaded cell intersecting the view. Safe to call repeatedly.
let loadToken = 0;
async function loadTrailCells() {
  if (!trailsOn) return;
  if (map.getZoom() < TRAILS_MINZOOM) { status('Zoom in a bit to load trails.'); return; }
  const pending = cellsInView().filter(([ix, iy]) => !loadedCells.has(cellKey(ix, iy)));
  if (!pending.length) return;
  if (pending.length > MAX_CELLS_PER_LOAD) { status('Zoom in a bit to load trails.'); return; }

  const token = ++loadToken;
  status('Loading trails…', true);
  let failed = 0;
  for (const [ix, iy] of pending) {
    const key = cellKey(ix, iy);
    loadedCells.add(key); // mark before awaiting so overlapping moveends don't double-fetch
    try {
      const data = await overpassQuery(cellQuery(ix, iy), endpointsFor(ix, iy));
      applyCellData(key, overpassToGeoJSON(data).features);
      touchCell(key);
    } catch (err) {
      loadedCells.delete(key); // let a later pan retry this cell
      failed++;
    }
  }
  if (token !== loadToken) return; // a newer load superseded this batch
  renderTrails();
  status(failed
    ? `Trails loaded (${failed} cell(s) failed — pan to retry).`
    : `${trailFeatures.size} trail segments loaded.`);
  revalidateStaleCells(token);
}

// The service worker serves trail data cache-first and never expires it, which is what makes
// revisits instant and offline-capable — but it also means an edit in OSM would never reach a
// device that had already loaded that cell. So after painting from cache, quietly refetch any
// cell whose data is older than CELL_TTL_MS and redraw if it actually changed.
//
// Deliberately silent: it does not touch the status line, because a background refresh should
// never make the UI flicker or look like it's loading.
async function revalidateStaleCells(token) {
  if (!trailsOn || token !== loadToken) return;
  if (map.getZoom() < TRAILS_MINZOOM) return;
  const now = Date.now();
  const stale = cellsInView().filter(([ix, iy]) => {
    const key = cellKey(ix, iy);
    return loadedCells.has(key) && now - (cellFetchedAt[key] || 0) > CELL_TTL_MS;
  });
  if (!stale.length) return;

  let refreshed = false;
  for (const [ix, iy] of stale) {
    if (token !== loadToken) return; // a pan superseded us; drop the rest of the batch
    const key = cellKey(ix, iy);
    try {
      const data = await overpassQuery(cellQuery(ix, iy), endpointsFor(ix, iy), { revalidate: true });
      applyCellData(key, overpassToGeoJSON(data).features);
      touchCell(key);
      // No attempt to diff the response: a way's geometry or tags can change without the
      // feature count moving, so any successful refresh triggers one redraw at the end.
      // setData with identical data is visually a no-op, so this costs nothing when unchanged.
      refreshed = true;
    } catch (err) {
      // Keep showing the cached view and leave the timestamp alone so we retry next pan.
    }
  }
  if (refreshed && token === loadToken) renderTrails();
}

$('trails').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  trailsOn = !trailsOn;
  btn.setAttribute('aria-pressed', String(trailsOn));
  localStorage.setItem('trailsOn', trailsOn ? '1' : '0');
  if (trailsOn) {
    loadTrailCells();
  } else {
    loadedCells.clear();
    trailFeatures.clear();
    cellFeatures.clear();
    renderTrails();
    status('Trails off.');
  }
});

// Auto-load cells as the map moves (debounced) while trail mode is on.
let trailMoveTimer;
map.on('moveend', () => {
  if (!trailsOn) return;
  clearTimeout(trailMoveTimer);
  trailMoveTimer = setTimeout(loadTrailCells, 400);
});

// Self-hosted Overpass (Norway), on a single Rocky Linux box — Caddy fronting the
// wiktorn/overpass-api container; see deploy/rocky-linux/. Domain-agnostic: no domain is hardcoded.
// By the deploy convention the site is served at mtb.<domain> and Overpass at
// overpass.<domain>, so we DERIVE the endpoint from our own origin (first DNS label swapped
// to "overpass"). Empty on localhost, an IP literal, or a bare apex host — so local dev and
// non-standard setups fall back to the public mirrors. Tried first for Norway cells; each
// request carries OVERPASS_TIMEOUT so a dead host fails fast. sw.js derives the same host for
// offline cache-first. To force public-only, hardcode this to ''.
const SELF_HOSTED_OVERPASS = (() => {
  const h = location.hostname;
  if (h === 'localhost' || /^[0-9.]+$/.test(h)) return '';   // dev / IP: no self-hosted box
  const labels = h.split('.');
  if (labels.length < 3) return '';   // need a subdomain to replace (e.g. mtb.example.com)
  labels[0] = 'overpass';
  return `https://${labels.join('.')}/api/interpreter`;
})();

// Public Overpass servers are community-run and often busy — try mirrors in turn.
const PUBLIC_OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

// Rough mainland-Norway bbox (excludes Svalbard). Cells inside it go to the self-hosted
// instance first; cells abroad use the public mirrors so travelling still shows trails.
const NORWAY = { w: 4.0, s: 57.8, e: 31.5, n: 71.3 };
function cellInNorway(ix, iy) {
  const w = ix * CELL, s = iy * CELL, e = (ix + 1) * CELL, n = (iy + 1) * CELL;
  return e > NORWAY.w && w < NORWAY.e && n > NORWAY.s && s < NORWAY.n;
}
function endpointsFor(ix, iy) {
  return SELF_HOSTED_OVERPASS && cellInNorway(ix, iy)
    ? [SELF_HOSTED_OVERPASS, ...PUBLIC_OVERPASS]
    : PUBLIC_OVERPASS;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Overpass rate-limits by IP. Space requests out, and when we DO get a 429/504
// honor Retry-After so we back off instead of hammering every mirror in turn.
let overpassReadyAt = 0;               // don't send another request before this time
const OVERPASS_MIN_GAP = 800;          // ms between requests (gentle on the servers)
// Per-request timeout for the SELF-HOSTED endpoint ONLY: a dead/slow box must fail fast so we
// fall through to the public mirrors instead of stalling on the browser's long default. Public
// mirrors are left untimed on purpose — a valid large-bbox query there can legitimately take
// longer, and aborting it would exhaust the fallback chain. Feature-detected: on a browser
// without AbortSignal.timeout we just skip it (plain fetch) rather than throwing every request.
const OVERPASS_TIMEOUT = 8000;         // ms
const HAS_ABORT_TIMEOUT = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function';
function overpassFetch(url, ep) {
  return ep === SELF_HOSTED_OVERPASS && HAS_ABORT_TIMEOUT
    ? fetch(url, { signal: AbortSignal.timeout(OVERPASS_TIMEOUT) })
    : fetch(url);
}
async function overpassQuery(query, endpoints = PUBLIC_OVERPASS, { revalidate = false } = {}) {
  // GET (not POST) so the service worker can cache the response by URL —
  // that's what makes a previously-loaded area's trails work offline.
  //
  // `revalidate` appends a marker the service worker acts on and then strips, so the request
  // goes to the network and overwrites the existing cache entry instead of reading it. The
  // marker never reaches Overpass. See revalidate() in sw.js.
  const qs = '?data=' + encodeURIComponent(query) + (revalidate ? '&_rv=1' : '');
  let lastErr;
  for (const ep of endpoints) {
    const wait = overpassReadyAt - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      const res = await overpassFetch(ep + qs, ep);
      if (res.status === 429 || res.status === 504) {
        // Rate-limited / overloaded — back off before the next request anywhere.
        const ra = parseInt(res.headers.get('Retry-After') || '', 10);
        const backoff = Math.min((Number.isNaN(ra) ? 5 : ra) * 1000, 15000);
        overpassReadyAt = Date.now() + backoff;
        lastErr = new Error(res.status + ' from ' + new URL(ep).hostname);
        continue;
      }
      if (!res.ok) { lastErr = new Error(res.status + ' from ' + new URL(ep).hostname); continue; }
      overpassReadyAt = Date.now() + OVERPASS_MIN_GAP;
      return await res.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('all mirrors unavailable');
}

function overpassToGeoJSON(data) {
  const features = [];
  for (const el of data.elements || []) {
    if (el.type !== 'way' || !el.geometry) continue;
    features.push({
      type: 'Feature',
      id: el.id, // OSM way id — used to dedupe ways that span multiple grid cells
      properties: {
        grade: (el.tags && el.tags['mtb:scale']) ?? '',
        mtbclass: (el.tags && el.tags['class:bicycle:mtb']) ?? '',
        tracktype: (el.tags && el.tags.tracktype) ?? '',
        name: (el.tags && el.tags.name) || '',
        highway: (el.tags && el.tags.highway) || '',
      },
      geometry: {
        type: 'LineString',
        coordinates: el.geometry.map((p) => [p.lon, p.lat]),
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

// ---------- GPX overlay ----------
$('gpx').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const fc = gpxToGeoJSON(text);
    if (!fc.features.length) { status('No tracks found in GPX.'); return; }
    map.getSource('gpx').setData(fc);
    const bounds = fcBounds(fc);
    if (bounds) map.fitBounds(bounds, { padding: 60, maxZoom: 15 });
    status(`Loaded ${file.name}`);
  } catch (err) {
    status('GPX error: ' + err.message);
  } finally {
    e.target.value = '';
  }
});

// Minimal GPX parser: track + route points -> LineStrings. No dependency needed.
function gpxToGeoJSON(text) {
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  const features = [];
  const collect = (tag) => {
    for (const seg of xml.getElementsByTagName(tag)) {
      const pts = seg.getElementsByTagName('trkpt').length
        ? seg.getElementsByTagName('trkpt')
        : seg.getElementsByTagName('rtept');
      const coords = [];
      for (const pt of pts) {
        const lon = parseFloat(pt.getAttribute('lon'));
        const lat = parseFloat(pt.getAttribute('lat'));
        if (!isNaN(lon) && !isNaN(lat)) coords.push([lon, lat]);
      }
      if (coords.length > 1) features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } });
    }
  };
  collect('trkseg');
  collect('rte');
  return { type: 'FeatureCollection', features };
}

function fcBounds(fc) {
  let b = null;
  for (const f of fc.features) {
    for (const c of f.geometry.coordinates) {
      if (!b) b = new maplibregl.LngLatBounds(c, c);
      else b.extend(c);
    }
  }
  return b;
}

// ---------- service worker ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
