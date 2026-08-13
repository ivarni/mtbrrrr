terraform {
  required_providers {
    scaleway = {
      source  = "scaleway/scaleway"
      version = "~> 2.40"
    }
  }
  required_version = ">= 1.5"
}

# Credentials come from ~/.config/scw/config.yaml (run `scw init`) — no env vars needed.
provider "scaleway" {
  region     = var.region
  zone       = var.zone
  project_id = var.project_id
}

locals {
  domain = "${var.subdomain}.${var.dns_zone}"

  # Origins allowed to read Overpass responses cross-site. The app's own origin is derived
  # from the same dns_zone as the endpoint, so there is one place to change the domain.
  allowed_origins = concat(
    ["https://${var.site_subdomain}.${var.dns_zone}"],
    var.extra_allowed_origins,
  )

  # Escape the dots so the alternation matches the origins literally rather than treating
  # "." as "any character".
  origin_regex = join("|", [for o in local.allowed_origins : replace(o, ".", "\\.")])

  caddyfile = templatefile("${path.module}/../Caddyfile.tftpl", {
    domain       = local.domain
    origin_regex = local.origin_regex
  })
}

# ── Networking ─────────────────────────────────────────────────────────────────

# Reserved so the address survives replacing the instance — the DNS record and any
# firewall rules elsewhere stay valid.
resource "scaleway_instance_ip" "overpass" {
  type = "routed_ipv4"
}

resource "scaleway_instance_security_group" "overpass" {
  name                    = "${var.app_name}-sg"
  inbound_default_policy  = "drop"
  outbound_default_policy = "accept"

  # Caddy terminates TLS; 80 is needed for the ACME HTTP challenge and the redirect.
  inbound_rule {
    action = "accept"
    port   = 80
  }

  inbound_rule {
    action = "accept"
    port   = 443
  }

  # Narrow ssh_allowed_ip to your own address if you can — the default is open.
  inbound_rule {
    action   = "accept"
    port     = 22
    ip_range = var.ssh_allowed_ip
  }
}

# The A record has to exist before Caddy's first ACME attempt, hence the depends_on on
# the server below. Short TTL keeps a rebuild from being painful.
resource "scaleway_domain_record" "overpass" {
  count = var.manage_dns ? 1 : 0

  dns_zone = var.dns_zone
  name     = var.subdomain
  type     = "A"
  data     = scaleway_instance_ip.overpass.address
  ttl      = 300
}

# ── Storage ────────────────────────────────────────────────────────────────────

# The Overpass DB lives here, mounted at /srv/overpass by cloud-init. Keeping it off the
# root volume means the instance can be rebuilt without re-importing the Norway extract.
resource "scaleway_block_volume" "data" {
  name       = "${var.app_name}-data"
  size_in_gb = var.volume_size_gb
  iops       = 5000
}

# ── Access ─────────────────────────────────────────────────────────────────────

# Optional: Scaleway already injects every SSH key registered on the project, so this is
# only for adding a new one from here.
resource "scaleway_iam_ssh_key" "overpass" {
  count = var.ssh_public_key == null ? 0 : 1

  name       = "${var.app_name}-key"
  public_key = var.ssh_public_key
}

# ── Instance ───────────────────────────────────────────────────────────────────

resource "scaleway_instance_server" "overpass" {
  name              = var.app_name
  type              = var.instance_type
  image             = "ubuntu_noble"
  ip_id             = scaleway_instance_ip.overpass.id
  security_group_id = scaleway_instance_security_group.overpass.id
  tags              = ["mtbrrrr", "overpass"]

  root_volume {
    size_in_gb = 20
  }

  additional_volume_ids = [scaleway_block_volume.data.id]

  user_data = {
    cloud-init = templatefile("${path.module}/cloud-init.yaml.tftpl", {
      compose   = file("${path.module}/../docker-compose.yml")
      caddyfile = local.caddyfile
    })
  }

  depends_on = [scaleway_domain_record.overpass]
}
