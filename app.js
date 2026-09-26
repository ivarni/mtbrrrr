import maplibregl from 'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/+esm';

// `?fixture=name` uses a local archive; production reads the current immutable archive from
// data/latest.json. A missing manifest leaves the app shell usable without trail data.
const requestedFixture = new URLSearchParams(location.search).get('fixture');
const fixtureName = requestedFixture === '1' ? 'fixture' : requestedFixture;
const fixtureMode = fixtureName !== null;
const fixtureUrl = fixtureMode && new URL(`./deploy/rocky-linux/site/data/${fixtureName || 'fixture'}/trails.pmtiles`, location.href).href;
let vectorTrails = false;
const manifest = navigator.onLine
  ? fetch('./data/latest.json', { cache: 'no-store' })
    .then((res) => res.ok ? res.json() : Promise.reject(new Error(`manifest ${res.status}`)))
    .then(({ archive }) => new URL(`./data/${archive}`, location.href).href)
  : Promise.reject(new Error('offline'));
const trailsReady = (fixtureUrl ? Promise.resolve(fixtureUrl) : manifest).then(async (archiveUrl) => {
  const { PMTiles, Protocol } = await import('https://cdn.jsdelivr.net/npm/pmtiles@4.3.0/+esm');
  const protocol = new Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);
  const archive = new PMTiles(archiveUrl);
  protocol.add(archive);
  // Fetch the header + root directory while the base map loads; MapLibre's first request reuses it.
  // pmtiles caches a failed header fetch for good, so on failure swap in a fresh instance and let
  // MapLibre's own first request retry.
  archive.getHeader().catch(() => protocol.add(new PMTiles(archiveUrl)));
  vectorTrails = archiveUrl;
}).catch(() => {});

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
// A URL hash (#zoom/lat/lng) overrides all of this: MapLibre applies it in the constructor.
// With no saved view we show all of mainland Norway, then fly to the user if GPS is allowed.
// MapLibre throws on an out-of-range hash (e.g. a mangled shared link), so drop those first.
const hashParts = location.hash.slice(1).split('/').map(Number);
if (location.hash && !(hashParts.length >= 3 && hashParts.every(Number.isFinite) && Math.abs(hashParts[1]) <= 90)) {
  history.replaceState(history.state, '', location.pathname + location.search);
}
const saved = fixtureMode
  ? { center: [10.8658, 60.0345], zoom: 16 }
  : JSON.parse(localStorage.getItem('view') || 'null');
const NORWAY = [[4.5, 57.9], [31.2, 71.2]];
const firstVisit = !saved && !location.hash; // read now: the map writes a hash as soon as it exists

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
  ...(saved ? { center: saved.center, zoom: saved.zoom } : { bounds: NORWAY }),
  hash: true,
  maxPitch: 75,
  attributionControl: { compact: true },
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-left');

const geolocate = new maplibregl.GeolocateControl({
  positionOptions: { enableHighAccuracy: true },
  fitBoundsOptions: { maxZoom: 17 },
  trackUserLocation: true,
});
map.addControl(geolocate, 'top-left');

// MapLibre 4.x has no heading indicator, so draw our own cone under the location dot. It
// follows the compass (device orientation) standing still and the GPS course while moving.
const headingMarker = new maplibregl.Marker({
  element: Object.assign(document.createElement('div'), { className: 'heading-cone' }),
  anchor: 'bottom', // the cone's tip sits on the location and is the rotation pivot
  rotationAlignment: 'map',
  pitchAlignment: 'map',
});
const orientationEvent = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
let lastPosition = null;
let coneShown = false;
let compassWanted = false;
let gpsHeading = null;
let compassHeading = null; // latest true-north compass reading, kept while moving

// Phone compasses read magnetic north; the map uses true north. ponytail: bilinear fit to
// WMM-2025 over mainland Norway (max error 0.34°, drifts ~0.2°/year): refit from WMM-2030.
const declination = ([lon, lat]) => 3.3596 - 0.7328 * lon - 0.0426 * lat + 0.0187 * lon * lat;

function showHeading(degrees) {
  if (!lastPosition) return;
  headingMarker.setRotation(degrees);
  if (!coneShown) { headingMarker.setLngLat(lastPosition).addTo(map); coneShown = true; }
}

