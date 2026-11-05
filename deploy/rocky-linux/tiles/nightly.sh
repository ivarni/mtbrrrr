#!/usr/bin/env sh
# Nightly refresh: build today's Norway release from a fresh Geofabrik PBF, then keep only the
# newest $KEEP dated releases (never the one latest.json points at). Run by mtbrrrr-nightly.timer.
set -eu

tiles=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
site="$tiles/../site/data"

"$tiles/build-norway.sh"

current=$(sed -n 's/.*"archive":"\([^/]*\)\/.*/\1/p' "$site/latest.json")
[ -n "$current" ] || { echo "cannot read current release from latest.json" >&2; exit 1; }
# Only dated release dirs (YYYY-MM-DD); fixtures and staging dirs are left alone.
ls -1d "$site"/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] 2>/dev/null | sort -r | tail -n +"$((${KEEP:-3} + 1))" |
  while read -r dir; do
    [ "${dir##*/}" = "$current" ] || { echo "pruning ${dir##*/}"; rm -rf "$dir"; }
  done
