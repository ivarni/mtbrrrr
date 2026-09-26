#!/usr/bin/env bash
# Bring up the mtbrrrr stack on this machine: a local Overpass API in Docker, and the static
# site on localhost. app.js already points localhost at the container, so nothing here edits
# source — if the container is down the app falls back to the public mirrors on its own.
#
#   ./run-locally.sh          start everything (idempotent — safe to re-run)
#   ./run-locally.sh stop     stop both servers
#   ./run-locally.sh status   what is running right now
#   ./run-locally.sh logs     follow the Overpass container log
#   ./run-locally.sh reset    destroy the container AND the imported DB (forces a re-import)
#
# Environment overrides:
#   EXTRACT_URL   regional PBF to import (default: Oslo, ~2 min)
#                 for all of Norway, matching production:
#                 EXTRACT_URL=https://download.geofabrik.de/europe/norway-latest.osm.pbf
#                 ...but that is a 1.3 GB download and a ~45 min import. Only worth it if you
#                 need trails outside the Oslo area.
#   SITE_PORT     static site port    (default 8000)
#   OVERPASS_PORT local Overpass port (default 12345 — must match app.js if you change it)
#   MAX_WAIT      seconds to wait for the import (default 2700)
set -euo pipefail

cd "$(dirname "$0")"

SITE_PORT=${SITE_PORT:-8000}
OVERPASS_PORT=${OVERPASS_PORT:-12345}
MAX_WAIT=${MAX_WAIT:-2700}
EXTRACT_URL=${EXTRACT_URL:-https://download.bbbike.org/osm/bbbike/Oslo/Oslo.osm.pbf}

CONTAINER=overpass-local
VOLUME=overpass_local_db
# Pinned to the same tag as deploy/rocky-linux/docker-compose.yml so local behaviour matches
# production. Bump both together or don't bump at all.
IMAGE=wiktorn/overpass-api:v0.7.62.11

OVERPASS_URL="http://localhost:${OVERPASS_PORT}/api/interpreter"
SITE_URL="http://localhost:${SITE_PORT}/index.html"

# ---------- helpers ----------
site_pid() { lsof -ti "tcp:${SITE_PORT}" -sTCP:LISTEN 2>/dev/null || true; }

# `docker inspect` on a missing container exits 1 *and* prints a blank line to stdout, so a
# plain `|| echo absent` yields "\nabsent" and matches no case branch. Strip whitespace.
container_state() {
  local s
  s=$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null) || s=
  s=${s//[[:space:]]/}
  if [[ -n "$s" ]]; then echo "$s"; else echo absent; fi
}

# nginx in the Overpass image answers 200 even when the query failed — the body is an HTML
# error page. So readiness is "the body is JSON with an elements array", never the status code.
overpass_body() {
  curl -s --max-time 15 -G "$OVERPASS_URL" \
    --data-urlencode 'data=[out:json];node(1);out;' 2>/dev/null || true
}

require_docker() {
  if ! docker info >/dev/null 2>&1; then
    echo "error: the Docker daemon is not running — start Docker Desktop and retry." >&2
    exit 1
  fi
}

# ---------- commands ----------
cmd_up() {
  require_docker

  case "$(container_state)" in
    absent)
      echo "==> Creating $CONTAINER (importing $(basename "$EXTRACT_URL"))"
      docker run -d --name "$CONTAINER" --restart unless-stopped \
        -p "${OVERPASS_PORT}:80" \
        -e OVERPASS_META=no \
        -e OVERPASS_MODE=init \
        -e OVERPASS_PLANET_URL="$EXTRACT_URL" \
        `# LOAD-BEARING, same as production: update_database reads .osm.bz2 and Geofabrik only` \
        `# publishes .pbf for regions. Without this you get a 1.3 GB download, a` \
        `# "bunzip2: (stdin) is not a bzip2 file" crash, and a restart loop that looks like` \
        `# progress because the disk keeps filling with the same repeated download.` \
        -e OVERPASS_PLANET_PREPROCESS='mv /db/planet.osm.bz2 /db/planet.osm.pbf && osmium cat -o /db/planet.osm.bz2 /db/planet.osm.pbf && rm /db/planet.osm.pbf' \
        -e OVERPASS_RULES_LOAD=10 \
        `# No OVERPASS_DIFF_URL on purpose: hourly diff pulls are pointless against a` \
        `# throwaway dev DB, and they are the source of the scary hourly "status code: 3" logs.` \
        -v "${VOLUME}:/db" \
        "$IMAGE" >/dev/null
      ;;
    running)
      echo "==> $CONTAINER already running"
      ;;
    *)
      echo "==> Starting existing $CONTAINER"
      # The image self-stops after a successful init (OVERPASS_STOP_AFTER_INIT) and relies on
      # the restart policy to come back. A container created without one stays down, which
      # reads as a failed import when it is actually a finished one.
      docker update --restart unless-stopped "$CONTAINER" >/dev/null
      docker start "$CONTAINER" >/dev/null
      ;;
  esac

  echo "==> Waiting for Overpass on port ${OVERPASS_PORT} (import can take a while)"
  local waited=0 body restarts
  while :; do
    body=$(overpass_body)

    if [[ "$body" == *'"elements"'* ]]; then
      echo "==> Overpass ready after ${waited}s"
      break
    fi

    # The image creates /db as mode 700 owned by `overpass`, but the FastCGI worker runs as
    # www-data — it cannot traverse the directory to reach the dispatcher socket, even though
    # the socket itself is world-writable. Fires on a freshly created volume.
    if [[ "$body" == *'Permission denied'* ]]; then
      echo "    fixing /db permissions (mode 700 blocks the FastCGI worker)"
      docker exec "$CONTAINER" chmod 755 /db || true
      continue
    fi

    # A non-zero restart count is normal exactly once (the self-stop after init). A growing
    # one is a crash loop, which "curl until it answers" alone cannot distinguish from a slow
    # import — that difference is why this waits on two signals instead of one.
    restarts=$(docker inspect -f '{{.RestartCount}}' "$CONTAINER" 2>/dev/null || echo 0)
    if (( restarts > 3 )); then
      echo "error: $CONTAINER has restarted ${restarts} times — this is a crash loop, not an import." >&2
      echo "       Check './run-locally.sh logs', then './run-locally.sh reset' to start over." >&2
      exit 1
    fi

    if (( waited >= MAX_WAIT )); then
      echo "error: Overpass still not answering after ${waited}s. Check './run-locally.sh logs'." >&2
      exit 1
    fi

    if (( waited % 30 == 0 )); then
      printf '    %4ds  restarts=%s  db=%s\n' \
        "$waited" "$restarts" "$(docker exec "$CONTAINER" du -sh /db 2>/dev/null | cut -f1 || echo '-')"
    fi
    sleep 5
    waited=$(( waited + 5 ))
  done

  if [[ -n "$(site_pid)" ]]; then
    echo "==> Static site already serving on port ${SITE_PORT}"
  else
    echo "==> Serving the site on port ${SITE_PORT}"
    # GPS and the service worker both need a secure context, which localhost counts as and
    # file:// does not — hence a real server for a site with no build step.
    nohup python3 -m http.server "$SITE_PORT" >/dev/null 2>&1 &
    sleep 1
  fi

  cat <<EOF

  Site      $SITE_URL
  Overpass  $OVERPASS_URL

