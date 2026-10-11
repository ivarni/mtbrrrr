"""DTM10 for fixture builds: 10 m UTM33 GeoTIFFs over the bbox plus 0.1°, which also covers
fixture ways outside the tile bbox.

usage: fixture-dem.py <minlon,minlat,maxlon,maxlat> <out-dir> kartverket|synthetic

kartverket fetches real heights from Kartverket's WCS (CC BY 4.0) in 10 km tiles. synthetic
needs no network: 200 m plus 0.01 m per metre north plus gentle east-west waves, for the
deterministic test fixture.
"""
import sys
import urllib.request

import numpy as np
import rasterio
from rasterio.transform import from_origin
from rasterio.warp import transform

WCS = ('https://wcs.geonorge.no/skwms1/wcs.hoyde-dtm-nhm-25833?service=WCS&version=1.0.0'
       '&request=GetCoverage&coverage=nhm_dtm_topo_25833&crs=EPSG:25833&resx=10&resy=10&format=GeoTIFF')
TILE = 10000  # metres

bbox, out, mode = sys.argv[1:]
minlon, minlat, maxlon, maxlat = (v + d for v, d in zip(map(float, bbox.split(',')), (-.1, -.1, .1, .1)))
xs, ys = transform('EPSG:4326', 'EPSG:25833', [minlon, maxlon, minlon, maxlon], [minlat, minlat, maxlat, maxlat])
x0, y0, x1, y1 = (int(v // 10 * 10) for v in (min(xs), min(ys), max(xs) + 10, max(ys) + 10))

if mode == 'kartverket':
    for tx in range(x0, x1, TILE):
        for ty in range(y0, y1, TILE):
            box = f'{tx},{ty},{min(tx + TILE, x1)},{min(ty + TILE, y1)}'
            with urllib.request.urlopen(f'{WCS}&bbox={box}', timeout=120) as res:
                data = res.read()
            if not data.startswith((b'II*\0', b'MM\0*')):
                sys.exit(f'WCS returned no GeoTIFF for {box}: {data[:200]!r}')
            open(f'{out}/dtm-{tx}-{ty}.tif', 'wb').write(data)
else:
    w, h = (x1 - x0) // 10, (y1 - y0) // 10
    east, north = np.meshgrid(np.arange(w) * 10.0, (h - 1 - np.arange(h)) * 10.0)
    height = (200 + 0.01 * north + 15 * np.sin(east / 400)).astype('float32')
    with rasterio.open(f'{out}/synthetic.tif', 'w', driver='GTiff', width=w, height=h, count=1, dtype='float32',
                       crs='EPSG:25833', transform=from_origin(x0, y1, 10, 10), nodata=-9999) as ds:
        ds.write(height, 1)
