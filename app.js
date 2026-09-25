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
const saved = fixtureMode
  ? { center: [10.8658, 60.0345], zoom: 16 }
  : JSON.parse(localStorage.getItem('view') || 'null') || { center: [10.75, 59.91], zoom: 12 }; // Oslo-ish default

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
  fitBoundsOptions: { maxZoom: 17 },
  trackUserLocation: true,
  showUserHeading: true,
});
map.addControl(geolocate, 'top-left');

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

  // class:bicycle:mtb casings, drawn UNDER the trail line (added first) and wider so they
  // peek out. Positive value (good for MTB) → bright yellow highlight; negative value
  // (poor for MTB) → a faint translucent tan. mtbclass is a string; to-number("") → 0 so
  // untagged/zero paths get neither.
  map.addLayer({
    id: 'trails-highlight',
    type: 'line',
    source: 'trails',
    ...(vectorTrails && { 'source-layer': 'trails' }),
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
    ...(vectorTrails && { 'source-layer': 'trails' }),
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
      id, type: 'line', source: 'trails', ...(vectorTrails && { 'source-layer': 'trails' }), filter,
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
    ...(vectorTrails && { 'source-layer': 'trails' }),
    filter: ['in', ['get', 'grade'], ['literal', ['4', '5', '6']]],
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: {
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 2, 16, 5],
      'line-color': '#111111',
      'line-dasharray': [2, 2],
    },
  });

  $('trails').setAttribute('aria-pressed', String(trailsOn));
  if (vectorTrails) setTrailVisibility();

  status(vectorTrails
    ? 'Ready. Trails cover Norway only.'
    : 'Trail data needs a connection.', !vectorTrails);
});

const emptyFC = () => ({ type: 'FeatureCollection', features: [] });
// ---------- Locate ----------
$('locate').addEventListener('click', () => geolocate.trigger());

// ---------- PMTiles trails ----------
let trailsOn = fixtureMode || localStorage.getItem('trailsOn') === '1';
const trailLayerIds = ['trails-highlight', 'trails-fade', 'trails-path', 'trails-track-g1', 'trails-track-g2', 'trails-track-g3', 'trails-track-g4', 'trails-track-g5', 'trails-bridleway', 'trails-cycleway', 'trails-line-hard'];
function setTrailVisibility() {
  for (const id of trailLayerIds) map.setLayoutProperty(id, 'visibility', trailsOn ? 'visible' : 'none');
}

$('trails').addEventListener('click', (e) => {
  trailsOn = !trailsOn;
  e.currentTarget.setAttribute('aria-pressed', String(trailsOn));
  if (!fixtureMode) localStorage.setItem('trailsOn', trailsOn ? '1' : '0');
  if (vectorTrails) {
    setTrailVisibility();
    status(trailsOn ? 'Trails on. Norway only.' : 'Trails off.');
  } else {
    status('Trail data needs a connection.');
  }
});

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
