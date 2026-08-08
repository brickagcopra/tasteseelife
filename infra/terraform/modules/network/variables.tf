variable "env" {
  description = "Environment name (e.g. dev / staging / prod). Becomes a resource tag and a name prefix."
  type        = string

  validation {
    condition     = can(regex("^(dev|staging|prod)$", var.env))
    error_message = "env must be one of: dev, staging, prod."
  }
}

variable "region" {
  description = "Contabo region slug for the private VLAN. Currently the only Cloud-VPS US-Central region slug is 'US-central'; mirror this when staging / prod land."
  type        = string
  default     = "US-central"
}

variable "name" {
  description = "Display name for the private VLAN — visible in the Contabo control panel only."
  type        = string
  default     = "tastesee-vlan"
}

variable "cidr" {
  description = "RFC1918 CIDR block for the private VLAN. Must not collide with any peer cluster, the operator's Tailscale tailnet, or the k3s pod/service CIDRs (default 10.42.0.0/16 + 10.43.0.0/16). Default 10.40.0.0/24 stays clear of both."
  type        = string
  default     = "10.40.0.0/24"

  validation {
    condition     = can(cidrhost(var.cidr, 0))
    error_message = "cidr must be a valid CIDR block (e.g. 10.40.0.0/24)."
  }
}
