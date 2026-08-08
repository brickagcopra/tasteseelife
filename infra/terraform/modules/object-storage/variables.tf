variable "env" {
  description = "Environment name — propagated into the Object Storage instance display name and bucket-name prefix."
  type        = string

  validation {
    condition     = can(regex("^(dev|staging|prod)$", var.env))
    error_message = "env must be one of: dev, staging, prod."
  }
}

variable "region" {
  description = "Contabo Object Storage region. 'EU' (Nuremberg) and 'US-central' (St. Louis) and 'US-east' (New York) are the main slugs at the time of writing. Mirror the VPS region for low-latency reads from the cluster + data node."
  type        = string
  default     = "US-central"
}

variable "purchased_space_tb" {
  description = "Provisioned Object Storage capacity in TB. Contabo charges per provisioned TB, not per used GB. Phase 1 baseline of 1 TB covers media uploads + WAL archive + etcd snapshots through Year 1 of the PDD §27 capacity plan."
  type        = number
  default     = 1

  validation {
    condition     = var.purchased_space_tb >= 1
    error_message = "purchased_space_tb must be ≥ 1 (Contabo's minimum)."
  }
}

variable "buckets" {
  description = "Logical bucket names to create. Names are prefixed with `${env}-` to guarantee env isolation. Default set covers the Phase 1 surfaces (media uploads, postgres backups, etcd snapshots, generic terraform artifacts)."
  type        = list(string)
  default     = ["media", "backups", "etcd-snapshots", "tf-artifacts"]
}
