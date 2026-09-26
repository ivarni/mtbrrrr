#!/usr/bin/env sh
# Serve the app on localhost. PMTiles needs HTTP byte ranges, which `python3 -m http.server`
# does not support, so this uses Caddy in Docker. Ctrl-C stops it.
#
# Trails come from a local fixture archive; build one first:
#   deploy/rocky-linux/tiles/build-fixture.sh fixture     (tiny test map)
#   deploy/rocky-linux/tiles/build-fixture.sh nittedal    (real Nittedal sample)
#
#   ./run-locally.sh                 serve on port 8000
#   SITE_PORT=9000 ./run-locally.sh
set -eu

cd "$(dirname "$0")"
port=${SITE_PORT:-8000}
echo "Open http://localhost:$port/index.html?fixture=nittedal (or ?fixture=fixture)"
exec docker run --rm -p "127.0.0.1:$port:80" -v "$PWD:/srv:ro" caddy:2.11.4 \
  caddy file-server --root /srv --listen :80