function hideHeading() {
  headingMarker.remove();
  coneShown = false;
}

function onOrientation(e) {
  // iOS gives degrees clockwise from north (negative = invalid); absolute alpha runs
  // counter-clockwise. 360 - alpha is where the device's top edge points at any sideways
  // tilt; the W3C spec's beta/gamma formula is the back-camera direction, undefined held flat.
  const heading = e.webkitCompassHeading ?? (e.absolute && e.alpha != null ? 360 - e.alpha : null);
  if (heading == null || heading < 0 || !lastPosition) return;
  compassHeading = (heading + declination(lastPosition) + (screen.orientation?.angle ?? 0) + 360) % 360;
  if (gpsHeading == null) showHeading(compassHeading); // moving: the GPS course wins
}

function stopCompass() {
  compassWanted = false;
  lastPosition = null;
  gpsHeading = null;
  compassHeading = null;
  window.removeEventListener(orientationEvent, onOrientation);
  hideHeading();
}

geolocate.on('geolocate', (p) => {
  const { longitude, latitude, heading, speed } = p.coords;
  lastPosition = [longitude, latitude];
  headingMarker.setLngLat(lastPosition);
  // Above ~2 m/s (7 km/h) the GPS course is true-north and steadier than the compass.
  const wasMoving = gpsHeading != null;
  gpsHeading = speed > 2 && Number.isFinite(heading) ? heading : null;
  if (!compassWanted) return;
  if (gpsHeading != null) showHeading(gpsHeading);
  // Slowed down: don't leave a stale course; fall back to the compass, or hide without one.
  else if (wasMoving) compassHeading != null ? showHeading(compassHeading) : hideHeading();
});
// Fires synchronously inside the GPS button tap, so iOS accepts the permission request here.
// requestPermission must be the first call: an await before it would lose the user gesture.
geolocate.on('trackuserlocationstart', () => {
  const ask = window.DeviceOrientationEvent?.requestPermission;
  compassWanted = true;
  (ask ? DeviceOrientationEvent.requestPermission() : Promise.resolve('granted'))
    .then((state) => {
      if (!compassWanted) return; // tracking stopped while the prompt was open
      if (state !== 'granted') return status('Compass permission denied.');
      window.addEventListener(orientationEvent, onOrientation);
    })
    .catch(() => {});
});
// trackuserlocationend also fires when a pan moves tracking to the background, where
// MapLibre keeps the dot; only stop when tracking is really off.
geolocate.on('trackuserlocationend', () => {
  if (!document.querySelector('.maplibregl-ctrl-geolocate-background')) stopCompass();
});
geolocate.on('error', (e) => { if (e.code === 1) stopCompass(); });

// First visit (no hash, no saved view): locate the user only if they already granted GPS,
// so opening the app never triggers a permission prompt by itself.
if (firstVisit) {
  map.once('load', async () => {
    const perm = await navigator.permissions?.query({ name: 'geolocation' }).catch(() => null);
    if (perm?.state === 'granted') geolocate.trigger();
  });
}

map.on('moveend', () => {
  if (fixtureMode) return;
  localStorage.setItem('view', JSON.stringify({
    center: map.getCenter().toArray(),
    zoom: map.getZoom(),
  }));
});

