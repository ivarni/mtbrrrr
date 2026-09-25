# Self-hosting mtbrrrr on a Rocky Linux box

Runs mtbrrrr on one server you own:

- the static PWA at `https://mtb.<your-domain>`, behind HTTP basic auth (optional, on by default)
- an optional self-hosted Norway Overpass API at `https://overpass.<your-domain>` for rollback and data checks

The browser uses the versioned PMTiles archive in `site/data/`; it does not call Overpass.
Examples below use `<your-domain>` — substitute yours, or `source .env` so `$SITE_DOMAIN` /
`$OVERPASS_DOMAIN` fill in.

One `docker compose` stack does it. **Caddy** is the only thing on ports 80/443 — it
terminates TLS, serves the static PWA and PMTiles archive, and reverse-proxies the optional
Overpass service. **Overpass** (`wiktorn/overpass-api`) is internal-only. This replaces the
Scaleway nginx container, the Scaleway Overpass VM + Caddy, and all of Terraform (`../site/`,
`../overpass/`) — those are kept only as reference/rollback.

```
browser ──443──▶ caddy ──┬─ file_server  /srv/site      (mtb.<domain>, basic auth: optional, on by default)
                         └─ reverse_proxy overpass:80    (overpass.<domain>, CORS)
```

---

## Prerequisites on the box

