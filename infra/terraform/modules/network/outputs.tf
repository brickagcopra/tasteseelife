output "private_network_id" {
  description = "Contabo private network ID — consumed by the k3s-cluster and data-node modules to attach VPSes to the VLAN."
  value       = contabo_private_network.this.id
}

output "cidr" {
  description = "CIDR block for the private VLAN. Consumers use this to populate kubelet --node-ip ranges, Postgres pg_hba.conf entries, and firewall allow-rules for inter-node traffic."
  value       = contabo_private_network.this.cidr
}

output "region" {
  description = "Region the VLAN lives in — pass through to the VPS modules so they pin to the same region."
  value       = contabo_private_network.this.region
}
