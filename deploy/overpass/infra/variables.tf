variable "app_name" {
  description = "Base name used for all resources"
  type        = string
  default     = "mtbrrrr-overpass"
}

variable "project_id" {
  description = "Scaleway project ID (console → project settings). Use a project of its own for mtbrrrr."
  type        = string
}

variable "region" {
  description = "Scaleway region"
  type        = string
  default     = "fr-par"
}

variable "zone" {
  description = "Scaleway zone"
  type        = string
  default     = "fr-par-1"
}

# ── DNS ────────────────────────────────────────────────────────────────────────

variable "dns_zone" {
  description = "Your domain, e.g. example.com. Only used to build the hostname unless manage_dns is true."
  type        = string
}

variable "subdomain" {
  description = "Subdomain for the Overpass endpoint"
  type        = string
  default     = "overpass"
}

variable "site_subdomain" {
  description = "Subdomain the mtbrrrr web app is served on, in this same dns_zone. Only used to build the CORS allow-list — keep it in step with deploy/site's subdomain."
  type        = string
  default     = "mtb"
}

variable "extra_allowed_origins" {
  description = "Further origins allowed to read Overpass responses, as full origins with scheme and port. The default keeps the local dev server working; drop it to allow only the deployed site."
  type        = list(string)
  default     = ["http://localhost:8000"]
}

variable "manage_dns" {
  description = "Create the A record in Scaleway DNS. Only works if the zone is delegated to Scaleway — leave false when DNS lives at your registrar and add the record there from the server_ip output."
  type        = bool
  default     = false
}

# ── Instance ───────────────────────────────────────────────────────────────────

variable "instance_type" {
  description = "Scaleway instance type; needs >= 2 vCPU / >= 4 GB and Block storage support. Sized for SERVING (PLAY2-NANO, 2 vCPU / 4 GB), which is trivial work. The INITIAL IMPORT is far heavier and may need more machine — if it crawls or gets OOM-killed, apply with a bigger type, then drop back once the endpoint serves 200. Safe in both directions: the DB is on its own volume, so resizing never re-imports. See INFRA.md."
  type        = string
  default     = "PLAY2-NANO"
}

variable "volume_size_gb" {
  description = "Block Storage size for the Overpass DB. Norway is ~10-20 GB without meta; the rest is headroom for diffs."
  type        = number
  default     = 50
}

# ── Access ─────────────────────────────────────────────────────────────────────

variable "ssh_allowed_ip" {
  description = "CIDR allowed to reach port 22. Narrow this to your own address if you can."
  type        = string
  default     = "0.0.0.0/0"
}

variable "ssh_public_key" {
  description = "SSH public key to register in the project. Scaleway only injects keys that exist in *this* project, and only at boot — a fresh project has none, so leaving this null on a new project means you cannot SSH in, and fixing it later needs an instance replacement. Leave null only if the project already has your key."
  type        = string
  default     = null
}
