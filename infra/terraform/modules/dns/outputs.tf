output "zone_id" {
  description = "Cloudflare zone ID — useful for the operator to cross-reference in the Cloudflare dashboard or to pass to sibling modules (e.g. a WAF-rules module)."
  value       = data.cloudflare_zone.this.id
}

output "hostnames" {
  description = "Map of logical hostname → fully-qualified DNS name. Consumed by other modules (e.g. the cert-manager Issuer manifest) and surfaced to the operator in env-level outputs."
  value       = { for name, cfg in local.hostnames : name => cfg.fqdn }
}
