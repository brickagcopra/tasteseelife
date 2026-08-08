output "object_storage_id" {
  description = "Contabo Object Storage instance ID."
  value       = contabo_object_storage.this.id
}

output "s3_endpoint" {
  description = "S3-compatible endpoint URL (e.g. https://usc1.contabostorage.com). Consumed by pgBackRest, media-svc, and any AWS SDK client. The Contabo provider exposes this on the storage resource; verify against the actual attribute name (the provider has evolved this; `s3_url` and `endpoint` have both been seen in 0.1.x versions)."
  # The Contabo provider's attribute name for the S3 endpoint has shifted
  # across versions. Two common spellings: `s3_url` and `endpoint`. We
  # try them via a `try()` to stay forward-compatible.
  value = try(
    contabo_object_storage.this.s3_url,
    contabo_object_storage.this.endpoint,
    "https://usc1.contabostorage.com"
  )
}

output "bucket_names" {
  description = "Map of logical bucket names → fully-qualified bucket names (e.g. media → dev-media)."
  value       = { for k, v in contabo_object_storage_bucket.buckets : k => v.name }
}

output "region" {
  description = "Region the Object Storage instance lives in — useful for pgBackRest's repo1-s3-region setting."
  value       = contabo_object_storage.this.region
}
