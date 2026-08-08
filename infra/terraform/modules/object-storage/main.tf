# Contabo Object Storage — S3-compatible bucket service consumed by:
#   * media-svc (signed-URL uploads for senior / provider photos, certs)
#   * pgBackRest (Postgres WAL + full backups from the data node)
#   * k3s etcd snapshot job (cluster-state DR)
#   * Generic operator artifacts (kubeconfig backup, manifest dumps)
#
# Bucket naming convention: `${env}-${logical-name}` — ensures dev /
# staging / prod can never overwrite each other if a credential leaks
# across env boundaries. CLAUDE.md §17.11.

resource "contabo_object_storage" "this" {
  region                   = var.region
  total_purchased_space_tb = var.purchased_space_tb
  display_name             = "${var.env}-tastesee-storage"
}

resource "contabo_object_storage_bucket" "buckets" {
  for_each = toset(var.buckets)

  object_storage_id = contabo_object_storage.this.id
  name              = "${var.env}-${each.value}"
}
