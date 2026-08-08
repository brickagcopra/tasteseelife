variable "env" {
  description = "Environment name — propagated into display_name + Postgres role naming."
  type        = string

  validation {
    condition     = can(regex("^(dev|staging|prod)$", var.env))
    error_message = "env must be one of: dev, staging, prod."
  }
}

variable "region" {
  description = "Contabo region slug. Must match the k3s-cluster + private-network region."
  type        = string
  default     = "US-central"
}

variable "product_id" {
  description = "Contabo product ID. 'V47' is Cloud VPS L (8 vCPU / 30 GB / 800 GB NVMe). PDD §27 baseline for the data tier suggests ≥ 16 GB RAM dedicated to Postgres + Redis; the L tier comfortably covers Phase 1."
  type        = string
  default     = "V47"
}

variable "image_id" {
  description = "Contabo image UUID for Ubuntu 22.04 / 24.04 LTS. See https://api.contabo.com/v1/compute/images. Default placeholder MUST be overridden in tfvars."
  type        = string

  validation {
    condition     = length(var.image_id) > 0 && var.image_id != "<override-in-tfvars>"
    error_message = "image_id must be set to a real Contabo image UUID in tfvars."
  }
}

variable "ssh_public_key" {
  description = "OpenSSH-formatted operator public key. Same key as the k3s-cluster module — one operator account across all nodes."
  type        = string
  sensitive   = true
}

variable "private_network_id" {
  description = "Contabo private network ID from the `network` module — VLAN that connects the data node to the k3s cluster."
  type        = string
}

variable "private_network_cidr" {
  description = "Private VLAN CIDR — written into pg_hba.conf so cluster nodes can reach Postgres on the private interface only."
  type        = string
}

variable "postgres_version" {
  description = "PostgreSQL major version. CLAUDE.md §1 pins the platform to PostgreSQL 16."
  type        = string
  default     = "16"
}

variable "redis_version" {
  description = "Redis major version. CLAUDE.md §1 pins the platform to Redis 7."
  type        = string
  default     = "7"
}

variable "pgbackrest_repo_bucket" {
  description = "Name of the Contabo Object Storage bucket where pgBackRest stashes WAL + full + incremental backups. Created by the `object-storage` module; passed through here so cloud-init can render the pgBackRest config."
  type        = string
}

variable "pgbackrest_repo_endpoint" {
  description = "Contabo Object Storage S3-compatible endpoint URL (e.g. https://usc1.contabostorage.com)."
  type        = string
}