Trails inside the imported extract now come from the container; anywhere else the app falls
back to the public mirrors on its own. The service worker caches app.js — if an edit does not
show up, hard-reload or tick DevTools > Application > Service Workers > "Update on reload".
EOF
}

cmd_stop() {
  local pid
  pid=$(site_pid)
  if [[ -n "$pid" ]]; then
    echo "==> Stopping the static site (pid $pid)"
    kill $pid
  fi
  if [[ "$(container_state)" == running ]]; then
    echo "==> Stopping $CONTAINER"
    # Leaves the container and its imported DB in place — `up` restarts it in seconds.
    docker stop "$CONTAINER" >/dev/null
  fi
}

cmd_status() {
  local state pid body
  state=$(container_state)
  pid=$(site_pid)
  echo "Overpass container : $state ($CONTAINER on port $OVERPASS_PORT)"
  if [[ -n "$pid" ]]; then
    echo "Static site        : running, pid $pid (port $SITE_PORT)"
  else
    echo "Static site        : not running (port $SITE_PORT)"
  fi
  if [[ "$state" == running ]]; then
    body=$(overpass_body)
    if [[ "$body" == *'"elements"'* ]]; then
      echo "Overpass query     : ok"
    else
      echo "Overpass query     : NOT answering (importing, or check logs)"
    fi
  fi
}

cmd_reset() {
  require_docker
  echo "This destroys $CONTAINER and volume $VOLUME — the imported DB goes with it,"
  printf 'and the next start re-imports from scratch. Continue? [y/N] '
  read -r reply
  [[ "$reply" == [yY] ]] || { echo "Aborted."; exit 0; }
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  echo "==> Removed. Run './run-locally.sh' for a fresh import."
}

case "${1:-up}" in
  up|"")     cmd_up ;;
  stop|down) cmd_stop ;;
  status)    cmd_status ;;
  logs)      docker logs -f "$CONTAINER" ;;
  reset)     cmd_reset ;;
  *)
    echo "usage: $0 [up|stop|status|logs|reset]" >&2
    exit 1
    ;;
esac
