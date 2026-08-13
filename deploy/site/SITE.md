# Static site hosting — Scaleway Serverless Containers

The mtbrrrr PWA is four files (`index.html`, `app.js`, `sw.js`, `manifest.webmanifest`).
This stack bakes them into an nginx image and runs it as a Scaleway Serverless Container,
behind basic auth, on your own subdomain, over HTTPS.

Terraform owns the durable things (registry, container namespace, container, custom domain);
`deploy.sh` does the build-and-push in the middle and reads everything else from Terraform
outputs, so there is nothing to keep in sync by hand. Same shape as
[`../overpass/INFRA.md`](../overpass/INFRA.md).

## Why a container and not a bucket

Scaleway's other static-hosting route is an Object Storage bucket with the *bucket website*
feature, fronted by Edge Services for HTTPS and a custom domain. That works, costs about
€0.99/month for the cheapest Edge Services plan, and — the reason it was rejected here —
**cannot be password-protected.** A bucket website has to be publicly readable, and Edge
Services offers a WAF, not authentication. Running our own nginx gives us `auth_basic`.

## Cost

Serverless Containers bill for running time, not requests. The free tier is **400,000 GB-s
of memory and 200,000 vCPU-s per account per month**, shared with any other Serverless
Containers or Functions in the account.

At the 128 MB / 70 mvCPU tier, a full 730-hour month of uptime is:

| Resource | Used | Free tier |
|---|---|---|
| Memory | 2,628,000 s × 0.125 GB = 328,500 GB-s | 400,000 |
| vCPU | 2,628,000 s × 0.07 = 183,960 vCPU-s | 200,000 |

So even `min_scale = 1` — an instance kept permanently warm — fits, though with only ~8%
headroom on vCPU. It stops fitting the moment something else in the account starts eating
the same allowance, and unsubsidized that same always-warm month is about €2.50. The
default is `min_scale = 0`, which is far below the free tier with room to spare.

Registry storage is €0.027/GB/month for private images. The image is ~15 MB, so fractions
of a cent. The certificate for the custom domain is free.

Cold starts with `min_scale = 0` are roughly a second, and mostly invisible in practice:
`sw.js` serves the app shell stale-while-revalidate, so after the first visit the shell
comes out of the service worker cache and the container start happens in the background.

## Prerequisites

Terraform and the Scaleway CLI, both already set up if you followed
[`../overpass/INFRA.md`](../overpass/INFRA.md) — same `~/.config/scw/config.yaml`
credentials, and `terraform.tfvars` here can reuse the same `project_id`.

Additionally:

- **Docker, running.** `deploy.sh` fails early if the daemon is not up.
- **`terraform.tfvars`** — copy `infra/terraform.tfvars.example` and fill it in.

## Deployment flow

### 1. Create the password file

```sh
htpasswd -cbB deploy/site/htpasswd <username> '<password>'
```

`-B` is bcrypt, `-c` creates the file. It is gitignored. `deploy.sh` refuses to run without
it, because nginx will not start without it.

The file's hash is part of the image tag, so changing the password rolls out like any other
change.

### 2. First deploy

```sh
./deploy.sh
```

That will:

1. `terraform apply -target=scaleway_registry_namespace.site` — the registry has to exist
   before we can push, and the container cannot be created pointing at an image that is not
   in the registry yet.
2. `docker build --platform linux/amd64` from the repo root and push.
3. `terraform apply` — creates the container namespace and the container.

It prints the live URL at the end. At this point the site is on the Scaleway endpoint
(`https://<something>.functions.fnc.fr-par.scw.cloud`), not your domain.

### 3. Point your domain at it

DNS for `ivarnilsen.com` is at one.com, not Scaleway, so this is the same manual step as the
Overpass A record. Get the target:

```sh
terraform -chdir=deploy/site/infra output -raw container_cname
```

Add at one.com:

```
mtb   IN CNAME   <that value>.
```

Wait for it to resolve (`dig mtb.ivarnilsen.com CNAME +short`), **then** set
`custom_domain_enabled = true` in `terraform.tfvars` and run `./deploy.sh` again.

The order matters. Scaleway checks that the hostname already resolves to the container
endpoint and issues the certificate over an HTTP-01 challenge, so applying
`scaleway_container_domain` before the CNAME is live just fails.

If you ever delegate the zone to Scaleway, set `manage_dns = true` and the CNAME becomes a
Terraform resource instead.

### 4. Allow the new origin on the MapTiler key

The base map 403s from an origin that is not on the key's allow-list. Add the **bare host**
— no scheme, no port; MapTiler rejects those with "Invalid origin restriction":

```sh
terraform -chdir=deploy/site/infra output -raw maptiler_origin
```

Paste that into MapTiler → Account → Keys → Allowed origins, alongside `localhost`.

## Updating the site

```sh
./deploy.sh
```