// ---------- Norway coverage ----------
// Geofabrik's norway.poly — the extract the trails are built from, incl. Svalbard and Jan
// Mayen — simplified to ~5 km. Panning out of it says why the map has no trails.
const NORWAY_OUTLINE = [[11.53,58.87],[11.45,58.88],[11.34,59.1],[10.65,58.88],[10.6,58.75],[8.36,57.55],[4.97,57.66],[-11.37,71.34],[9.55,81.03],[35.53,81.05],[33.5,70.87],[31.11,69.97],[30.83,69.79],[30.95,69.69],[30.92,69.54],[30.51,69.53],[30.11,69.65],[30.2,69.57],[30.12,69.46],[29.29,69.29],[29.25,69.11],[29.04,69.0],[28.8,69.11],[28.83,69.23],[29.32,69.48],[29.13,69.69],[28.4,69.81],[27.98,70.01],[27.95,70.08],[27.62,70.06],[27.04,69.9],[26.47,69.93],[25.92,69.67],[25.98,69.61],[25.87,69.54],[25.86,69.39],[25.72,69.25],[25.78,69.01],[25.63,68.88],[25.16,68.79],[25.12,68.63],[24.91,68.54],[23.87,68.83],[23.68,68.7],[23.17,68.62],[22.37,68.71],[22.17,68.95],[21.62,69.27],[21.28,69.3],[21.01,69.21],[21.12,69.11],[21.06,69.03],[20.72,69.11],[20.1,69.04],[20.31,68.93],[20.35,68.8],[19.97,68.56],[20.23,68.48],[19.92,68.35],[18.4,68.57],[18.13,68.53],[18.16,68.2],[17.9,67.96],[17.28,68.11],[16.74,67.91],[16.5,67.59],[16.1,67.44],[16.41,67.21],[16.4,67.04],[16.04,66.9],[15.39,66.48],[15.49,66.27],[15.04,66.14],[14.53,66.12],[14.63,65.81],[14.54,65.68],[14.51,65.3],[13.67,64.58],[14.12,64.47],[14.17,64.18],[13.99,64.01],[12.93,64.05],[12.69,63.96],[12.17,63.6],[12.25,63.48],[11.99,63.27],[12.23,63.0],[12.09,62.9],[12.15,62.75],[12.07,62.61],[12.31,62.27],[12.15,61.73],[12.42,61.57],[12.57,61.58],[12.88,61.35],[12.69,61.05],[12.24,61.01],[12.62,60.52],[12.62,60.4],[12.51,60.32],[12.55,60.19],[12.35,59.96],[11.87,59.84],[11.95,59.69],[11.7,59.59],[11.83,59.35],[11.79,59.1],[11.66,58.9]];
const inNorway = ([x, y]) => {
  let inside = false;
  for (let i = 0, j = NORWAY_OUTLINE.length - 1; i < NORWAY_OUTLINE.length; j = i++) {
    const [x1, y1] = NORWAY_OUTLINE[j], [x2, y2] = NORWAY_OUTLINE[i];
    if ((y1 > y) !== (y2 > y) && x < (x2 - x1) * (y - y1) / (y2 - y1) + x1) inside = !inside;
  }
  return inside;
};
let wasInNorway = true;
map.on('moveend', () => {
  const now = inNorway(map.getCenter().toArray());
  if (vectorTrails && wasInNorway && !now) status('No trails here. Trails cover Norway only.');
  wasInNorway = now;
});

