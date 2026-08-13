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
# Same setup as deploy/overpass/infra; this can share that project or use its own.
provider "scaleway" {
  region     = var.region
  project_id = var.project_id
}

locals {
  domain    = "${var.subdomain}.${var.dns_zone}"
  site_root = "${path.module}/../../.."

  # Everything baked into the image.
  image_sources = [
    "index.html",
    "app.js",
    "sw.js",
    "manifest.webmanifest",
    "deploy/site/Dockerfile",
    "deploy/site/nginx.conf",
  ]

  # htpasswd is gitignored, so guard the read — a bare `terraform plan` before you have
  # created it should reach deploy.sh's explanation, not crash inside filesha256.
  htpasswd_path = "${local.site_root}/deploy/site/htpasswd"

  content_hashes = concat(
    [for f in local.image_sources : filesha256("${local.site_root}/${f}")],
    fileexists(local.htpasswd_path) ? [filesha256(local.htpasswd_path)] : [],
  )

  # The tag is derived from the image contents so Terraform sees a NEW registry_image
  # whenever a file changes, and redeploys. A fixed :latest tag reads as unchanged to
  # Terraform, so the container would keep running the old image forever.
  image_tag = substr(sha256(join("", local.content_hashes)), 0, 12)

  image_ref = "${scaleway_registry_namespace.site.endpoint}/${var.app_name}:${local.image_tag}"

  # public_endpoint is documented as a URL; strip any scheme so this is always a bare host,
  # which is what a CNAME target and the MapTiler origin allow-list both need.
  container_host = replace(scaleway_container.site.public_endpoint, "https://", "")
}

# ── Registry ───────────────────────────────────────────────────────────────────

# A container namespace used to bring its own registry; the provider now says a registry
# "has to be handled separately", so this is explicit. Private storage is €0.027/GB/month
# and the image is ~15 MB.
#
# Registry namespace names are unique per region across ALL Scaleway accounts, not just
# yours — if the first apply fails on a name conflict, set registry_name in tfvars.
resource "scaleway_registry_namespace" "site" {
  name        = coalesce(var.registry_name, var.app_name)
  description = "Static image for the mtbrrrr PWA"
  is_public   = false
}

# ── Container ──────────────────────────────────────────────────────────────────

resource "scaleway_container_namespace" "site" {
  name        = var.app_name
  description = "mtbrrrr static site"
}

resource "scaleway_container" "site" {
  name         = var.app_name
  namespace_id = scaleway_container_namespace.site.id

  image    = local.image_ref
  port     = 8080
  protocol = "http1"

  # "public" means reachable without a Scaleway auth token — required for a browser to load
  # it at all. Access control is nginx basic auth inside the container, not this setting.
  privacy = "public"

  # Send plain HTTP to HTTPS. The service worker and geolocation both need a secure origin.
  https_connections_only = true

  cpu_limit = var.cpu_limit
  # The API takes bytes and the provider's MB is decimal (1 MB = 1,000,000), so the 128 MB
  # tier is 128000000 — not 128 MiB.
  memory_limit_bytes = var.memory_limit * 1000 * 1000
  min_scale          = var.min_scale
  max_scale          = var.max_scale

  # /_health is the one path nginx leaves outside basic auth — see nginx.conf. Without this
  # the probe would hit an authenticated path, get a 401 every time, and the container would
  # never come up healthy.
  liveness_probe {
    http {
      path = "/_health"
    }
    interval          = "30s"
    timeout           = "5s"
    failure_threshold = 5
  }
}

# ── DNS and custom domain ──────────────────────────────────────────────────────

# Only if the zone is delegated to Scaleway. It is not for ivarnilsen.com (one.com), so
# this defaults off and you add the CNAME at the registrar by hand — same as Overpass.
resource "scaleway_domain_record" "site" {
  count = var.manage_dns && var.custom_domain_enabled ? 1 : 0

  dns_zone = var.dns_zone
  name     = var.subdomain
  type     = "CNAME"
  data     = "${local.container_host}."
  ttl      = 300
}

# Scaleway validates that the hostname already resolves to the container endpoint and then
# issues the certificate over HTTP-01, so the CNAME has to be live BEFORE this applies.
# That is why it is gated: first apply with custom_domain_enabled = false, add the CNAME
# from the container_cname output, then flip it to true and apply again.
resource "scaleway_container_domain" "site" {
  count = var.custom_domain_enabled ? 1 : 0

  container_id = scaleway_container.site.id
  hostname     = local.domain

  depends_on = [scaleway_domain_record.site]
}
