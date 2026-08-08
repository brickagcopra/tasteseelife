# `dev` env root — wires the four modules into a complete Phase 1 stack:
#   1. network         → private VLAN
#   2. object_storage  → Contabo Object Storage + buckets
#   3. data_node       → Postgres 16 + Redis 7 VPS (depends on network + object_storage)
#   4. k3s_cluster     → 3× control-plane + worker VPS (depends on network)
#   5. dns             → Cloudflare records pointing at k3s node IPs
#
# Apply order is implicit via output references. The first apply
# provisions ~30 minutes worth of work (Contabo instance creation +
# cloud-init bootstrap). See README §Post-apply verification for the
# operator's smoke-test runbook.

locals {
  env = "dev"
}

module "network" {
  source = "../../modules/network"

  env    = local.env
  region = var.region
}

module "object_storage" {
  source = "../../modules/object-storage"

  env                = local.env
  region             = var.region
  purchased_space_tb = var.object_storage_tb
}

module "data_node" {
  source = "../../modules/data-node"

  env                      = local.env
  region                   = var.region
  product_id               = var.data_node_product_id
  image_id                 = var.ubuntu_image_id
  ssh_public_key           = var.operator_ssh_public_key
  private_network_id       = module.network.private_network_id
  private_network_cidr     = module.network.cidr
  pgbackrest_repo_bucket   = module.object_storage.bucket_names["backups"]
  pgbackrest_repo_endpoint = module.object_storage.s3_endpoint
}

module "k3s_cluster" {
  source = "../../modules/k3s-cluster"

  env                  = local.env
  region               = var.region
  node_count           = var.k3s_node_count
  product_id           = var.k3s_product_id
  image_id             = var.ubuntu_image_id
  ssh_public_key       = var.operator_ssh_public_key
  private_network_id   = module.network.private_network_id
  private_network_cidr = module.network.cidr
  extra_node_labels = {
    "tastesee.io/env"    = local.env
    "tastesee.io/region" = var.region
  }
}

module "dns" {
  source = "../../modules/dns"

  env                = local.env
  zone_name          = var.zone_name
  ingress_target_ips = module.k3s_cluster.node_public_ips
}
