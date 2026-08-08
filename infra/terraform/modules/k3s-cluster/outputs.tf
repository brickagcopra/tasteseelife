output "node_ids" {
  description = "Contabo instance IDs for each cluster node, indexed 0..N-1."
  value       = contabo_instance.node[*].id
}

output "node_public_ips" {
  description = "Public IPv4 addresses of the cluster nodes — used by the operator for initial SSH + as kubeconfig --server targets when accessing the cluster from outside the VLAN."
  value       = contabo_instance.node[*].ip_config.v4.ip
}

output "node_display_names" {
  description = "Human-readable display names — useful for kubectl --context names and Grafana node-label correlation."
  value       = contabo_instance.node[*].display_name
}

output "cluster_token_sensitive" {
  description = "k3s shared join token. NEVER log or commit. Re-fetch from TF state on the rare occasion a fourth node is added manually."
  value       = random_password.cluster_token.result
  sensitive   = true
}
