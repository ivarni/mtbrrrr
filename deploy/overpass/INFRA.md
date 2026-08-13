# Infrastructure — Self-hosted Overpass (Norway)

Runs mtbrrrr's own Overpass API so trail queries never hit the public mirrors' rate limits
(the `429 Too Many Requests` / `504` errors). Serves the **Norway** extract; the app falls
back to public mirrors automatically when you ride outside Norway.

All infrastructure is managed with Terraform using the
[Scaleway provider](https://registry.terraform.io/providers/scaleway/scaleway/latest/docs).
`terraform apply` provisions the instance, storage and firewall, and cloud-init brings the
Overpass + Caddy stack up on first boot — nothing to click in the console, nothing to SSH in
and configure. The one manual step is a single DNS `A` record at your registrar; Terraform
creates that for you too if the zone happens to be delegated to Scaleway.

## Prerequisites

### 1. Create a Scaleway account and a project

Go to [console.scaleway.com](https://console.scaleway.com) and sign up if you don't have an
account yet. You'll need a credit card — Scaleway won't charge anything until you actually
provision resources.

Create a **new project** for mtbrrrr using the project selector in the left sidebar rather
than reusing an existing one, so the map's resources don't get tangled up with anything
else in the account. Note the **Project ID** from the project settings page — you'll need
it in `terraform.tfvars`.

---

### 2. Install Terraform

Terraform reads the `.tf` files in `infra/` and creates the cloud resources for you.

**macOS (Homebrew):**
```bash
brew tap hashicorp/tap
brew install hashicorp/tap/terraform
```

**Linux (Ubuntu/Debian):**
```bash
sudo apt-get update && sudo apt-get install -y gnupg software-properties-common
wget -O- https://apt.releases.hashicorp.com/gpg | gpg --dearmor | sudo tee /usr/share/keyrings/hashicorp-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/hashicorp.list
sudo apt update && sudo apt-get install terraform
```

**Other platforms:** download the binary from
[developer.hashicorp.com/terraform/install](https://developer.hashicorp.com/terraform/install).

Verify:
```bash
terraform -version   # should print "Terraform v1.5.x" or higher
```

---

### 3. Install the Scaleway CLI

The Scaleway CLI (`scw`) handles authentication and is handy for inspecting things later.

**macOS (Homebrew):**
```bash
brew install scw
```

**Linux:**
```bash
curl -s https://raw.githubusercontent.com/scaleway/scaleway-cli/master/scripts/get.sh | sudo bash
```

**Other platforms:** see the
[Scaleway CLI releases page](https://github.com/scaleway/scaleway-cli/releases).

Verify:
```bash
scw version
```

You don't need Docker locally — the image is pulled and run on the server.

---

### 4. Get your Scaleway API credentials

1. In the Scaleway Console, click your **profile icon** (top-right) → **API Keys**
2. Note your **Organisation ID** shown on this page — you'll need it in the next step
3. Click **Generate an API key**
4. For **API key bearer**, choose **Myself (IAM user)** for a personal project like this one
5. Give it a description (e.g. "mtbrrrr-terraform") and leave expiration at 1 year
6. Copy both the **Access Key** and the **Secret Key** — the secret key is only shown once

> Keep these safe. Anyone with the secret key has full access to your Scaleway account.

---

### 5. Configure the Scaleway CLI

```bash
scw init
```

It asks for your **Access Key**, **Secret Key** and **Organisation ID**, then lets you pick
a project. Credentials are saved to `~/.config/scw/config.yaml`; both Terraform and `scw`
pick them up automatically from there — no environment variables needed.

> If you already used `scw init` for another project, the default project in that file will
> be the wrong one. That's fine — `project_id` in `terraform.tfvars` overrides it. Terraform
> prints a "Multiple variable sources detected" warning when that happens; it's harmless.

---

### 6. Register your SSH key — do this before the first apply

Scaleway injects SSH keys into an instance **at boot**, and only the keys registered in the
*same project*. A brand-new project has none, so if you skip this you will not be able to
SSH in, and the only fix is replacing the instance — which means a fresh 20–60 minute
import. Set `ssh_public_key` in `terraform.tfvars`:

```bash
cat ~/.ssh/id_ed25519.pub
```

Terraform registers it (`scaleway_iam_ssh_key`) so it's present from the first boot. To
check what a project already has:

```bash
scw iam ssh-key list project-id=<your-project-id>
```

Adding a key later registers it for *future* boots only — an already-running instance won't
pick it up.

---

### 7. Pick the hostname

Caddy needs a real hostname to get a Let's Encrypt certificate, and the app needs HTTPS to
call the endpoint without mixed-content errors. You'll point a subdomain —
`overpass.<yourdomain>` by default — at the server.

**DNS at your own registrar** (the default, `manage_dns = false`): set `dns_zone` to your
domain and `subdomain` to whatever you want in front of it. Terraform doesn't touch DNS;
you add one `A` record yourself, and the deployment flow below sequences the apply so the
record exists *before* the server first tries for a certificate.

**DNS delegated to Scaleway** (`manage_dns = true`): Terraform creates the `A` record too,
and the whole thing is a single apply. This only works if Scaleway is authoritative for the
zone — either register the domain through Scaleway, or add an existing one under **Domains
& DNS → Manage an external domain** and repoint its nameservers at your registrar. Confirm
with `scw dns zone list` before enabling it; an empty list means it isn't delegated.

---

## Deployment flow

Run these from the `infra/` directory unless stated otherwise.

1. **Configure.** Copy the example and fill in real values — at minimum `project_id` and
   `dns_zone`:
   ```bash
   cp terraform.tfvars.example terraform.tfvars
   ```
   `terraform.tfvars` is gitignored and never committed, so a fresh clone won't have one.

2. **Initialise.** Downloads the Scaleway provider:
   ```bash
   terraform init
   ```

3. **Preview.** Nothing is provisioned yet — expect 4 resources to add (5 with
   `manage_dns = true`):
   ```bash
   terraform plan
   ```

4. **Reserve the IP first, then create the DNS record.** *(Skip to step 5 if
   `manage_dns = true` — Terraform handles the record and the ordering itself.)*

   The IP is a separate resource from the server, so you can create just that one and get
   the address before anything needs it. Terraform warns that this is a partial apply —
   that's expected here:
   ```bash
   terraform apply -target=scaleway_instance_ip.overpass
   terraform output -raw server_ip
   ```

   Now add an `A` record at your registrar for `overpass.<yourdomain>` pointing at that
   address, with as short a TTL as it offers. Doing this *before* the server exists means
   the name already resolves when Caddy makes its first certificate request, which avoids
   the retry-backoff wait described in the troubleshooting section.

   > **On Cloudflare:** leave the record **DNS only** (grey cloud). Proxying it breaks the
   > ACME HTTP challenge and puts Cloudflare's request limits in front of your own server —
   > the exact thing self-hosting is meant to escape.

5. **Provision the rest.** Takes a couple of minutes:
   ```bash
   terraform apply
   ```

6. **Wait for the import.** The apply returns as soon as the instance is up, but cloud-init
   is still working and Overpass then imports the Norway extract — **20–60 minutes** on the
   first boot. The endpoint returns `502` until the dispatcher is serving. To watch:
   ```bash
   $(terraform output -raw ssh_command)
   cloud-init status --wait
   docker compose -f /opt/overpass/docker-compose.yml logs -f overpass | tr '\r' '\n'
   ```

   The first several minutes are just the ~1.5 GB extract downloading, shown as a single
   `curl` progress line that redraws with carriage returns — hence the `tr`, and why the log
   can look stuck when it isn't. Watching the files is clearer:

   ```bash
   while :; do du -sh /srv/overpass/db /srv/overpass/db/db; sleep 30; done
   ```

   `planet.osm.bz2` growing means it's still downloading; `db/` filling means the import
   itself has started.

7. **Verify:**
   ```bash
   # -g disables curl's URL globbing, which would otherwise choke on the [ in [out:json]
   curl -g "$(terraform output -raw overpass_url)?data=[out:json];node(59.91,10.74,59.92,10.75);out;"
   ```
   Should return JSON with `elements`. A valid certificate here also proves the DNS record
   and the ACME challenge worked.

8. **Point the app at it.** Set `SELF_HOSTED_OVERPASS` in `../../app.js` to the endpoint:
   ```bash
   terraform output -raw overpass_url
   ```
   The app already routes Norway cells to this endpoint (with public mirrors as fallback)
   and everything abroad to public mirrors.

### Updating the running stack

Changes to `docker-compose.yml` or `Caddyfile.tftpl` go out **without** touching the
instance — from `deploy/overpass/`:

```bash
./deploy.sh
```

It applies Terraform (which re-renders the `caddyfile` output — see below), reads the server
IP, rsyncs both files to `/opt/overpass/` and reloads Caddy. The database on `/srv/overpass`
is left alone, so nothing gets re-imported.

Two things in that sequence are there for a reason, and removing either gives you a deploy
that silently does nothing:

- **`terraform apply` runs first.** The `caddyfile` output is rendered from the template at
  *apply* time and read back from state, so editing `Caddyfile.tftpl` alone leaves the output
  stale and `deploy.sh` would push the old file. Applying also keeps the copy baked into the
  instance's cloud-init `user_data` in step with what is being pushed, so a rebuilt server
  boots with the same config. Editing the Caddyfile is an in-place `user_data` update, not a
  replacement — it does not touch the running containers or the volume.
- **The explicit `caddy reload`.** `up -d` alone catches changes to `docker-compose.yml` but
  is a no-op for a changed Caddyfile: to Docker, a bind-mounted file changing content is not a
  config change, so the container keeps running with the old config loaded. The reload is
  graceful, and the cert in the `caddy_data` volume is reused rather than re-issued.

Related, and the reason `docker-compose.yml` mounts the `/opt/overpass` **directory** rather
than the Caddyfile itself: Docker binds a single-*file* mount to that file's inode. rsync (and
most editors) write a temp file and rename it over the target, producing a new inode — after
which the host shows your change and the container keeps reading the old file indefinitely,
and no amount of reloading fixes it, because the container is pinned to the orphaned inode. A
directory mount resolves the path on every open, so a replaced file is simply picked up.

To check what Caddy actually loaded, ask the container — not the host:

```bash
ssh root@<ip> 'docker exec caddy caddy adapt --config /etc/caddy/Caddyfile' | python3 -m json.tool
```

A `cat` on the host proves nothing about what the container sees.

> Don't reach for `terraform apply -replace` to pick up a compose change. Replacing the
> instance means a fresh 20–60 minute import.

---

## Infrastructure reference

The sections below explain what Terraform manages and why. You don't need to read any of
this to deploy — it's here if you want to understand what's been provisioned or need to
adjust sizing later.

### Instance

`PLAY2-NANO` (2 vCPU / 4 GB) by default, running Ubuntu Noble. The root volume is 20 GB and
holds only the OS and `/opt/overpass` — the database lives on the separate block volume
below.

#### Import needs more machine than serving does

These two workloads are very different, and the default is sized for the *second* one:

- **The initial import** downloads a ~1.3 GB PBF, converts it with `osmium`, and builds the
  database. It is the heaviest thing this server ever does — CPU-bound, disk-heavy, and the
  step most likely to crawl or die on a small instance.
- **Serving queries** afterwards is trivial. A Nordmarka-sized bounding box returns ~2900
  ways in about a second.

The reference import for this stack ran on `PRO2-XXS` (2 vCPU / 8 GB) and took ~45 minutes.
The default was then dropped to `PLAY2-NANO` to halve the running cost, because there is no
reason to pay for import-grade hardware to serve a handful of queries a week.

**If your first import is painfully slow, gets OOM-killed, or dies during the osmium step,
size up for the import and shrink afterwards.** Both directions are safe — the database is
on its own block volume, so changing `instance_type` never re-imports:

```bash
# import on something with headroom
terraform apply -var 'instance_type=PRO2-XXS'
# …once the endpoint serves 200, drop back down
terraform apply
```

Each change stops and restarts the instance (~2 minutes), during which the app falls back to
the public mirrors. Pick a type whose `supported_storage` includes `Block`; check with
`scw instance server-type list zone=fr-par-1`.

> Beware the catalogue's `hourly_price` on GPU types — `L4-1-24G` lists at roughly €10/month
> for 8 vCPU / 48 GB, which is the GPU component missing from the figure, not a bargain.

### Block Storage volume

50 GB by default, formatted `ext4` and mounted at `/srv/overpass` by cloud-init; the compose
file bind-mounts `/srv/overpass/db` into the container as `/db`. The Norway DB is ~10–20 GB
without meta, and the headroom covers diff updates.

Keeping the database off the root volume is the point: the instance can be rebuilt while the
volume — and the imported database — survives.

### Flexible IP

Reserved separately from the instance (`scaleway_instance_ip`) so the address survives
replacing the server, which keeps the DNS record valid.

### Security group

Default-drop inbound, accept outbound. Open: **80** (ACME HTTP challenge and the HTTPS
redirect), **443** (the API), and **22** from `ssh_allowed_ip`, which defaults to
`0.0.0.0/0`. Narrow that to your own address if you have a stable one.

### DNS record

An `A` record for `overpass.<dns_zone>` with a 300s TTL, created only when
`manage_dns = true`. The instance declares `depends_on` the record so the name exists before
Caddy's first ACME attempt.

### cloud-init

`infra/cloud-init.yaml.tftpl` is rendered with the compose file and the rendered Caddyfile
embedded, and runs once on first boot. It writes `/opt/overpass/{docker-compose.yml,Caddyfile,bootstrap.sh}`
and executes `bootstrap.sh`, which:

1. finds the data disk (the first whole disk with nothing mounted off it — this skips the
   root volume, and Scaleway's `/dev/disk/by-id` paths for SBS volumes aren't stable enough
   to hardcode)
2. formats it **only if blank** — an existing filesystem is never touched
3. mounts it at `/srv/overpass` with a `nofail` fstab entry, and creates `db/`
4. installs Docker via `get.docker.com`
5. runs `docker compose up -d`

Every step is idempotent, and the script stays on disk so it can be re-run by hand.

### Caddy and the Caddyfile

Caddy is the public entrypoint; Overpass is only reachable inside the compose network. Caddy
provisions and renews the Let's Encrypt certificate automatically and adds the
`Access-Control-Allow-Origin` header the browser needs to read the response.

`Caddyfile.tftpl` is the single source — Terraform renders it once and feeds the result to
both cloud-init and the `caddyfile` output that `deploy.sh` pushes, so the domain
substitution can't drift between the two paths. Edit the template, never the copy on the
server.

### Data freshness

The compose file pulls Geofabrik's Norway diffs hourly (`OVERPASS_UPDATE_SLEEP=3600`), so
the database stays current with no intervention. Bump that value down if you want fresher
data, then `./deploy.sh`.

**`ERROR: Error while downloading diffs` / `Update finished with status code: 3` is
normally benign.** Status 3 is pyosmium's "no new data available", not a failure — you'll
see it every hour whenever the database is already at Geofabrik's newest sequence, which
for a regional extract publishing daily is most of the time. Check actual freshness instead
of trusting the log:

```bash
# what our data is dated
curl -gs --data-urlencode 'data=[out:json];node(59.91,10.74,59.9105,10.7405);out;' \
  -G https://overpass.<yourdomain>/api/interpreter | grep timestamp_osm_base

# what Geofabrik has published
curl -s https://download.geofabrik.de/europe/norway-updates/state.txt
```

If those two are close, updates are working. Worry only if our timestamp falls days behind
the published `sequenceNumber`.

To update the Overpass image:
```bash
ssh root@<ip> 'cd /opt/overpass && docker compose pull && docker compose up -d'
```

To re-import from scratch:
```bash
ssh root@<ip> 'cd /opt/overpass && docker compose down && rm -rf /srv/overpass/db/* && docker compose up -d'
```

---

## Troubleshooting

**The endpoint returns 502 / connection refused right after apply**

Expected. The Norway import takes 20–60 minutes on first boot and Overpass doesn't answer
until the dispatcher is up. Follow it:

```bash
$(terraform output -raw ssh_command)
cloud-init status --wait      # blocks until first-boot provisioning finishes
docker compose -f /opt/overpass/docker-compose.yml logs -f overpass
```

---

**`Permission denied (publickey)` when you try to SSH in**

The instance booted without your key. Scaleway injects keys from the project's IAM SSH keys
at boot time only, so a key added after the instance was created doesn't reach it:

```bash
scw iam ssh-key list project-id=<your-project-id>   # empty on a fresh project
```

Set `ssh_public_key` in `terraform.tfvars`, then replace the instance so it boots with the
key present. Replace the volume at the same time **if the import hasn't finished** — the
Overpass image skips its init step when `/db` looks populated, so a half-imported database
would come back as a broken dispatcher rather than re-importing:

```bash
terraform apply -replace=scaleway_instance_server.overpass -replace=scaleway_block_volume.data
```

If the import *had* completed, replace only the server and keep the database:

```bash
terraform apply -replace=scaleway_instance_server.overpass
```

The flexible IP is a separate resource and survives either way, so DNS stays valid.

---

**The endpoint 502s for hours — is it importing, or crash-looping?**

`restart: unless-stopped` makes a container that dies on startup look like a running one, so
"the container is up" proves nothing. Check the restart count — it should stay at 0:

```bash
docker inspect -f '{{.RestartCount}} restarts, started {{.State.StartedAt}}' overpass
```

A count that keeps climbing, or a `StartedAt` that keeps moving, means it's failing and
retrying. **Exactly one restart shortly after the import completes is normal** — the image
stops itself after init (`OVERPASS_STOP_AFTER_INIT` defaults to true) and `restart:
unless-stopped` brings it back up in update mode. Judge by whether the number is *growing*,
not by whether it's non-zero.

Then check which *file* is growing, which tells you the phase:

```bash
du -sh /srv/overpass/db/*
```

`planet.osm.bz2` growing = still downloading. `db/` growing = importing for real. A total
size that climbs, resets, and climbs again is the same download looping — that's a crash
loop, not progress. Watching `du -sh /srv/overpass/db` on the parent directory alone will
not distinguish the two.

---

**`bunzip2: (stdin) is not a bzip2 file` / `Failed to process planet file`**

Overpass' `update_database` reads `.osm.bz2`, but Geofabrik only publishes PBF for regional
extracts — the `.osm.bz2` files are gone and 404. Pointing `OVERPASS_PLANET_URL` at a `.pbf`
downloads 1.3 GB, fails to decompress it, and loops forever.

The fix is already in `docker-compose.yml`: `OVERPASS_PLANET_PREPROCESS` converts the PBF
with `osmium` before the import, which is the recipe from the image's own README. If you
change the extract URL, keep that variable. After fixing, clear the bad download so init
runs clean:

```bash
docker compose stop overpass
rm -rf /srv/overpass/db/*
# from deploy/overpass/ on your laptop:
./deploy.sh
```

---

**cloud-init failed, or the volume isn't mounted**

Check what the bootstrap script did:

```bash
lsblk                                   # is the 50 GB volume mounted at /srv/overpass?
cat /var/log/cloud-init-output.log      # full first-boot output
```

The disk detection picks the first whole disk with no mountpoint. If it chose wrong — or
found nothing, which is what happens if the volume failed to attach — mount it by hand and
re-run the script, which is safe to run repeatedly:

```bash
mkfs.ext4 /dev/sdb                      # ONLY if the disk is blank; check `blkid /dev/sdb` first
mkdir -p /srv/overpass
echo '/dev/sdb /srv/overpass ext4 defaults,nofail 0 2' >> /etc/fstab
mount -a
/opt/overpass/bootstrap.sh
```

---

**Caddy can't get a certificate**

Almost always DNS. Confirm the name resolves to the instance — these two should match:

```bash
dig +short "$(cd infra && terraform output -raw overpass_domain)"
(cd infra && terraform output -raw server_ip)
```

If the `dig` is empty, the `A` record isn't live yet: either you haven't added it at your
registrar, or it hasn't propagated. If it returns a *different* address, you're behind a
proxy — on Cloudflare, switch the record to **DNS only** (grey cloud); the ACME HTTP
challenge can't complete through the orange cloud.

Caddy retries on its own, but backs off after repeated failures, so a certificate can take a
while to appear even once DNS is correct. To force an immediate attempt:

```bash
docker compose -f /opt/overpass/docker-compose.yml restart caddy
docker compose -f /opt/overpass/docker-compose.yml logs -f caddy
```

Don't loop on that — Let's Encrypt rate-limits failed authorisations per hostname per hour.
Fix DNS first, confirm with `dig`, *then* restart Caddy once.

---

**The app still hits the public mirrors**

`SELF_HOSTED_OVERPASS` in `app.js` only takes effect for cells inside Norway — that's
deliberate, see `cellInNorway()`. Outside Norway the public mirrors are correct behaviour.

---

**Terraform wants to replace the instance**

Check what triggered it before applying. Changing `user_data` — which includes the embedded
compose file and Caddyfile — forces a rebuild and therefore a full re-import. Use
`./deploy.sh` for content changes; let Terraform replace the instance only when you actually
mean to rebuild the machine. The block volume is a separate resource and survives.

---

## Variables

Define these in `infra/terraform.tfvars` (copy from `terraform.tfvars.example`):

| Variable | Default | Description |
|---|---|---|
| `project_id` | *required* | Scaleway project ID, from the console project settings page |
| `dns_zone` | *required* | Your domain, e.g. `example.com`. Only builds the hostname unless `manage_dns` |
| `subdomain` | `overpass` | Subdomain for the endpoint |
| `manage_dns` | `false` | Create the `A` record in Scaleway DNS. Only valid if the zone is delegated there |
| `app_name` | `mtbrrrr-overpass` | Base name for all resources |
| `region` | `fr-par` | Scaleway region |
| `zone` | `fr-par-1` | Scaleway zone |
| `instance_type` | `PLAY2-NANO` | ≥ 2 vCPU / ≥ 4 GB, `Block` storage. Size up for the initial import — see above |
| `volume_size_gb` | `50` | Block Storage for the Overpass DB |
| `ssh_allowed_ip` | `0.0.0.0/0` | CIDR allowed to reach port 22 |
| `ssh_public_key` | `null` | **Set this on a new project.** Keys are injected at boot from the project's IAM keys; a fresh project has none |

## Outputs

| Output | Description |
|---|---|
| `overpass_url` | Full endpoint — paste into `SELF_HOSTED_OVERPASS` in `app.js` |
| `overpass_domain` | Hostname the API is served on |
| `server_ip` | Public IPv4 — used by `deploy.sh`, and for the manual `A` record |
| `caddyfile` | Rendered Caddyfile, consumed by `deploy.sh` |
| `ssh_command` | `ssh root@<ip>`, for troubleshooting |
