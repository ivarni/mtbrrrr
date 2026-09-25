#!/usr/bin/env sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
archive="$root/deploy/rocky-linux/site/data/${1:-fixture}/trails.pmtiles"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
read z8x z8y z11x z11y z13x z13y z16x z16y leftx lefty rightx righty <<EOF
$(python3 - <<'PY'
import math
def tile(lon, lat, z):
 return int((lon + 180) / 360 * 2**z), int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * 2**z)
for z in (8, 11, 13, 16): print(*tile(10.8658, 60.0312, z), end=' ')
print(*tile(10.8450, 60.0312, 16), *tile(10.8850, 60.0312, 16))
PY
)
EOF
for zxy in "8 $z8x $z8y" "11 $z11x $z11y" "13 $z13x $z13y" "16 $z16x $z16y" "16 $leftx $lefty" "16 $rightx $righty"; do
  set -- $zxy
  docker run --rm -v "$root:/work:ro" ghcr.io/protomaps/go-pmtiles@sha256:06574f01f55a78f78f887bc7ebf729a5c093c0d6e17d9876300cfcb0758b59d3 tile "/work/${archive#$root/}" "$1" "$2" "$3" > "$tmp/$1-$2-$3.mvt"
done
docker run --rm -v "$tmp:/data:ro" \
  -e Z8="8-$z8x-$z8y" -e Z11="11-$z11x-$z11y" -e Z13="13-$z13x-$z13y" -e Z16="16-$z16x-$z16y" \
  -e LEFT="16-$leftx-$lefty" -e RIGHT="16-$rightx-$righty" \
  python:3.13-slim sh -ceu '
  pip install -q mapbox-vector-tile
  python - <<"PY"
import gzip
import os
from mapbox_vector_tile import decode
required = {"osm_id", "name", "mtbname", "grade", "mtbclass", "highway", "tracktype"}
def features(name):
 return decode(gzip.decompress(open(f"/data/{name}.mvt", "rb").read())).get("trails", {"features": []})["features"]
z8, z11, z13, z16 = (features(os.environ[name]) for name in ("Z8", "Z11", "Z13", "Z16"))
left, right = (features(os.environ[name]) for name in ("LEFT", "RIGHT"))
assert z8 and z11 and z13 and z16
assert {f["properties"]["osm_id"] for f in z8} == {"osm:way/101", "osm:way/104", "osm:way/106", "osm:way/108"}
assert all(required <= f["properties"].keys() for f in z8 + z13 + z16)
assert "osm:way/106" in {f["properties"]["osm_id"] for f in z11}
assert all(f["properties"]["name"] or f["properties"]["mtbname"] or f["properties"]["grade"] or f["properties"]["mtbclass"] for f in z11)
assert {f["properties"]["osm_id"]: f["properties"]["mtbname"] for f in z11}.get("osm:way/108") == "MTB-only name"
assert {"path", "track", "bridleway", "cycleway", "footway"} <= {f["properties"]["highway"] for f in z13}
assert len({f["properties"]["osm_id"] for f in z16}) == len(z16)
assert "osm:way/106" in {f["properties"]["osm_id"] for f in left}
assert "osm:way/106" in {f["properties"]["osm_id"] for f in right}
print(f"z8={len(z8)} z11={len(z11)} z13={len(z13)} z16={len(z16)}: schema, zoom rules, and boundary ID ok")
PY
'
