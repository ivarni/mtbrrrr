#!/usr/bin/env sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
archive="$root/deploy/rocky-linux/site/data/${1:-fixture}/trails.pmtiles"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
read z11x z11y z13x z13y z16x z16y <<EOF
$(python3 - <<'PY'
import math
lon, lat = 10.8658, 60.0312
for z in (11, 13, 16):
 print(int((lon + 180) / 360 * 2**z), int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * 2**z), end=' ')
PY
)
EOF
for zxy in "11 $z11x $z11y" "13 $z13x $z13y" "16 $z16x $z16y"; do
  set -- $zxy
  docker run --rm -v "$root:/work:ro" ghcr.io/protomaps/go-pmtiles@sha256:06574f01f55a78f78f887bc7ebf729a5c093c0d6e17d9876300cfcb0758b59d3 tile "/work/${archive#$root/}" "$1" "$2" "$3" > "$tmp/$1.mvt"
done
docker run --rm -v "$tmp:/data:ro" python:3.13-slim sh -ceu '
  pip install -q mapbox-vector-tile
  python - <<"PY"
import gzip
from mapbox_vector_tile import decode
required = {"osm_id", "name", "grade", "mtbclass", "highway", "tracktype"}
def features(z):
    return decode(gzip.decompress(open(f"/data/{z}.mvt", "rb").read())).get("trails", {"features": []})["features"]
z11, z13, z16 = map(features, (11, 13, 16))
assert z11 and z13 and z16
assert all(required <= f["properties"].keys() for f in z13 + z16)
assert all(f["properties"]["name"] or f["properties"]["grade"] or f["properties"]["mtbclass"] for f in z11)
assert {"path", "track", "bridleway", "cycleway", "footway"} <= {f["properties"]["highway"] for f in z13}
assert len({f["properties"]["osm_id"] for f in z16}) == len(z16)
print(f"z11={len(z11)} z13={len(z13)} z16={len(z16)}: schema and zoom rules ok")
PY
'