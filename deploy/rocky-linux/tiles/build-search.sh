#!/usr/bin/env sh
# Trail search index: <out>/search.json and <out>/profiles/<id>.json from an OSM file and a
# directory of DTM10 GeoTIFFs. See build-search.py.
#   build-search.sh <input.osm.pbf|.osm> <out-dir> <dem-dir>
set -eu

tiles=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
in_dir=$(CDPATH= cd -- "$(dirname -- "$1")" && pwd)
input=${1##*/}
mkdir -p "$2"
out=$(CDPATH= cd -- "$2" && pwd)
dem=$(CDPATH= cd -- "$3" && pwd)
trap 'rm -f "$out/.search-input.osm.pbf"' EXIT

# Only trail ways and MTB routes (with their member ways) reach Python; the rest of Norway stays out.
docker run --rm -v "$in_dir:/in:ro" -v "$out:/out" debian@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 \
  sh -ceu "apt-get update -qq && apt-get install -y -qq osmium-tool >/dev/null && osmium tags-filter /in/$input w/highway=path,track,bridleway,cycleway,footway r/route=mtb -o /out/.search-input.osm.pbf"
docker run --rm -e OWNER="$(id -u):$(id -g)" -v "$tiles:/tiles:ro" -v "$out:/out" -v "$dem:/dem:ro" python:3.13-slim sh -ceu '
  trap "chown -R \$OWNER /out" EXIT  # root in here; hand profiles/ back so the caller can move and remove it
  apt-get update -qq && apt-get install -y -qq libexpat1 >/dev/null  # rasterio wheels link it; slim lacks it
  pip install -q --root-user-action=ignore osmium==4.3.1 rasterio==1.4.4
  python -I /tiles/build-search.py /out/.search-input.osm.pbf /out /dem'
