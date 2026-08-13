# Resuming mtbrrrr after the off-season pause

The self-hosted Overpass server was torn down on **2026-08-10** to stop paying for it over
the winter. This is the checklist to bring it back in spring.

Nothing about the app broke. `https://mtb.ivarnilsen.com` stayed up the whole time and the
map still shows trails — Norway queries just go to the public Overpass mirrors, which are
slower and occasionally return nothing. Resuming is an upgrade, not a repair.

## What the pause actually did

| | State |
|---|---|
| Static site (Serverless Container) | **untouched, live** — inside the free tier, €0/mo |
| `SELF_HOSTED_OVERPASS` in `app.js` | blanked to `''`, deployed as image `d096ae136ce6` |
| Overpass instance + its 20 GB root volume | **destroyed** |
| 50 GB block volume with the Norway DB | **destroyed** — the data is gone, plan on a full re-import |
| Flexible IP `51.15.224.208` | **kept** (~€3.7/mo) |
| DNS `overpass.ivarnilsen.com` → that IP, at one.com | **kept**, still authoritative |
| Security group + project SSH key | **kept** (both free) |

Cost went from ~€30/mo to ~€3.7/mo. The IP and DNS record were deliberately kept: they are
the two things whose absence made the original build painful, and re-reserving an IP means
editing DNS at one.com and then waiting out a 3600 s TTL before Caddy can pass its first
Let's Encrypt challenge.

The DB volume was *not* worth keeping. Geofabrik only retains daily diffs for a few months,
so a database paused in August has no path to catch up by spring — it would need a full
re-import either way, and preserving it would have cost ~€47 over the pause for nothing.

## Bringing it back

Everything below runs from this repo; `terraform` and `scw` must still be authenticated
(`scw config get` should show the profile with project `4c771ef1-…`).

### 1. Confirm the IP and DNS survived

```bash
cd deploy/overpass/infra
terraform state list          # expect: iam_ssh_key, instance_ip, security_group
terraform output -raw server_ip   # expect: 51.15.224.208
dig +short overpass.ivarnilsen.com
```

If the `dig` answer does not match `server_ip`, fix the A record at one.com **first** and
wait out the TTL. Caddy requests a certificate within seconds of first boot, and a wrong
record means a failed ACME challenge and a retry backoff.

### 2. Apply with import-grade hardware

The instance and volume are declared in Terraform, so this recreates both. Size up for the
import — `PLAY2-NANO` is sized for *serving*, and the import is the heaviest thing this box
ever does (see `deploy/overpass/INFRA.md` → "Import needs more machine than serving does"):

```bash
terraform apply -var 'instance_type=PRO2-XXS'
```

cloud-init does the rest unattended: formats and mounts the fresh volume at `/srv/overpass`,
installs Docker, renders the Caddyfile, and starts the stack. Overpass then downloads the
~1.3 GB Norway PBF, converts it to bz2 with osmium, and imports. Reference time on
`PRO2-XXS` was **~45 minutes**.

### 3. Watch the import with the signals that actually distinguish progress from failure

A plain "curl until 200" poll cannot tell a slow import from a crash loop. Use both:

```bash
ssh root@51.15.224.208
docker inspect -f '{{.RestartCount}}' overpass   # must stay 0 while importing
du -sh /srv/overpass/db/*                        # planet.osm.bz2 growing = downloading
                                                 # db/ growing = importing
```

Two signals that look alarming and are not:

- **One restart immediately after init is normal.** The image self-stops after init
  (`OVERPASS_STOP_AFTER_INIT`) and `restart: unless-stopped` revives it. Judge a crash loop
  by a *growing* count, not a non-zero one.
- **Hourly `ERROR: Error while downloading diffs` / `status code: 3`** is pyosmium saying
  "no new data". Check freshness properly instead — compare `timestamp_osm_base` in a query
  response against Geofabrik's `state.txt`.

### 4. Verify before you point the app at it

```bash
curl -s -H 'Origin: https://mtb.ivarnilsen.com' -D- -o/dev/null \
  'https://overpass.ivarnilsen.com/api/interpreter?data=[out:json];way(59.90,10.65,59.95,10.70)[highway];out geom;'
```

Expect HTTP/2 200, exactly **one** `access-control-allow-origin` header, and a response in
about a second. The reference run for that Nordmarka box returned 2894 ways, 100 % with
geometry, 113 carrying `mtb:scale`.

