output "registry_endpoint" {
  description = "Private registry namespace deploy.sh pushes to"
  value       = scaleway_registry_namespace.site.endpoint
}

output "image_tag" {
  description = "Content hash of the site files — the tag deploy.sh builds and pushes"
  value       = local.image_tag
}

output "image_ref" {
  description = "Full image reference. deploy.sh builds and pushes exactly this, then applies."
  value       = local.image_ref
}

output "container_cname" {
  description = "CNAME target for the custom domain — create <subdomain> IN CNAME <this> at your registrar"
  value       = local.container_host
}

output "default_url" {
  description = "Scaleway-provided endpoint, always works even without the custom domain"
  value       = "https://${local.container_host}"
}

output "site_url" {
  description = "Where the site is actually served"
  value       = var.custom_domain_enabled ? "https://${local.domain}" : "https://${local.container_host}"
}

output "maptiler_origin" {
  description = "Bare host to add to the MapTiler key's allowed origins, or tiles 403"
  value       = var.custom_domain_enabled ? local.domain : local.container_host
}
