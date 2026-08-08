output "instance_id" {
  description = "Contabo instance ID for the data node."
  value       = contabo_instance.data.id
}

output "public_ip" {
  description = "Public IPv4 address of the data node. Used only for initial operator SSH; database services do NOT listen on this interface."
  value       = contabo_instance.data.ip_config.v4.ip
}

output "display_name" {
  description = "Human-readable display name — useful for Grafana node-label correlation."
  value       = contabo_instance.data.display_name
}
