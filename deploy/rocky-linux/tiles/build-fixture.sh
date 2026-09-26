#!/usr/bin/env sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
tiles="$root/deploy/rocky-linux/tiles"
name=${1:-fixture}
input="$tiles/$name.osm"
out="$root/deploy/rocky-linux/site/data/$name"
[ -f "$input" ] || { echo "missing $input" >&2; exit 1; }
mkdir -p "$out"
temp=".$name.$$.osm.pbf"
trap 'rm -f "$tiles/$temp"' EXIT

docker run --rm -v "$tiles:/data" debian@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 \
  sh -ceu "apt-get update -qq && apt-get install -y -qq osmium-tool >/dev/null && osmium cat /data/$name.osm -o /data/$temp"
docker run --rm -v "$tiles:/data:ro" -v "$out:/out" \
  ghcr.io/systemed/tilemaker@sha256:d3eda2790458de727bb0096eebce775984fc060f60901dac6dbfbbb79ae17370 \
  --input "/data/$temp" --bbox 10.84,60.02,10.89,60.05 --output /out/trails.pmtiles --config /data/config.json --process /data/process.lua --quiet
docker run --rm -v "$out:/out:ro" ghcr.io/protomaps/go-pmtiles@sha256:06574f01f55a78f78f887bc7ebf729a5c093c0d6e17d9876300cfcb0758b59d3 verify /out/trails.pmtiles
[ "$name" != fixture ] || "$tiles/verify-fixture.sh" fixture
