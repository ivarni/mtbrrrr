#!/usr/bin/env sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
tiles="$root/deploy/rocky-linux/tiles"
site="$root/deploy/rocky-linux/site/data"
source_url=${1:-https://download.geofabrik.de/europe/norway-latest.osm.pbf}
release=${2:-$(date -u +%F)}
source_timestamp=${3:-}
staging="$site/.staging-$release"
pbf="$tiles/${source_url##*/}"
download="$pbf.$$"
container=""
[ ! -e "$site/$release" ] || { echo "release already exists: $release" >&2; exit 1; }
[ ! -e "$staging" ] || { echo "staging directory already exists: $staging" >&2; exit 1; }
mkdir -p "$staging" "$tiles/.store"
trap 'rm -rf "$staging" "$download"; [ -z "$container" ] || docker rm -f "$container" >/dev/null 2>&1 || true' EXIT

curl --fail --location --output "$download" "$source_url"
mv "$download" "$pbf"
if [ -z "$source_timestamp" ]; then
  source_timestamp=$(docker run --rm -v "$tiles:/data:ro" debian@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 \
    sh -ceu "apt-get update -qq && apt-get install -y -qq osmium-tool >/dev/null && osmium fileinfo -g header.option.osmosis_replication_timestamp /data/${pbf##*/}")
fi
[ -n "$source_timestamp" ] || { echo "PBF has no replication timestamp" >&2; exit 1; }
started=$(date -u +%FT%TZ)
container="mtbrrrr-tilemaker-$$"
docker run -d --name "$container" \
  -v "$tiles:/data" -v "$staging:/out" \
  ghcr.io/systemed/tilemaker@sha256:d3eda2790458de727bb0096eebce775984fc060f60901dac6dbfbbb79ae17370 \
  --input "/data/${pbf##*/}" --output /out/trails.pmtiles --config /data/config.json --process /data/process.lua --store /data/.store >/dev/null
printf 'timestamp\tmemory\tcpu\tblock_io\tscratch_kib\tio_some_avg10\tio_full_avg10\n' > "$staging/tilemaker-stats.tsv"
(
  while [ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || true)" = true ]; do
    stats=$(docker stats --no-stream --format '{{.MemUsage}}\t{{.CPUPerc}}\t{{.BlockIO}}' "$container")
    scratch=$(du -sk "$tiles/.store" "$staging" | awk '{ total += $1 } END { print total }')
    io_pressure=$(awk '/^some / { split($2, a, "="); some = a[2] } /^full / { split($2, a, "="); full = a[2] } END { print some "\t" full }' /proc/pressure/io)
    printf '%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$stats" "$scratch" "$io_pressure"
    sleep 2
  done
) >> "$staging/tilemaker-stats.tsv" &
monitor=$!
docker wait "$container" > "$staging/tilemaker-exit.txt"
wait "$monitor" || true
status=$(cat "$staging/tilemaker-exit.txt")
docker logs "$container" > "$staging/tilemaker.log" 2>&1 || true
docker rm "$container" >/dev/null
container=""
[ "$status" -eq 0 ] || { cat "$staging/tilemaker.log" >&2; exit "$status"; }
printf 'started=%s\nfinished=%s\n' "$started" "$(date -u +%FT%TZ)" > "$staging/build-time.txt"

docker run --rm -v "$staging:/out:ro" ghcr.io/protomaps/go-pmtiles@sha256:06574f01f55a78f78f887bc7ebf729a5c093c0d6e17d9876300cfcb0758b59d3 verify /out/trails.pmtiles
mkdir "$site/$release"
mv "$staging/trails.pmtiles" "$site/$release/trails.pmtiles"
cp "$staging/build-time.txt" "$staging/tilemaker-stats.tsv" "$site/$release/"
printf '{"source":"%s","sourceTimestamp":"%s","started":"%s","archive":"%s/trails.pmtiles"}\n' "$source_url" "$source_timestamp" "$started" "$release" > "$site/.latest.json.$$"
mv "$site/.latest.json.$$" "$site/latest.json"
