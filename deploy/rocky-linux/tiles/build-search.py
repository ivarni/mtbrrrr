"""Trail search index: search.json and profiles/<id>.json from OSM trails and DTM10 GeoTIFFs.

A profile is {"elevation": [[distance_m, elevation_m], ...64], "line": [[lon, lat], ...64],
"grades": [[from_m, mtb:scale], ...]} along the trail's longest chain; a grade run lasts until the
next one starts ("" = ungraded). The chain runs in the trail's direction: oneway tags, else the
route's member order, else incline (riding down), else from its lower end.

usage: build-search.py <trails.osm.pbf> <out-dir> <dem-dir>

Names follow process.lua: a retained way's mtb:name else name, plus every MTB route it is on.
Same-named ways far apart become separate entries. Elevation comes from every *.tif in dem-dir
(Kartverket DTM10, any one projected CRS), sampled every 20 m along the trail.
"""
import hashlib
import heapq
import json
import math
import re
import sys
from array import array
from collections import defaultdict
from pathlib import Path

import numpy as np
import osmium
import rasterio
from rasterio.warp import transform
from rasterio.windows import Window

RETAINED = {'path', 'track', 'bridleway', 'cycleway', 'footway'}
CELL = 0.01  # degrees latitude, ~1.1 km: same-named ways in neighbouring cells are one trail
STEP = 20  # metres between elevation samples
SAMPLES = 64  # points per stored profile
R = 6371000


def trail_route(tags):
    name = tags.get('name', '')
    return (tags.get('type') == 'route' and tags.get('route') == 'mtb' and name != ''
            and tags.get('state') != 'temporary' and not re.search(r'\d{4}', name))


def seg_lengths(xy):
    """Metres between consecutive (lon, lat) points; equirectangular, fine for short segments."""
    lon, lat = np.radians(xy[:, 0]), np.radians(xy[:, 1])
    dx = np.diff(lon) * np.cos((lat[1:] + lat[:-1]) / 2)
    return R * np.hypot(dx, np.diff(lat))


class Way:
    __slots__ = ('id', 'a', 'b', 'xy', 'length', 'scale', 'mtbclass', 'oneway', 'incline')


def drawn_direction(tags):
    """(oneway, incline): +1 along the way as drawn, -1 against it, 0 unknown. incline points downhill."""
    oneway = tags.get('oneway:bicycle') or tags.get('oneway', '')
    oneway = 1 if oneway in ('yes', 'true', '1') else -1 if oneway in ('-1', 'reverse') else 0
    incline = tags.get('incline', '')
    sign = -1 if incline == 'up' or re.match(r'\+?\d', incline) else 1 if incline == 'down' or incline.startswith('-') else 0
    return oneway, sign


def read_ways(path):
    routes, order = defaultdict(list), defaultdict(dict)
    for r in osmium.FileProcessor(path, osmium.osm.RELATION):
        tags = dict(r.tags)
        if trail_route(tags):
            for i, m in enumerate(r.members):
                if m.type == 'w':
                    routes[m.ref].append(tags['name'])
                    order[tags['name']].setdefault(m.ref, i)

    ways, by_name = {}, defaultdict(list)
    for w in (osmium.FileProcessor(path, osmium.osm.NODE | osmium.osm.WAY)
              .with_locations('sparse_mem_array').with_filter(osmium.filter.EntityFilter(osmium.osm.WAY))):
        tags = dict(w.tags)
        own = (tags.get('mtb:name') or tags.get('name', '')) if tags.get('highway') in RETAINED else ''
        names = set(routes.get(w.id, [])) | ({own} if own else set())
        coords = array('d')
        for n in w.nodes:
            if n.location.valid():
                coords.extend((n.lon, n.lat))
        if not names or len(coords) < 4:
            continue
        way = Way()
        way.id, way.a, way.b = w.id, w.nodes[0].ref, w.nodes[-1].ref
        way.xy = np.frombuffer(coords).reshape(-1, 2)
        way.length = float(seg_lengths(way.xy).sum())
        way.scale, way.mtbclass = tags.get('mtb:scale', ''), tags.get('class:bicycle:mtb', '')
        way.oneway, way.incline = drawn_direction(tags)
        ways[w.id] = way
        for name in names:
            by_name[name].append(way)
    return by_name, order


