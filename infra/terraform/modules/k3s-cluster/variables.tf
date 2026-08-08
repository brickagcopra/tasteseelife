variable "env" {
  description = "Environment name — propagated into display_name + Contabo tags + k3s --node-label."
  type        = string

  validation {
    condition     = can(regex("^(dev|staging|prod)$", var.env))
    error_message = "env must be one of: dev, staging, prod."
  }
}

variable "region" {
  description = "Contabo region slug. Must match the data-node and private-network region."
  type        = string
  default     = "US-central"
}

variable "node_count" {
  description = "Number of k3s server nodes. Must be odd to preserve etcd quorum (3 / 5). Phase 1 default: 3."
  type        = number
  default     = 3

  validation {
    condition     = var.node_count >= 3 && var.node_count % 2 == 1
    error_message = "node_count must be an odd number ≥ 3 to maintain etcd quorum."
  }
}

variable "product_id" {
  description = "Contabo product ID for the Cloud VPS tier. 'V47' is Cloud VPS L (8 vCPU / 30 GB / 800 GB NVMe) at the time of writing. Override in tfvars if Contabo renames the tier."
  type        = string
  default     = "V47"
}

variable "image_id" {
  description = "Contabo image UUID for the OS image. The Ubuntu 22.04 / 24.04 LTS image UUIDs are listed at https://api.contabo.com/v1/compute/images — pin per env. Default placeholder MUST be overridden in tfvars."
  type        = string

  validation {
    condition     = length(var.image_id) > 0 && var.image_id != "<override-in-tfvars>"
    error_message = "image_id must be set to a real Contabo image UUID in tfvars. See https://api.contabo.com/v1/compute/images."
  }
}

variable "k3s_version" {
  description = "k3s release channel or pinned version (e.g. 'v1.30.4+k3s1'). Pin a version, not 'stable', to keep upgrades intentional."
  type        = string
  default     = "v1.30.4+k3s1"
}

variable "ssh_public_key" {
  description = "OpenSSH-formatted public key authorised to log in as 'tastesee-ops' on every node. Operator generates this locally (or via Tailscale SSH); the private half NEVER lives in Terraform."
  type        = string
  sensitive   = true
}

variable "private_network_id" {
  description = "Contabo private network ID from the `network` module — VLAN that the cluster nodes + data node share."
  type        = string
}

variable "private_network_cidr" {
  description = "CIDR block of the private VLAN — passed into cloud-init so kubelet binds node-ip on the VLAN interface."
  type        = string
}

variable "cluster_domain" {
  description = "Internal cluster DNS suffix (default 'cluster.local' per Kubernetes convention)."
  type        = string
  default     = "cluster.local"
}

variable "extra_node_labels" {
  description = "Additional k3s --node-label entries applied to every cluster node, as a map. Useful for the NGINX-Ingress edge-node pinning (TS-150-followup) or for environment tagging."
  type        = map(string)
  default     = {}
}