### 5. Drop back to serving-grade hardware

```bash
terraform apply    # back to the PLAY2-NANO default in terraform.tfvars
```

This is an **in-place update**, not a replacement: ~30 s of stop/start, the volume is
remounted via fstab, the DB is intact, containers come back on their own. Resizing never
re-imports, in either direction.

### 6. Re-point the app and ship it

In `app.js`, restore the constant and delete the pause comment above it:

```js
const SELF_HOSTED_OVERPASS = 'https://overpass.ivarnilsen.com/api/interpreter';
```

Bump `APP_CACHE` in `sw.js` (it is at `app-v4`; go to `app-v5`). **Never bump `TILE_CACHE`** —
that throws away every cached tile, DEM and trail response on every installed device.

```bash
./deploy/site/deploy.sh -y
```

Then confirm the *shipped bundle* really contains the change, rather than trusting the local
file — this is the mistake that once made an "app deployed" claim untrue:

```bash
docker run --rm --entrypoint sh rg.fr-par.scw.cloud/mtbrrrr-site/mtbrrrr-site:<tag> \
  -c "grep -n 'SELF_HOSTED_OVERPASS =' /usr/share/nginx/html/app.js"
```

On the phone, the new service worker needs ~2 reloads to take control.

## Traps that are already fixed — do not undo them

These cost real hours during the original build. They live in the committed config, so a
fresh `terraform apply` gets them for free, but do not "clean them up":

- **`OVERPASS_PLANET_PREPROCESS` (osmium pbf→bz2) in `docker-compose.yml` is load-bearing.**
  Overpass' `update_database` reads `.osm.bz2` and Geofabrik no longer publishes that for
  regions. Pointing `OVERPASS_PLANET_URL` at a `.osm.pbf` without the preprocess step gives
  a 1.3 GB download, `bunzip2: (stdin) is not a bzip2 file`, and a crash loop that looks
  like progress because the disk keeps filling with the same repeated download.
- **Caddy header ops need `defer`.** The Overpass image's nginx sets
  `Access-Control-Allow-Origin` itself, but only when the request carries an `Origin` header
   — so it is invisible to plain curl. Non-deferred ops run before `reverse_proxy` copies
  upstream headers, so ours stack instead of replacing, producing two ACAO headers and a
  browser CORS error.
- **Compose mounts the Caddy *directory*, not the Caddyfile.** Docker binds a single-file
  mount to the inode; rsync writes a temp file and renames, so the host shows new content
  while the container reads the old file forever and `caddy reload` cannot fix it. Verify
  what Caddy actually loaded from *inside* the container:
  `docker exec caddy caddy adapt --config /etc/caddy/Caddyfile`.
- **The SSH key must exist in the Scaleway project before boot.** Scaleway injects keys at
  boot from the project's IAM keys; a project with none produces an instance you cannot log
  into, and fixing it after the fact needs an instance replacement.
  `scaleway_iam_ssh_key.overpass` is still in state, so this is already satisfied.

## Two deploy scripts, and they are not interchangeable

- `deploy/site/deploy.sh` — builds and pushes the nginx image containing
  `index.html` / `app.js` / `sw.js` / `manifest.webmanifest`. **This is the one that ships
  app changes.**
- `deploy/overpass/deploy.sh` — rsyncs `docker-compose.yml` and the Caddyfile to the VM.
  Ships nothing from the app.

If unsure which one actually ran, compare the push time from `scw registry image list`
against the mtimes of the app files.

## Also worth a glance in spring

- The MapTiler key in `app.js` is referrer-restricted to `localhost` + `mtb.ivarnilsen.com`.
  Unchanged by the pause, but tiles 403 if that allow-list ever drifts.
- Basic-auth credentials live in `deploy/site/htpasswd` (gitignored). Still in place.
- Open items unrelated to the pause are tracked separately: adapting the ⬇️ cache-area
  pre-cache to MapTiler tile URLs, and the visual check that a stale cell revalidates.

## Reference

- `deploy/overpass/INFRA.md` — full infrastructure reference and troubleshooting
- `deploy/site/SITE.md` — site hosting, custom domain, basic auth
- `deploy/MAPTILER.md` — key setup and origin restrictions