Assumed already in place (this guide won't walk you through them):

- Rocky Linux 9, root or sudo.
- **Docker CE + the compose v2 plugin** installed, docker service enabled (`docker compose version` → v2.x), and **git**.
- A **public IP** with TCP **80 and 443** reachable — opened in firewalld (`http`/`https`
  services) and forwarded through any NAT. (If your ISP blocks inbound 80, Caddy still gets
  certs via TLS-ALPN on 443 — but 80 also redirects http→https, so forward it if you can.)
- DNS you control for your domain (the app expects the convention site `mtb.<domain>`,
  Overpass `overpass.<domain>` — same base domain, at least three labels).

Project-specific sizing you do need to get right:

- **Disk**: the Norway DB is ~10–20 GB, and the first import needs the 1.3 GB PBF plus
  osmium scratch on top. Have **≥ 30 GB free** on the docker data-root (default
  `/var/lib/docker`). Check before importing:
  ```sh
  df -h /var/lib/docker
  ```
  If root is small but you have a data disk, either point the docker data-root at it
  (`/etc/docker/daemon.json` → `{"data-root": "/mnt/data/docker"}`, then
  `systemctl restart docker`) **before** the first `up`, or replace the `overpass_db` named
  volume in `docker-compose.yml` with a bind mount to the disk (add `:Z` for SELinux).

**SELinux** can stay **enforcing** — the compose file labels its bind mounts (`:Z`) and the DB
is a named volume, so no manual relabeling is needed. (If a mount ever 403s after you edit
files on the host, `sudo restorecon -Rv deploy/rocky-linux/site deploy/rocky-linux/caddy`
fixes the labels.)

## 1. DNS

Point both hostnames at the box's public IP and wait for them to resolve **before** the first
`up` (Caddy asks Let's Encrypt for a cert the moment it starts; a name that doesn't resolve
yet fails the challenge and backs off):

```
mtb        IN  A   <server-public-ip>
overpass   IN  A   <server-public-ip>
```

```sh
dig +short mtb.<your-domain>
dig +short overpass.<your-domain>   # both must return the server IP
```

## 2. Get the code and configure

```sh
git clone <this-repo> /opt/mtbrrrr
cd /opt/mtbrrrr/deploy/rocky-linux

cp .env.example .env
```

Edit `.env`:

- `ACME_EMAIL` — your email.
- `SITE_DOMAIN` / `OVERPASS_DOMAIN` — set to `mtb.<your-domain>` / `overpass.<your-domain>`.
- `SITE_AUTH_SNIPPET` — the auth toggle. Leave it at `/etc/caddy/auth-on.conf` (the default,
  which also applies if you delete the line) to require a login, or set it to
  `/etc/caddy/auth-off.conf` to serve the map publicly. With auth off, skip `SITE_USER` /
  `SITE_PASSWORD_HASH` below — they're unused.
- `SITE_USER` — pick a username. (Auth-on only.)
- `SITE_PASSWORD_HASH` — a bcrypt hash with every `$` **doubled to `$$`** (docker compose's
  `env_file` interpolates `$`; Caddy receives the de-escaped single-`$` value — verified on
  compose v2 / docker 29). Generate it already-escaped in one step and paste the output
  verbatim:
  ```sh
  echo 'your-password' | docker run --rm -i caddy:2 caddy hash-password | sed 's/\$/\$\$/g'
  ```
  (A wrong/mangled hash surfaces as a 401 in step 6.) Auth-on only.
- `SITE_ORIGIN_REGEX` — `https://` + `SITE_DOMAIN` with the dots escaped, e.g.
  `https://mtb\.example\.com`.

## 3. Publish the site files

Caddy's web root is the gitignored `site/` dir. It contains the four app files plus generated
`data/`; never point Caddy at the repo root. Build and publish a PMTiles release before deploying
an app version that requires `data/latest.json`, then copy the app files:

```sh
install -Dm644 -t site ../../index.html ../../app.js ../../sw.js ../../manifest.webmanifest
```

Re-run this after changing an app file, then `docker compose restart caddy`. It does not remove
published data.

## 4. Validate the config

```sh
docker compose config >/dev/null        # compose file parses + interpolates
docker run --rm --env-file .env -v "$PWD/caddy":/etc/caddy:ro caddy:2 \
  caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile
```

Both must succeed. (The `--env-file` and `--adapter caddyfile` flags are required, or validate
false-fails on empty `{$VARS}` / the non-JSON format.)

Also validate the auth-OFF state — it imports the empty snippet instead of `basic_auth`, and
you want to know it adapts cleanly regardless of which mode you deploy:

```sh
docker run --rm --env-file .env -e SITE_AUTH_SNIPPET=/etc/caddy/auth-off.conf \
  -v "$PWD/caddy":/etc/caddy:ro caddy:2 \
  caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile
```

## 5. First start

```sh
docker compose up -d
```

- **Caddy** comes up in seconds and provisions the two certs. Watch: `docker compose logs -f caddy`.
- **Overpass**, if retained for rollback or data checks, downloads Norway (~1.3 GB), converts
  PBF→bz2 with osmium, and imports. Reference: **~45 min** on decent hardware.

Verify the basic-auth hash reached the container intact (do this once — **auth-on only**; skip
if you set `SITE_AUTH_SNIPPET=/etc/caddy/auth-off.conf`):

```sh
docker compose exec caddy printenv SITE_PASSWORD_HASH   # must be the single-$ hash (de-escaped)
```

### Watching the import (progress vs. crash loop)

A "curl until 200" poll can't tell a slow import from a crash loop. Use these:

```sh
docker inspect -f '{{.RestartCount}}' overpass   # judge a loop by a GROWING count, not by non-zero
docker system df -v | grep overpass_db           # volume size growing = downloading/importing
docker compose logs -f overpass
```

Two things that look alarming and are **not**:

- **One restart right after init is normal** — the image self-stops after init
  (`OVERPASS_STOP_AFTER_INIT`) and `restart: unless-stopped` revives it. A *growing* count is
  a real loop.
- **Hourly `ERROR: Error while downloading diffs` / `status code: 3`** is pyosmium saying
  "no new data" — harmless.

## 6. Verify it's live

```sh
set -a; source .env; set +a    # pull $SITE_DOMAIN / $OVERPASS_DOMAIN in, so these are generic

# Site, auth ON (default): 401 without creds, 200 with.
# ALWAYS run the no-creds check when you intend auth to be on — it is the ONE guard against
# accidentally serving the private map publicly (e.g. SITE_AUTH_SNIPPET left on the off path).
# A 200 here when you expected 401 means auth is OFF: fix SITE_AUTH_SNIPPET and `up -d`.
curl -sI "https://$SITE_DOMAIN/" | head -1                      # HTTP/2 401  (MUST be 401 if auth on)
curl -sI -u 'USER:PASS' "https://$SITE_DOMAIN/" | head -1       # HTTP/2 200
# (Deliberately auth OFF? Then this flips: expect 200 with no creds from the first curl above.)

# sw.js must not be long-cached.
curl -sI -u 'USER:PASS' "https://$SITE_DOMAIN/sw.js" | grep -i cache-control   # no-cache

# Overpass: 200, and EXACTLY ONE access-control-allow-origin header echoing the site origin.
curl -s -H "Origin: https://$SITE_DOMAIN" -D- -o /dev/null \
  "https://$OVERPASS_DOMAIN/api/interpreter?data=[out:json];way(59.90,10.65,59.95,10.70)[highway];out geom;"
```

Then open `https://$SITE_DOMAIN` on a phone: it should prompt for basic auth once (only when
auth is on), load the
map (MapTiler base — see step 7), show trails, and offer "Add to Home Screen". GPS and the
service worker require HTTPS, which you now have.

## 7. MapTiler referrer allow-list

`app.js` ships a public MapTiler key restricted by HTTP referrer. Add the new origin or the
base map 403s. In **MapTiler → Account → Keys → Allowed origins**, add the **bare host** (no
scheme, no port — MapTiler rejects those):

```
mtb.<your-domain>
```

alongside `localhost`. (To run fully keyless instead, set `MAPTILER_KEY = ''` in `app.js` and
re-publish — the app falls back to OpenFreeMap Liberty + its own hillshade.)

---

## Updating

- **App files** (`index.html`/`app.js`/`sw.js`/`manifest.webmanifest`):
  ```sh
  git -C /opt/mtbrrrr pull
  cd /opt/mtbrrrr/deploy/rocky-linux
  install -Dm644 -t site ../../index.html ../../app.js ../../sw.js ../../manifest.webmanifest
  docker compose restart caddy
  ```
  When you change `app.js`/`sw.js` meaningfully, bump `APP_CACHE` in `sw.js` (currently
  `app-v12`) so clients drop the stale shell. **Never** rename `TILE_CACHE` — that throws away
  every cached tile/DEM/trail response on every installed device. On a phone the new service
  worker needs ~2 reloads to take control.

- **Caddy config** (`caddy/Caddyfile` or `.env`):
  ```sh
  docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
  # verify what it actually loaded:
  docker compose exec caddy caddy adapt --config /etc/caddy/Caddyfile >/dev/null && echo ok
  ```
  (A `.env` change needs a full `docker compose up -d` to re-inject the container environment.)

  To **toggle auth on/off**, flip `SITE_AUTH_SNIPPET` in `.env` (see .env.example) between
  `/etc/caddy/auth-on.conf` and `/etc/caddy/auth-off.conf`, then `docker compose up -d` (it's an
  env change, so a reload alone won't pick it up). Turning auth on for the first time also needs
  `SITE_USER` / `SITE_PASSWORD_HASH` set.

  **Upgrading an existing install:** no `.env` change is needed. A plain `git pull` brings the
  new Caddyfile and both snippet files together; with `SITE_AUTH_SNIPPET` absent from your `.env`
  the default keeps auth **on**, exactly as before.

## PMTiles fixture preview

The fixture proves the direct OSM → PMTiles path before a Norway-wide build. It is not a data
release. Build either the deterministic tiny fixture or the checked-in Nittedal sample:

```sh
./tiles/build-fixture.sh fixture
./tiles/build-fixture.sh nittedal
```

The archive is written to `site/data/<name>/trails.pmtiles`; the command validates its PMTiles
structure. To inspect it locally with correct byte-range handling:

```sh
docker run --rm -p 127.0.0.1:8001:80 -v "$PWD/../..:/srv:ro" caddy:2.11.4 \
  caddy file-server --root /srv --listen :80
```

Open `http://localhost:8001/index.html?fixture=fixture` or `?fixture=nittedal`. A range check
must return `206 Partial Content`:

```sh
curl -s -D - -o /dev/null -H 'Range: bytes=0-99' http://localhost:8001/deploy/rocky-linux/site/data/fixture/trails.pmtiles
```

## Norway PMTiles build

After the fixture passes, run the country build on the Rocky host, not a laptop. The script
reads the Geofabrik PBF replication timestamp itself and records it in the manifest:

```sh
./tiles/build-norway.sh https://download.geofabrik.de/europe/norway-latest.osm.pbf 2026-09-24
```

It downloads a fresh PBF, builds directly to `site/data/<release>/trails.pmtiles`, and samples
Tilemaker's cgroup memory, CPU, and block I/O every two seconds in `tilemaker-stats.tsv`.
Each sample also records Tilemaker's `--store` plus staging-disk use. On hosts with kernel I/O
pressure support it records pressure averages; otherwise it records host disk metrics in
`host-iostat.txt` and requires `sysstat`. `build-time.txt` records the build start and finish.
Review those files while the host is under normal load before scheduling builds. The script validates the archive, then atomically replaces
`site/data/latest.json`. Release names are immutable: the script refuses an existing name. Keep
the previous release directory for rollback. Verify the published z11, z13, and z16 samples
against the PBF without rebuilding:

```sh
./tiles/verify-norway.sh <release>
```

## Reboot / persistence

`restart: unless-stopped` plus the enabled docker service brings the whole stack back after a
reboot — nothing else to do. The DB is in the `overpass_db` volume and is not re-imported.

If you'd rather have systemd own it explicitly, drop this at
`/etc/systemd/system/mtbrrrr.service` and `systemctl enable mtbrrrr`:

```ini
[Unit]
Description=mtbrrrr (caddy + overpass)
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/mtbrrrr/deploy/rocky-linux
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down

[Install]
WantedBy=multi-user.target
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Cert never issues, Caddy logs ACME failures | DNS not resolving to the box yet, or 80/443 not reachable (firewall/NAT). Confirm `dig`, and that the ports are forwarded. |
| 401 on everything, even with correct password | `SITE_PASSWORD_HASH` not `$$`-escaped in `.env` (or wrong password). Re-run the `printenv` check in step 5 — the container must show the single-`$` hash; fix the escaping and `docker compose up -d`. |
| Overpass "download loop", disk filling, no import | `OVERPASS_PLANET_PREPROCESS` was removed/edited — it must stay (see the comment in `docker-compose.yml`). |
| Two `access-control-allow-origin` headers / browser CORS error | A `defer` was dropped from the Caddyfile header ops, or the `@other_origin` strip block was removed. |
| Map loads but no base tiles (403 from `api.maptiler.com`) | MapTiler referrer allow-list — step 7. |
| Overpass import out of disk | The disk sizing in Prerequisites — relocate the docker data-root or bind-mount `overpass_db` to a bigger disk, then re-run `docker compose up -d` (it re-imports). |
| Site serves the wrong/old file after `git pull` | You forgot to re-run the `install` in step 3 and `docker compose restart caddy`. |

## Reference

- `../MAPTILER.md` — MapTiler key + origin restrictions.
- `../overpass/INFRA.md` — deep Overpass background (import tuning, diff cadence, traps).
- `../site/SITE.md`, `../overpass/*` — the retired Scaleway setup, kept for rollback.
