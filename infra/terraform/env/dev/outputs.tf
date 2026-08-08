# Operator-facing outputs after a successful apply.
#
# Sensitive outputs are flagged so `terraform output -raw <name>` is the
# only way to read them; `terraform output` (no name) suppresses them
# and `terraform output -json` masks them. CLAUDE.md §3.5 / §17.12.

output "k3s_node_public_ips" {
  description = "Public IPv4 addresses of the cluster nodes — used for initial SSH and as kubeconfig --server targets when accessing the cluster from outside the VLAN."
  value       = module.k3s_cluster.node_public_ips
}

output "k3s_node_display_names" {
  description = "Human-readable Contabo display names — useful for kubectl context naming and Grafana node-label correlation."
  value       = module.k3s_cluster.node_display_names
}

output "data_node_public_ip" {
  description = "Public IPv4 of the data node. SSH only — database services do NOT listen on this interface."
  value       = module.data_node.public_ip
}

output "object_storage_endpoint" {
  description = "S3-compatible endpoint URL for the env's Object Storage instance. Pass to media-svc + pgBackRest + workers."
  value       = module.object_storage.s3_endpoint
}

output "object_storage_buckets" {
  description = "Map of logical bucket name → fully-qualified bucket name."
  value       = module.object_storage.bucket_names
}

output "private_network_cidr" {
  description = "Private VLAN CIDR — useful for ops scripts that need to query the data node from inside the cluster."
  value       = module.network.cidr
}

output "dns_hostnames" {
  description = "Map of logical hostname (e.g. 'api') → fully-qualified DNS name (e.g. 'api.dev.tasteseelife.com')."
  value       = module.dns.hostnames
}

output "cluster_token" {
  description = "k3s cluster-join token. Sensitive — fetch via `terraform output -raw cluster_token` only when adding a node manually."
  value       = module.k3s_cluster.cluster_token_sensitive
  sensitive   = true
}
