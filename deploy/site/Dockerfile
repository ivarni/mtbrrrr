# Static file server for the mtbrrrr PWA, for Scaleway Serverless Containers.
#
# The build context is the REPO ROOT, not this directory — the site files live at the top
# level and Docker cannot copy from above the context. deploy.sh does this for you:
#
#     docker build --platform linux/amd64 -f deploy/site/Dockerfile <repo root>
#
# --platform matters: Scaleway runs amd64, and an image built natively on an Apple Silicon
# Mac is arm64 and dies at start with "exec format error".
FROM nginx:1.27-alpine

COPY deploy/site/nginx.conf /etc/nginx/conf.d/default.conf

# Gitignored — generate it with the htpasswd command in SITE.md. Drop this line (and the
# auth_basic lines in nginx.conf) to serve the site publicly.
COPY deploy/site/htpasswd /etc/nginx/htpasswd

COPY index.html app.js sw.js manifest.webmanifest /usr/share/nginx/html/