Edit any of the four site files, or `nginx.conf`, or `htpasswd`, and re-run. The image tag
is a hash of those contents, so a rebuild produces a new tag, Terraform sees a changed
`image`, and the container rolls. Nothing changed means the same tag and a no-op apply.

This is why there is no `:latest` tag: to Terraform a fixed tag looks unchanged, so the
container would happily keep serving the old image forever.

`./deploy.sh -y` skips the confirmation prompt on the final apply.

## Reference

### Files

| File | What it is |
|---|---|
| `Dockerfile` | nginx:alpine + the four site files. Build context is the **repo root**. |
| `nginx.conf` | Replaces nginx's stock `default.conf`. Port 8080, basic auth, cache headers. |
| `htpasswd` | Gitignored. Created by you in step 1. |
| `deploy.sh` | Build, push, apply. |
| `infra/` | Terraform: registry namespace, container namespace, container, custom domain. |
| `../../.dockerignore` | Keeps `.git` and Terraform state out of the build context. |

### Things that will bite you

- **`--platform linux/amd64` is not optional.** Scaleway runs amd64. An image built natively
  on an Apple Silicon Mac is arm64 and dies at start with `exec format error`, which shows up
  as a container that never becomes ready. `deploy.sh` always passes it.
- **The liveness probe has to point at `/_health`.** That is the one path `nginx.conf` leaves
  outside `auth_basic`. Aim the probe at any authenticated path and every check comes back
  401, the container never reports healthy, and the deploy fails with nothing obviously wrong
  in the container logs.
- **`privacy = "public"` is required.** It means "no Scaleway auth token needed", which is
  what lets a browser load the page at all. Access control is nginx's basic auth, not this.
- **`sw.js` must not be cached long.** `nginx.conf` sends `Cache-Control: no-cache` on
  everything, which with ETags is a 304 in the common case. Nothing here is content-hashed,
  and a long `max-age` on `sw.js` would leave browsers running an old service worker that
  then serves the old app shell from its own cache — the app can pin itself to a stale
  version indefinitely.
- **Basic auth in an installed PWA.** Browsers prompt once and keep the credentials for the
  origin, and the service worker's same-origin fetches inherit them. It does work, but if
  the standalone-mode prompt ever misbehaves on iOS, the escape hatch is to drop the
  `auth_basic` lines from `nginx.conf` and the `htpasswd` COPY from the `Dockerfile` and rely
  on an obscure hostname instead.

### Variables

| Variable | Default | Notes |
|---|---|---|
| `project_id` | — | Required. The Overpass project is fine. |
| `region` | `fr-par` | Containers run in `fr-par`, `nl-ams`, `pl-waw`. |
| `app_name` | `mtbrrrr-site` | Names the registry namespace, container namespace, container, image. |
| `registry_name` | `null` | Override only if `app_name` collides — registry names are unique per region across all of Scaleway. |
| `dns_zone` | — | Required, e.g. `ivarnilsen.com`. |
| `subdomain` | `mtb` | Site is served at `mtb.ivarnilsen.com`. |
| `custom_domain_enabled` | `false` | Flip to true only after the CNAME resolves. |
| `manage_dns` | `false` | True only if the zone is delegated to Scaleway. |
| `memory_limit` | `128` | MB. Provider takes bytes with a decimal MB, so 128 MB is 128,000,000 — not 128 MiB. |
| `cpu_limit` | `70` | mvCPU. What pairs with 128 MB. |
| `min_scale` | `0` | 1 keeps it warm and still fits the free tier on its own. |
| `max_scale` | `1` | Caps the worst case. |

### Outputs

| Output | Use |
|---|---|
| `site_url` | Where the site is served. |
| `default_url` | Scaleway endpoint; works with or without the custom domain. |
| `container_cname` | CNAME target for step 3. |
| `maptiler_origin` | Bare host for the MapTiler allow-list, step 4. |
| `registry_endpoint` | What `deploy.sh` pushes to. |
| `image_tag` / `image_ref` | Content hash and the full image reference. |

## Troubleshooting

**Container stuck not ready / deploy times out.** Almost always the platform or the probe.
Check the architecture (`docker image inspect <image> --format '{{.Architecture}}'` should
say `amd64`) and check the container logs in the console for nginx failing to start — a
missing `htpasswd` inside the image gives
`open() "/etc/nginx/htpasswd" failed`.

**401 on everything including the health check.** The probe path drifted from `/_health`, or
`nginx.conf`'s `auth_basic off` in that location block was removed.

**`terraform apply` fails on the custom domain.** The CNAME is not resolving yet, or resolves
somewhere other than `container_cname`. Check with `dig`, then re-apply — Scaleway will not
issue the certificate until the challenge can reach the container.

**Registry name conflict on first apply.** Set `registry_name` in `terraform.tfvars`.

**Map loads but there are no tiles.** The MapTiler key's origin allow-list, step 4. Look for
403s from `api.maptiler.com` in the console.

**Push fails with unauthorized.** `scw registry login` again; `deploy.sh` runs it, but a
stale docker credential helper entry can shadow it.