def clusters(ways):
    """Split one name's ways into groups whose vertices lie within a cell or its neighbours."""
    parent = list(range(len(ways)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    owner = {}
    for i, w in enumerate(ways):
        cells = set(zip(np.floor(w.xy[:, 1] / CELL).astype(int).tolist(), np.floor(w.xy[:, 0] / (2 * CELL)).astype(int).tolist()))
        for cy, cx in cells:
            for key in ((cy + dy, cx + dx) for dy in (-1, 0, 1) for dx in (-1, 0, 1)):
                if key in owner:
                    parent[find(i)] = find(owner[key])
            owner[(cy, cx)] = i
    groups = defaultdict(list)
    for i, w in enumerate(ways):
        groups[find(i)].append(w)
    return list(groups.values())


def chain(ways):
    """The longest end-to-end run of ways (farthest endpoint from anywhere, then farthest from it),
    as (points, grade runs, [(way, reversed)]).
    ponytail: ways meeting mid-way (not at endpoints) don't connect; join properly if profiles look silly."""
    edges = defaultdict(list)
    for w in ways:
        if w.a != w.b:
            edges[w.a].append((w.b, w))
            edges[w.b].append((w.a, w))

    def farthest(start):
        dist, prev, heap = {start: 0.0}, {}, [(0.0, start)]
        while heap:
            d, n = heapq.heappop(heap)
            if d > dist[n]:
                continue
            for m, w in edges[n]:
                if d + w.length < dist.get(m, math.inf):
                    dist[m], prev[m] = d + w.length, (n, w)
                    heapq.heappush(heap, (dist[m], m))
        end = max(dist, key=dist.get)
        return end, dist[end], prev

    longest = max(ways, key=lambda w: w.length)
    best, best_len = [(longest, False)], longest.length
    seen = set()
    for start in edges:
        if start in seen:
            continue
        a, _, prev = farthest(start)
        seen.update(prev, [start])
        b, length, prev = farthest(a)
        if length > best_len:
            path, n = [], b
            while n != a:
                n0, w = prev[n]
                path.append((w, w.a == n))  # w runs n0 → n on the way to b; reversed if drawn the other way
                n = n0
            best, best_len = path[::-1], length
    parts = [w.xy[::-1] if rev else w.xy for w, rev in best]
    runs, at = [], 0.0
    for w, _ in best:
        if not runs or runs[-1][1] != w.scale:
            runs.append([round(at), w.scale])
        at += w.length
    return np.concatenate([parts[0]] + [p[1:] for p in parts[1:]]), runs, best


def direction(best, order):
    """+1 to keep the chain's direction, -1 to turn it, 0 when the tags don't say."""
    oneway = sum(w.length * w.oneway * (-1 if rev else 1) for w, rev in best)
    idx = [order[w.id] for w, _ in best if w.id in order]
    route = sum((b > a) - (b < a) for a, b in zip(idx, idx[1:]))
    incline = sum(w.length * w.incline * (-1 if rev else 1) for w, rev in best)
    score = oneway or route or incline
    return (score > 0) - (score < 0)


def along(xy):
    """Points every STEP metres along the line, plus its end; returns (distances, points)."""
    cum = np.concatenate([[0], np.cumsum(seg_lengths(xy))])
    d = np.append(np.arange(0, cum[-1], STEP), cum[-1])
    return d, np.column_stack([np.interp(d, cum, xy[:, 0]), np.interp(d, cum, xy[:, 1])])


def elevations(dem_dir, lonlat):
    """Elevation per (lon, lat) point from the GeoTIFFs, NaN where none covers it."""
    out = np.full(len(lonlat), np.nan)
    files = sorted(Path(dem_dir).glob('*.tif'))
    if not files:
        sys.exit(f'no *.tif in {dem_dir}')
    crs, xs, ys = None, None, None
    for f in files:
        with rasterio.open(f) as ds:
            if crs is None:
                crs = ds.crs
                xs, ys = map(np.array, transform('EPSG:4326', crs, lonlat[:, 0], lonlat[:, 1]))
            if ds.crs != crs:
                sys.exit(f'{f}: CRS {ds.crs} differs from {crs}')
            rows, cols = rasterio.transform.rowcol(ds.transform, xs, ys)
            rows, cols = np.asarray(rows), np.asarray(cols)
            inside = np.flatnonzero((rows >= 0) & (rows < ds.height) & (cols >= 0) & (cols < ds.width) & np.isnan(out))
            # Read 1000-pixel blocks with points in them, never the whole (possibly national) raster.
            blocks = defaultdict(list)
            for i in inside:
                blocks[(rows[i] // 1000, cols[i] // 1000)].append(i)
            for (br, bc), idx in blocks.items():
                idx = np.array(idx)
                win = Window(bc * 1000, br * 1000, min(1000, ds.width - bc * 1000), min(1000, ds.height - br * 1000))
                block = ds.read(1, window=win, masked=True)
                v = block[rows[idx] - br * 1000, cols[idx] - bc * 1000]
                out[idx] = np.ma.filled(v.astype(float), np.nan)
    return out


def main(pbf, out_dir, dem_dir):
    out = Path(out_dir)
    (out / 'profiles').mkdir(parents=True, exist_ok=True)
    entries, lines = [], []
    by_name, order = read_ways(pbf)
    for name, ways in by_name.items():
        for group in clusters(ways):
            xy = np.concatenate([w.xy for w in group])
            grades = {}
            for key, attr in (('scale', 'scale'), ('class', 'mtbclass')):
                metres = defaultdict(float)
                for w in group:
                    if getattr(w, attr):
                        metres[getattr(w, attr)] += w.length
                if metres:
                    grades[key] = {k: round(v) for k, v in sorted(metres.items())}
            first = min(w.id for w in group)
            entries.append({
                'id': hashlib.sha1(f'{name}\0{first}'.encode()).hexdigest()[:12],
                'name': name,
                'bbox': [math.floor(xy[:, 0].min() * 1000) / 1000, math.floor(xy[:, 1].min() * 1000) / 1000,
                         math.ceil(xy[:, 0].max() * 1000) / 1000, math.ceil(xy[:, 1].max() * 1000) / 1000],
                'length_m': round(sum(w.length for w in group)),
                'grades': grades,
            })
            xy, runs, best = chain(group)
            lines.append((*along(xy), runs, direction(best, order.get(name, {}))))

    elev = elevations(dem_dir, np.concatenate([line[1] for line in lines]))
    start = 0
    for entry, (d, p, runs, heading) in zip(entries, lines):
        e = elev[start:start + len(p)]
        start += len(p)
        ok = ~np.isnan(e)
        if not ok.any():  # no DEM here (outside mainland Norway): no profile
            entry['ascent_m'] = entry['descent_m'] = None
            continue
        e = np.interp(d, d[ok], e[ok])
        if (heading or (1 if e[0] <= e[-1] else -1)) < 0:  # no tag says: climb from the lower end
            ends = [r[0] for r in runs[1:]] + [d[-1]]
            runs = [[round(d[-1] - end), g] for (_, g), end in zip(runs, ends)][::-1]
            d, p, e = d[-1] - d[::-1], p[::-1], e[::-1]
        diff = np.diff(e)
        entry['ascent_m'], entry['descent_m'] = round(diff[diff > 0].sum()), round(-diff[diff < 0].sum())
        at = np.linspace(0, d[-1], SAMPLES)
        profile = [[round(x), round(y)] for x, y in zip(at, np.interp(at, d, e))]
        line = [[round(x, 5), round(y, 5)] for x, y in zip(np.interp(at, d, p[:, 0]), np.interp(at, d, p[:, 1]))]
        (out / 'profiles' / f"{entry['id']}.json").write_text(
            json.dumps({'elevation': profile, 'line': line, 'grades': runs}, separators=(',', ':')))

    entries.sort(key=lambda e: (e['name'].casefold(), -e['length_m']))
    (out / 'search.json').write_text(json.dumps(entries, ensure_ascii=False, separators=(',', ':')))
    print(f'{len(entries)} trails, {start} elevation samples')


if __name__ == '__main__':
    main(*sys.argv[1:])
