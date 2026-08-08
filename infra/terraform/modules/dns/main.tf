# Cloudflare DNS records for the canonical Taste & See surfaces.
#
# The Cloudflare zone (apex domain) must already exist; this module
# reads it as a data source and only manages records. This is
# deliberate — the zone is a registrar-bound resource that shouldn't
# be destroyed by a `terraform destroy` on this stack.
#
# Per-env naming:
#   dev      → api.dev.tasteseelife.com
#   staging  → api.staging.tasteseelife.com
#   prod     → api.tasteseelife.com       (bare, no env subdomain)
#
# Proxy behaviour:
#   * Proxied (orange-cloud): traffic routes through Cloudflare —
#     WAF, DDoS protection, CDN, automatic HTTPS. The cluster sees
#     Cloudflare's edge IPs, so x-forwarded-for is the source of
#     truth for client IP and ingress NGINX must trust the
#     Cloudflare-IP ranges.
#   * DNS-only (grey-cloud): direct A-record resolution. Suitable
#     for records that need to bypass the proxy (e.g. PROXY-protocol
#     ingress, gRPC bidi without HTTP/2 upgrade quirks). Default for
#     this module is proxied=true for every hostname.

data "cloudflare_zone" "this" {
  name = var.zone_name
}

locals {
  # Compose the hostname → FQDN map. For prod, drop the env segment.
  hostnames = {
    for name, proxied in var.hostnames :
    name => {
      fqdn    = var.env == "prod" ? "${name}.${var.zone_name}" : "${name}.${var.env}.${var.zone_name}"
      proxied = proxied
    }
  }

  # Cartesian product hostname × ingress IP — one A record per pair.
  records = flatten([
    for name, cfg in local.hostnames : [
      for ip in var.ingress_target_ips : {
        key     = "${name}-${replace(ip, ".", "_")}"
        name    = cfg.fqdn
        ip      = ip
        proxied = cfg.proxied
      }
    ]
  ])
}

resource "cloudflare_record" "ingress" {
  for_each = { for r in local.records : r.key => r }

  zone_id = data.cloudflare_zone.this.id
  name    = each.value.name
  type    = "A"
  content = each.value.ip
  ttl     = each.value.proxied ? 1 : var.ttl
  proxied = each.value.proxied

  comment = "Managed by Terraform — Taste & See ${var.env} (ADR-0001)"
}
