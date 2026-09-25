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
  protocol.add(new PMTiles(archiveUrl));
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
// Fires synchronously inside the Locate tap, so iOS accepts the permission request here.
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

// ---------- layers added once style is ready ----------
map.on('load', async () => {
  map.addSource('gpx', { type: 'geojson', data: emptyFC() });
  map.addLayer({
    id: 'gpx-line', type: 'line', source: 'gpx',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#a855f7', 'line-width': 5, 'line-opacity': 0.9 },
  });

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
  // difficulty lines, like mtbmap.no's overview. The detailed styling takes over at z11.
  map.addLayer({
    id: 'trails-overview', type: 'line', ...trailSource, maxzoom: 11,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': TRAIL_COLOR,
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1, 11, 2],
      'line-opacity': TRAIL_OPACITY,
    },
  });

  // From z11, mtbmap.no's look: a solid difficulty-coloured line with the way type drawn
  // as a black pattern on top, and a thin class:bicycle:mtb halo underneath.
  const BASE_WIDTH = ['interpolate', ['linear'], ['zoom'], 11, 3, 16, 8];
  const HALO_WIDTH = ['interpolate', ['linear'], ['zoom'], 11, 7, 16, 15];
  const PATTERN_WIDTH = ['interpolate', ['linear'], ['zoom'], 11, 1, 16, 2.5];
  const addDetailLine = (id, filter, paint, cap = 'round') => map.addLayer({
    id, type: 'line', ...trailSource, minzoom: 11, filter,
    layout: { 'line-cap': cap, 'line-join': 'round' },
    paint,
  });

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
  });

  status(vectorTrails
    ? 'Ready. Trails cover Norway only.'
    : 'Trail data needs a connection.', !vectorTrails);
});

const emptyFC = () => ({ type: 'FeatureCollection', features: [] });
// ---------- Locate ----------
$('locate').addEventListener('click', () => geolocate.trigger());

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
