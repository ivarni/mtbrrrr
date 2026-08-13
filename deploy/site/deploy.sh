#!/usr/bin/env bash
# Build the mtbrrrr static site into an image, push it to Scaleway Container Registry, and
# roll the Serverless Container onto it.
#
# Terraform owns everything durable (registry, container, domain). This script is the
# build-and-push in the middle, and reads what it needs from Terraform outputs so there is
# nothing to keep in sync by hand.
#
#   ./deploy.sh       apply interactively (shows the plan, asks before changing anything)
#   ./deploy.sh -y    auto-approve
set -euo pipefail

cd "$(dirname "$0")"
ROOT=$(cd ../.. && pwd)

# Seeded with a real flag rather than left empty: macOS ships bash 3.2, where expanding an
# empty array under `set -u` is an "unbound variable" error.
APPLY_ARGS=(-input=false)
if [[ "${1:-}" == "-y" ]]; then
  APPLY_ARGS+=(-auto-approve)
fi

if [[ ! -f htpasswd ]]; then
  cat >&2 <<'EOF'
error: deploy/site/htpasswd is missing.

  The site is served behind basic auth and nginx will not start without the file.
  Create it (gitignored, bcrypt) with:

      htpasswd -cbB deploy/site/htpasswd <username> '<password>'

  To serve the site publicly instead, remove the auth_basic lines from nginx.conf and
  the htpasswd COPY from the Dockerfile.
EOF
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "error: the Docker daemon is not running — start Docker Desktop and retry." >&2
  exit 1
fi

terraform -chdir=infra init -input=false >/dev/null

# The registry must exist before we can push, and the container cannot be created pointing
# at an image that is not in the registry yet. So the registry goes up on its own first —
# a no-op on every run after the first.
terraform -chdir=infra apply -input=false -auto-approve \
  -target=scaleway_registry_namespace.site

IMAGE=$(terraform -chdir=infra output -raw image_ref 2>/dev/null || true)
if [[ -z "$IMAGE" ]]; then
  echo "error: image_ref output is empty — the targeted apply above did not settle. Re-run." >&2
  exit 1
fi

echo "==> Building $IMAGE"
# --platform is not optional on an Apple Silicon Mac: Scaleway runs amd64, and an arm64
# image fails at start with "exec format error".
docker build --platform linux/amd64 -t "$IMAGE" -f "$ROOT/deploy/site/Dockerfile" "$ROOT"

echo "==> Pushing"
scw registry login >/dev/null
docker push "$IMAGE"

echo "==> Applying"
terraform -chdir=infra apply "${APPLY_ARGS[@]}"

echo
echo "Live at $(terraform -chdir=infra output -raw site_url)"
