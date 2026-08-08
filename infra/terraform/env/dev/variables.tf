# Input variables for the `dev` env root.
# All sensitive variables are set in the Terraform Cloud workspace
# (see backend.tf operator bootstrap step 3) — NEVER in tfvars files
# that touch a developer's disk.

# ---------- Contabo credentials (workspace-sensitive, never in tfvars) ----------

variable "contabo_oauth2_client_id" {
  description = "Contabo OAuth2 client ID. Workspace-sensitive var in Terraform Cloud."
  type        = string
  sensitive   = true
}

variable "contabo_oauth2_client_secret" {
  description = "Contabo OAuth2 client secret. Workspace-sensitive var in Terraform Cloud."
  type        = string
  sensitive   = true
}

variable "contabo_oauth2_user" {
  description = "Contabo customer email used as the OAuth2 username. Workspace-sensitive var in Terraform Cloud."
  type        = string
  sensitive   = true
}

variable "contabo_oauth2_pass" {
  description = "Contabo customer API password (NOT the panel password). Workspace-sensitive var in Terraform Cloud."
  type        = string
  sensitive   = true
}

# ---------- Cloudflare ----------

variable "cloudflare_api_token" {
  description = "Cloudflare scoped API token with Zone:Read + DNS:Edit on the target zone only. Workspace-sensitive var in Terraform Cloud."
  type        = string
  sensitive   = true
}

variable "zone_name" {
  description = "Cloudflare apex domain hosting the dev env (e.g. tasteseelife.com). Operator-supplied via tfvars."
  type        = string
}

# ---------- Operator SSH key ----------

variable "operator_ssh_public_key" {
  description = "OpenSSH-formatted public key authorised to log in as 'tastesee-ops' on every Contabo node. The private half NEVER lives in Terraform."
  type        = string
  sensitive   = true
}

# ---------- Region + Contabo image / product IDs ----------

variable "region" {
  description = "Contabo region slug. Default 'US-central' per ADR-0001."
  type        = string
  default     = "US-central"
}

variable "ubuntu_image_id" {
  description = "Contabo image UUID for Ubuntu 22.04 / 24.04 LTS. Look up via `curl https://api.contabo.com/v1/compute/images` and pin in tfvars."
  type        = string
}

variable "k3s_product_id" {
  description = "Contabo product ID for the k3s cluster nodes. Default 'V47' = Cloud VPS L."
  type        = string
  default     = "V47"
}

variable "data_node_product_id" {
  description = "Contabo product ID for the data node. Default 'V47' = Cloud VPS L."
  type        = string
  default     = "V47"
}

# ---------- Sizing ----------

variable "k3s_node_count" {
  description = "Number of k3s server nodes. Phase 1 default: 3 (odd number for etcd quorum)."
  type        = number
  default     = 3
}

variable "object_storage_tb" {
  description = "Provisioned Contabo Object Storage capacity in TB. Phase 1 baseline: 1 TB."
  type        = number
  default     = 1
}
