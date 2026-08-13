output "server_ip" {
  description = "Public IPv4 of the Overpass server — used by deploy.sh, and for the A record when manage_dns = false"
  value       = scaleway_instance_ip.overpass.address
}

output "overpass_domain" {
  description = "Hostname the Overpass API is served on"
  value       = local.domain
}

output "overpass_url" {
  description = "Full endpoint — paste this into SELF_HOSTED_OVERPASS in app.js"
  value       = "https://${local.domain}/api/interpreter"
}

output "allowed_origins" {
  description = "Origins permitted to read Overpass responses cross-site. Everything else gets the upstream's Access-Control-Allow-Origin stripped."
  value       = local.allowed_origins
}

output "caddyfile" {
  description = "Rendered Caddyfile — deploy.sh pushes this so the substitution lives in one place"
  value       = local.caddyfile
}

output "ssh_command" {
  description = "Shell command to get onto the server"
  value       = "ssh root@${scaleway_instance_ip.overpass.address}"
}