// ---------- layers added once style is ready ----------
// style.load, not load: load waits for base tiles, fonts and sprites, delaying the first trail tile.
map.once('style.load', async () => {
  await trailsReady;
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

  // PMTiles supplies the production trails; the empty source keeps the shell usable offline.
  map.addSource('trails', vectorTrails
    ? { type: 'vector', url: `pmtiles://${vectorTrails}`, maxzoom: 16 }
    : { type: 'geojson', data: emptyFC() });

  const trailSource = { source: 'trails', ...(vectorTrails && { 'source-layer': 'trails' }) };
  // Draw trails above every base line/fill (water, paths, routes, lifts) but under the labels,
  // like mtbmap.no, so place names stay readable. MapTiler puts contour labels early, so anchor
  // on the first symbol layer after the last non-border line layer, not the first symbol overall;
  // trails deliberately cover those contour labels.
  const baseLayers = map.getStyle().layers;
  const lastLine = baseLayers.findLastIndex((l) => l.type === 'line' && !/border/i.test(l.id));
  const belowLabels = baseLayers.slice(lastLine + 1).find((l) => l.type === 'symbol')?.id;
  const TRAIL_COLOR = [
    'match', ['get', 'grade'],
    '0', '#22c55e',   // green
    '1', '#3b82f6',   // blue
    '2', '#ef4444',   // red
    '3', '#4b5563',   // dark grey, so the black way pattern stays visible
    '4', '#facc15', '5', '#facc15', '6', '#facc15', // yellow base under black dashes
    /* fallback: untagged */ '#9ca3af',
  ];
  // Fade lines poor for MTB (class:bicycle:mtb < 0) so they recede.
  const TRAIL_OPACITY = ['case', ['<', ['to-number', ['get', 'mtbclass'], 0], 0], 0.4, 1];

  // Below z11 the archive only holds graded and named trails: draw them as thin solid
  // difficulty lines that fade as you zoom out, like mtbmap.no's overview. The detailed
  // styling takes over at z11.
  map.addLayer({
    id: 'trails-overview', type: 'line', ...trailSource, maxzoom: 11,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': TRAIL_COLOR,
      'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.5, 8, 0.75, 11, 2],
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 6, ['*', 0.5, TRAIL_OPACITY], 11, TRAIL_OPACITY],
    },
  }, belowLabels);

  // From z11, mtbmap.no's look: a solid difficulty-coloured line with the way type drawn
  // as a black pattern on top, and a thin class:bicycle:mtb halo underneath.
  const BASE_WIDTH = ['interpolate', ['linear'], ['zoom'], 11, 3, 16, 8];
  const HALO_WIDTH = ['interpolate', ['linear'], ['zoom'], 11, 7, 16, 15];
  const PATTERN_WIDTH = ['interpolate', ['linear'], ['zoom'], 11, 1, 16, 2.5];
  const addDetailLine = (id, filter, paint, cap = 'round') => map.addLayer({
    id, type: 'line', ...trailSource, minzoom: 11, filter,
    layout: { 'line-cap': cap, 'line-join': 'round' },
    paint,
  }, belowLabels);

  // Yellow class:bicycle:mtb halo for ways good for MTB. mtbclass is a string; to-number("")
  // → 0 so untagged/zero paths get none. Poor ones (< 0) just fade via TRAIL_OPACITY.
  addDetailLine('trails-highlight', ['>', ['to-number', ['get', 'mtbclass'], 0], 0],
    { 'line-color': '#facc15', 'line-width': HALO_WIDTH, 'line-opacity': 0.95 });
  addDetailLine('trails-grade', ['!=', ['get', 'grade'], ''],
    { 'line-color': TRAIL_COLOR, 'line-width': BASE_WIDTH, 'line-opacity': TRAIL_OPACITY });
  // Black dashes over the yellow base → black-with-yellow-stripes for grade 4+.
  addDetailLine('trails-line-hard', ['in', ['get', 'grade'], ['literal', ['4', '5', '6']]],
    { 'line-color': '#111111', 'line-width': BASE_WIDTH, 'line-opacity': TRAIL_OPACITY, 'line-dasharray': [2, 2] }, 'butt');

  // The way TYPE as a black pattern, like mtbmap.no's "Ways" legend. line-dasharray can't
  // be data-driven, so each pattern is its own layer. dash is in line-width units, or null
  // for solid; dots use a round cap over a zero-length dash, dashes a crisp butt cap.
  const addTrailLine = (id, filter, dash, cap = 'butt') => addDetailLine(id, filter, {
    'line-color': '#111111', 'line-width': PATTERN_WIDTH, 'line-opacity': TRAIL_OPACITY,
    ...(dash && { 'line-dasharray': dash }),
  }, cap);

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

  // Trail names along the line, like mtbmap.no: mtb:name first (riders' names such as
  // "Bjørnars flyvende sidespor"), else name. Fonts come from the MapTiler style's glyphs.
  // Archives built before mtbname existed lack it; coalesce keeps their name labels.
  const mtbName = ['coalesce', ['get', 'mtbname'], ''];
  map.addLayer({
    id: 'trails-label', type: 'symbol', ...trailSource, minzoom: 12,
    filter: ['any', ['!=', mtbName, ''], ['!=', ['coalesce', ['get', 'name'], ''], '']],
    layout: {
      'symbol-placement': 'line',
      'text-field': ['case', ['!=', mtbName, ''], mtbName, ['get', 'name']],
      'text-font': ['Roboto Condensed Regular', 'Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 12, 10, 14, 12],
    },
    paint: { 'text-color': '#1f2937', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
  }, belowLabels);

  status(vectorTrails
    ? 'Ready. Trails cover Norway only.'
    : 'Trail data needs a connection.', !vectorTrails);
});

const emptyFC = () => ({ type: 'FeatureCollection', features: [] });

// ---------- service worker ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
