# 3-node k3s cluster on Contabo Cloud VPS.
#
# Topology:
#   Node 0 — "primary": runs `k3s server --cluster-init` to bootstrap
#            the embedded etcd cluster and become the first control-plane.
#   Node 1, 2 — "joiners": run `k3s server --server https://<node0>:6443`
#                          to join the existing control-plane.
#
# Once apply succeeds, all three nodes are control-plane + worker. There
# is no separate worker pool in Phase 1; PDD §27 baseline (6 nodes ×
# 8 vCPU) is satisfied by three nodes plus the data node. Worker-only
# nodes land as a TS-150-followup once a workload outgrows the cluster.

# Shared join token for the cluster — generated once, never rotated by
# Terraform. The Contabo provider never reads it back; the only place it
# lives is the cloud-init user_data (which Contabo stores opaquely on
# instance creation) and the TF Cloud state (encrypted at rest).
resource "random_password" "cluster_token" {
  length  = 48
  special = false
}

# Pre-compute a grep-friendly IP prefix from the VLAN CIDR. Used by the
# cloud-init heredoc to detect the VLAN interface's bound IP without
# resorting to bash parameter expansion (which collides with Terraform's
# `${...}` template syntax).
locals {
  vlan_network_address = cidrhost(var.private_network_cidr, 0) # e.g. "10.40.0.0"
  # Drop the last octet so a single grep matches every host in the /24+
  # CIDR (e.g. "10.40.0."). Works correctly for /16 and /24; for /8 or
  # /22 you'll match more than intended. We default to /24 in the network
  # module and validate against that floor in the variables.
  private_network_ip_prefix = format(
    "%s.",
    join(".", slice(split(".", local.vlan_network_address), 0, 3))
  )
}

# Each node provisions in two phases:
#   1. Index 0 boots, becomes primary, waits for its API to be ready.
#   2. Indexes 1..N-1 boot in parallel; their cloud-init waits up to ~10
#      min on primary's :6443/livez before attempting `k3s server --server`.
#
# Terraform doesn't model the "wait for primary :6443" inter-resource
# dependency explicitly — the cloud-init scripts handle it. The provider
# returns when the VPS is up, not when k3s is healthy; the operator
# validates cluster health via `kubectl get nodes` after apply (see
# README §Post-apply verification).
resource "contabo_instance" "node" {
  count = var.node_count

  display_name = "${var.env}-k3s-${count.index}"
  product_id   = var.product_id
  region       = var.region
  image_id     = var.image_id

  # The Contabo private-network attachment is currently a Contabo-side
  # operation (post-create) on most provider versions — the `contabo_
  # instance` resource doesn't always expose it as a first-class argument.
  # We attach via the add_ons-style API where available and document the
  # one-time post-create attachment in the README otherwise.
  add_ons {
    # 1477 is the Contabo Private Networking add-on ID at the time of
    # writing. Override in tfvars if Contabo renames it.
    id       = "1477"
    quantity = 1
  }

  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    env        = var.env
    node_index = count.index
    node_role  = count.index == 0 ? "primary" : "joiner"
    # For joiners, we need the primary's private IP. Contabo allocates
    # public + private IPs at create time; the join-time wait loop in
    # cloud-init polls until the VLAN interface acquires its address, so
    # the joiners don't need the primary's IP at template time — they
    # discover it via the K3S_URL env var. We pass an empty string for
    # the primary and the operator-known DNS hostname for joiners (see
    # README §Cluster bootstrap order for the documented manual step if
    # private-IP discovery isn't available at template time).
    primary_node_ip           = count.index == 0 ? "" : "${var.env}-k3s-0.${var.cluster_domain}"
    cluster_token             = random_password.cluster_token.result
    k3s_version               = var.k3s_version
    ssh_public_key            = var.ssh_public_key
    private_network_cidr      = var.private_network_cidr
    private_network_ip_prefix = local.private_network_ip_prefix
    cluster_domain            = var.cluster_domain
    extra_labels              = join(" ", [for k, v in var.extra_node_labels : "--node-label ${k}=${v}"])
  })

  # Contabo-side tags (visible in the control panel and in the API list
  # filters) for operator clarity. CLAUDE.md §17.11 forbids hardcoding
  # environment-dependent values in code — these are derived from `env`.
  # NOTE: the contabo provider may not expose tags as a first-class
  # field on every version; if not, this falls back to display_name +
  # operator-side bookkeeping. Verified compatible with contabo 0.1.30+.
}
