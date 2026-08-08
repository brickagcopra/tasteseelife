variable "env" {
  description = "Environment name — controls the subdomain prefix (dev / staging) or its absence (prod uses the bare hostname)."
  type        = string

  validation {
    condition     = can(regex("^(dev|staging|prod)$", var.env))
    error_message = "env must be one of: dev, staging, prod."
  }
}

variable "zone_name" {
  description = "Cloudflare zone (apex domain) that hosts Taste & See records. The zone must already exist in Cloudflare; this module reads it as a data source and only manages records."
  type        = string
}

variable "ingress_target_ips" {
  description = "Public IPv4 addresses of the cluster nodes that NGINX Ingress is pinned to. Each canonical hostname becomes an A record per IP for simple DNS-round-robin failover. For Phase 1, a single IP is acceptable; multi-IP unlocks low-cost failover without a dedicated LB."
  type        = list(string)

  validation {
    condition     = length(var.ingress_target_ips) >= 1
    error_message = "ingress_target_ips must contain at least one IP."
  }
}

variable "hostnames" {
  description = "Logical hostname → proxy-flag map. The hostname becomes `${name}.${env}.${zone_name}` for non-prod and `${name}.${zone_name}` for prod. proxied=true routes through Cloudflare (WAF + DDoS + CDN); false uses Cloudflare as DNS-only."
  type        = map(bool)
  default = {
    api      = true
    admin    = true
    academy  = true
    family   = true
    provider = true
    partner  = true
    grafana  = true
  }
}

variable "ttl" {
  description = "TTL for DNS records when not proxied. Cloudflare ignores TTL on proxied records (sets it to 1, 'Automatic')."
  type        = number
  default     = 300
}
