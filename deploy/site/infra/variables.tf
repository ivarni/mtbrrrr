variable "app_name" {
  description = "Base name used for the registry namespace, container namespace, container and image"
  type        = string
  default     = "mtbrrrr-site"
}

variable "registry_name" {
  description = "Override for the registry namespace name. Registry names are unique per region across all Scaleway accounts, so set this if app_name is already taken. Null means use app_name."
  type        = string
  default     = null
}

variable "project_id" {
  description = "Scaleway project ID. Can be the same project as deploy/overpass."
  type        = string
}

variable "region" {
  description = "Scaleway region. Serverless Containers run in fr-par, nl-ams and pl-waw."
  type        = string
  default     = "fr-par"
}

# ── DNS ────────────────────────────────────────────────────────────────────────

variable "dns_zone" {
  description = "Your domain, e.g. example.com. Only used to build the hostname unless manage_dns is true."
  type        = string
}

variable "subdomain" {
  description = "Subdomain the site is served on"
  type        = string
  default     = "mtb"
}

variable "custom_domain_enabled" {
  description = "Attach the custom domain to the container. Leave false for the first apply — the CNAME must already resolve to the container endpoint before Scaleway will accept the domain and issue a certificate. See SITE.md."
  type        = bool
  default     = false
}

variable "manage_dns" {
  description = "Create the CNAME in Scaleway DNS. Only works if the zone is delegated to Scaleway — leave false when DNS lives at your registrar and add the record there from the container_cname output."
  type        = bool
  default     = false
}

# ── Sizing ─────────────────────────────────────────────────────────────────────
#
# The free tier is 400,000 GB-s of memory and 200,000 vCPU-s per ACCOUNT per month, shared
# with any other Serverless Containers or Functions you run. At 128 MB / 70 mvCPU, a full
# 730-hour month of uptime costs 328,500 GB-s and 183,960 vCPU-s — inside both, but with
# only ~8% headroom on vCPU. So min_scale = 1 is free today, and stops being free the
# moment something else in the account starts consuming the same allowance.

variable "memory_limit" {
  description = "Memory in MB. 128 is the smallest tier and plenty for nginx serving four files."
  type        = number
  default     = 128
}

variable "cpu_limit" {
  description = "CPU in mvCPU. 70 is what pairs with 128 MB."
  type        = number
  default     = 70
}

variable "min_scale" {
  description = "Instances kept warm. 0 = scale to zero (near-zero cost, ~1s cold start on the first request). 1 = always warm, which still fits the free tier on its own — see the note above."
  type        = number
  default     = 0
}

variable "max_scale" {
  description = "Upper bound on instances. One is enough for a personal site and caps the worst case if something hammers it."
  type        = number
  default     = 1
}
