#!/usr/bin/env sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
archive="$root/deploy/rocky-linux/site/data/${1:-fixture}/trails.pmtiles"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
read z6x z6y z11x z11y z13x z13y z16x z16y leftx lefty rightx righty <<EOF
$(python3 - <<'PY'
import math
def tile(lon, lat, z):
 return int((lon + 180) / 360 * 2**z), int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * 2**z)
for z in (6, 11, 13, 16): print(*tile(10.8658, 60.0312, z), end=' ')
print(*tile(10.8450, 60.0312, 16), *tile(10.8850, 60.0312, 16))
PY
)
EOF
for zxy in "6 $z6x $z6y" "11 $z11x $z11y" "13 $z13x $z13y" "16 $z16x $z16y" "16 $leftx $lefty" "16 $rightx $righty"; do
  set -- $zxy
  docker run --rm -v "$root:/work:ro" ghcr.io/protomaps/go-pmtiles@sha256:06574f01f55a78f78f887bc7ebf729a5c093c0d6e17d9876300cfcb0758b59d3 tile "/work/${archive#$root/}" "$1" "$2" "$3" > "$tmp/$1-$2-$3.mvt"
done
docker run --rm -v "$tmp:/data:ro" \
  -e Z6="6-$z6x-$z6y" -e Z11="11-$z11x-$z11y" -e Z13="13-$z13x-$z13y" -e Z16="16-$z16x-$z16y" \
  -e LEFT="16-$leftx-$lefty" -e RIGHT="16-$rightx-$righty" \
  python:3.13-slim sh -ceu '
  pip install -q mapbox-vector-tile
  python - <<"PY"
import gzip
import os
from mapbox_vector_tile import decode
required = {"name", "mtbname", "routename", "grade", "mtbclass", "highway", "tracktype"}
def features(name, layer="trails"):
 return decode(gzip.decompress(open(f"/data/{name}.mvt", "rb").read())).get(layer, {"features": []})["features"]
z6, z11, z13, z16 = (features(os.environ[name]) for name in ("Z6", "Z11", "Z13", "Z16"))
left, right = (features(os.environ[name]) for name in ("LEFT", "RIGHT"))
assert z6 and z11 and z13 and z16
# Overview: only grade and mtbclass survive, so graded (101, 104) and named (106, 108) ways merge by class.
assert all(f["properties"].keys() == {"grade", "mtbclass"} for f in z6)
assert {(f["properties"]["grade"], f["properties"]["mtbclass"]) for f in z6} == {("1", ""), ("", "2"), ("", "")}
# Below z14 touching ways with equal tags merge; from z14 there is one feature per way. The way ID is the feature id.
assert all(required <= f["properties"].keys() and "osm_id" not in f["properties"] for f in z11 + z13 + z16)
assert "Boundary path" in {f["properties"]["name"] for f in z11}
assert all(f["properties"]["name"] or f["properties"]["mtbname"] or f["properties"]["routename"] or f["properties"]["grade"] or f["properties"]["mtbclass"] for f in z11)
# 108 and 109 touch with equal tags and merge; 110 continues them with another grade.
merged = [f for f in z11 if f["properties"]["mtbname"] == "MTB-only name"]
assert len(merged) == 2 and all(f["geometry"]["type"] == "LineString" for f in merged), merged
# The labels layer holds names only, so 108-110 make one label line despite the grade change.
labels = features(os.environ["Z11"], "labels")
named = [f for f in labels if f["properties"].get("name") == "MTB-only name"]
assert len(named) == 1 and named[0]["geometry"]["type"] == "LineString", named
# Route labels come from the relations themselves: races (204, 205) and hiking (203) are skipped.
assert {f["properties"]["route"] for f in labels if "route" in f["properties"]} == {"Pionéren", "Big race"}, labels
assert not features(os.environ["Z16"], "labels")
# MTB route names: shared ways list every route, sorted; other route types and race
# courses (year in the name, state=temporary: 204, 205 on way 102) are ignored.
routes = {f["properties"]["routename"] for f in z11 + z13}
assert {"Big race / Pionéren", "Big race"} <= routes, routes
assert "Hiking only" not in routes, routes
assert {"path", "track", "bridleway", "cycleway", "footway"} <= {f["properties"]["highway"] for f in z13}
assert len({f["id"] for f in z16}) == len(z16)
assert 106 in {f["id"] for f in left}
assert 106 in {f["id"] for f in right}
print(f"z6={len(z6)} z11={len(z11)} z13={len(z13)} z16={len(z16)}: schema, zoom rules, and boundary ID ok")
PY
'
