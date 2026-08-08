# Private VLAN that connects the k3s cluster nodes to the data node.
#
# Why a private VLAN:
#   * Postgres + Redis listen on private IPs only — never on the public
#     interface. Public-side firewall on each node closes 5432 / 6379.
#   * Inter-cluster traffic (k3s flannel VXLAN, etcd peer, kubelet) stays
#     off the public Internet, lowering egress cost and removing a wide
#     attack surface.
#   * The Cloudflare-fronted ingress (NGINX) is the only path from the
#     public Internet to anything in the cluster.
#
# Contabo provider resource: `contabo_private_network` is currently
# available only on Cloud-VPS-tier instances (not legacy VPS). All four
# of our nodes are Cloud VPS L, so this is fine.

resource "contabo_private_network" "this" {
  name        = "${var.env}-${var.name}"
  region      = var.region
  description = "Taste & See ${var.env} private VLAN — k3s + data node interconnect (ADR-0001)"
  cidr        = var.cidr
}

# Module-level firewall rule conventions are documented but not
# materialised here — Contabo's firewall API is per-instance, not per-
# VLAN, so each consuming module (k3s-cluster, data-node) attaches its
# own rules. See the README for the canonical rule set.
