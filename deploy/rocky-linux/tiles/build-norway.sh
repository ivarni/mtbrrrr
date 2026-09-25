#!/usr/bin/env sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
tiles="$root/deploy/rocky-linux/tiles"
site="$root/deploy/rocky-linux/site/data"
source_url=${1:-https://download.geofabrik.de/europe/norway-latest.osm.pbf}
release=${2:-$(date -u +%F)}
source_timestamp=${3:?usage: build-norway.sh [source-url] [release] <source-timestamp>}
staging="$site/.staging-$release"
mkdir -p "$staging" "$tiles/.store"
trap 'rm -rf "$staging"' EXIT

curl --fail --location --remote-name --output-dir "$tiles" "$source_url"
pbf="$tiles/${source_url##*/}"
started=$(date -u +%FT%TZ)
/usr/bin/time -v -o "$staging/time.txt" docker run --rm \
  -v "$tiles:/data" -v "$staging:/out" \
  ghcr.io/systemed/tilemaker@sha256:d3eda2790458de727bb0096eebce775984fc060f60901dac6dbfbbb79ae17370 \
  --input "/data/${pbf##*/}" --output /out/trails.pmtiles --config /data/config.json --process /data/process.lua --store /data/.store

docker run --rm -v "$staging:/out:ro" ghcr.io/protomaps/go-pmtiles@sha256:06574f01f55a78f78f887bc7ebf729a5c093c0d6e17d9876300cfcb0758b59d3 verify /out/trails.pmtiles
mkdir -p "$site/$release"
mv "$staging/trails.pmtiles" "$site/$release/trails.pmtiles"
cp "$staging/time.txt" "$site/$release/build-time.txt"
printf '{"source":"%s","sourceTimestamp":"%s","started":"%s","archive":"%s/trails.pmtiles"}\n' "$source_url" "$source_timestamp" "$started" "$release" > "$site/.latest.json.$$"
mv "$site/.latest.json.$$" "$site/latest.json"
