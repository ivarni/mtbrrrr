#!/usr/bin/env bash
# Push docker-compose.yml and the rendered Caddyfile to the Overpass server and reload the
# stack. This is the path for every change after the first boot — the Overpass DB on
# /srv/overpass is untouched, so nothing gets re-imported.
#
# Terraform creates the server; this only updates what runs on it. Everything is read from
# Terraform outputs, so there's nothing to keep in sync by hand.
#
#   ./deploy.sh       apply interactively (shows the plan, asks before changing anything)
#   ./deploy.sh -y    auto-approve
set -euo pipefail

cd "$(dirname "$0")"

# Seeded with a real flag rather than left empty: macOS ships bash 3.2, where expanding an
# empty array under `set -u` is an "unbound variable" error.
APPLY_ARGS=(-input=false)
if [[ "${1:-}" == "-y" ]]; then
  APPLY_ARGS+=(-auto-approve)
fi

# The `caddyfile` output is rendered from Caddyfile.tftpl at APPLY time and read back from
# state, so editing the template alone leaves the output stale and this script would push the
# old file. Applying first re-renders it — and keeps the copy baked into the instance's
# cloud-init user_data in sync, so a rebuilt server boots with the same config we are pushing
# here. Editing the Caddyfile is an in-place user_data update, not a replacement; it does not
# touch the running containers or the DB volume.
terraform -chdir=infra apply "${APPLY_ARGS[@]}"

IP=$(terraform -chdir=infra output -raw server_ip)

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Rendered by Terraform rather than sed'd here, so the domain substitution lives in exactly
# one place (infra/main.tf) and can't drift from what cloud-init wrote on first boot.
terraform -chdir=infra output -raw caddyfile > "$TMP/Caddyfile"

rsync -av docker-compose.yml "$TMP/Caddyfile" "root@$IP:/opt/overpass/"

# `up -d` catches changes to docker-compose.yml itself; the explicit reload is what applies a
# changed Caddyfile, since to Docker a bind-mounted file changing content is not a config
# change and leaves the container running with the old config loaded. The reload is graceful —
# no dropped connections — and the Let's Encrypt cert lives in the caddy_data volume, so it is
# reused rather than re-issued. This only works because compose mounts the /opt/overpass
# directory rather than the Caddyfile itself; see the comment on the volume.
ssh "root@$IP" 'cd /opt/overpass && docker compose up -d && docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile'
