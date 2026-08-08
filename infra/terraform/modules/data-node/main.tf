# Single Contabo Cloud VPS L dedicated to Postgres 16 + Redis 7.
#
# Why dedicated:
#   * A k3s upgrade or node reboot must never endanger the financial-
#     system-of-truth Postgres instance (CLAUDE.md §6). The data node
#     boots independently and isn't part of the cluster.
#   * Postgres + Redis benefit from steady-state NVMe + RAM and not
#     sharing with bursty service workloads.
#
# Phase 1 single-node failover posture:
#   * Continuous WAL archive via pgBackRest to Contabo Object Storage
#     (RPO < 15 min, the PDD §20.6 target).
#   * Restore drill documented in `infra/terraform/README.md`.
#   * Streaming replica + automatic failover (TS-150-followup) lands when
#     the dev env proves the single-node baseline.
#
# Application secrets are NOT baked into Terraform state:
#   * Postgres role passwords + pgBackRest S3 keys + Redis requirepass
#     are all left as `<FILL_IN_OPERATOR>` placeholders in cloud-init.
#   * The operator fills them in over SSH after first boot. See
#     README §First-boot data-node bootstrap.

# Pre-compute the grep-friendly IP prefix from the VLAN CIDR. Mirrors
# the k3s-cluster module's local; kept independent so the data-node
# module has no module-to-module dependency beyond the variables.
locals {
  vlan_network_address = cidrhost(var.private_network_cidr, 0)
  private_network_ip_prefix = format(
    "%s.",
    join(".", slice(split(".", local.vlan_network_address), 0, 3))
  )
}

resource "contabo_instance" "data" {
  display_name = "${var.env}-data"
  product_id   = var.product_id
  region       = var.region
  image_id     = var.image_id

  add_ons {
    # Contabo Private Networking add-on. See k3s-cluster/main.tf for
    # the rationale on the magic ID.
    id       = "1477"
    quantity = 1
  }

  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    env                       = var.env
    ssh_public_key            = var.ssh_public_key
    postgres_version          = var.postgres_version
    redis_version             = var.redis_version
    private_network_cidr      = var.private_network_cidr
    private_network_ip_prefix = local.private_network_ip_prefix
    pgbackrest_repo_bucket    = var.pgbackrest_repo_bucket
    pgbackrest_repo_endpoint  = var.pgbackrest_repo_endpoint
  })
}
