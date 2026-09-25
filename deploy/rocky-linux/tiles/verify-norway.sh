#!/usr/bin/env sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
tiles="$root/deploy/rocky-linux/tiles"
release=${1:?usage: verify-norway.sh <release>}
archive="$root/deploy/rocky-linux/site/data/$release/trails.pmtiles"
pbf="$tiles/norway-latest.osm.pbf"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
[ -f "$archive" ] && [ -f "$pbf" ] || { echo 'archive or Norway PBF missing' >&2; exit 1; }

python3 - <<'PY' > "$tmp/tiles"
import math
for z in (11, 13, 16):
 lon, lat = 10.75, 59.91
 print(z, int((lon + 180) / 360 * 2**z), int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * 2**z))
PY
while read -r z x y; do
  docker run --rm -v "$root:/work:ro" ghcr.io/protomaps/go-pmtiles@sha256:06574f01f55a78f78f887bc7ebf729a5c093c0d6e17d9876300cfcb0758b59d3 tile "/work/${archive#$root/}" "$z" "$x" "$y" > "$tmp/$z.mvt"
done < "$tmp/tiles"
docker run --rm -v "$tmp:/data" python:3.13-slim sh -ceu '
  pip install -q mapbox-vector-tile
  python - <<"PY"
import gzip, json, os
from mapbox_vector_tile import decode
required = ("osm_id", "name", "grade", "mtbclass", "highway", "tracktype")
samples = []
for z in (11, 13, 16):
 features = decode(gzip.decompress(open(f"/data/{z}.mvt", "rb").read()))["trails"]["features"]
 feature = next(f for f in features if set(required) <= f["properties"].keys())
 samples.append({"z": z, "properties": feature["properties"], "tile_bytes": os.path.getsize(f"/data/{z}.mvt")})
open("/data/samples.json", "w").write(json.dumps(samples))
PY
'
docker run --rm -v "$tiles:/data:ro" -v "$tmp:/out" debian@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 sh -ceu '
  apt-get update -qq && apt-get install -y -qq osmium-tool python3 >/dev/null
  python3 - <<"PY"
import json
import subprocess
for sample in json.load(open("/out/samples.json")):
 way = sample["properties"]["osm_id"].split("/")[1]
 subprocess.run(["osmium", "getid", "/data/norway-latest.osm.pbf", f"w{way}", "-o", f"/out/{way}.osm"], check=True)
PY
'
docker run --rm -i -v "$tmp:/data:ro" python:3.13-slim python - <<'PY'
import json
import xml.etree.ElementTree as ET
samples = json.load(open('/data/samples.json'))
for sample in samples:
 props = sample['properties']
 way = props['osm_id'].split('/')[1]
 tags = {tag.attrib['k']: tag.attrib['v'] for tag in ET.parse(f'/data/{way}.osm').findall('.//tag')}
 expected = {'name': tags.get('name', ''), 'grade': tags.get('mtb:scale', ''), 'mtbclass': tags.get('class:bicycle:mtb', ''), 'highway': tags['highway'], 'tracktype': tags.get('tracktype', '')}
 assert {key: props[key] for key in expected} == expected, (sample['z'], props, expected)
 print(f"z{sample['z']} {props['osm_id']}: properties match PBF")
print(f"largest sampled tile: {max(sample['tile_bytes'] for sample in samples)} bytes")
PY
