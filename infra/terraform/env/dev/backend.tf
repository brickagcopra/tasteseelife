# Terraform Cloud remote-state backend for the `dev` env (ADR-0001).
#
# Why TF Cloud and not Contabo Object Storage:
#   * Contabo Object Storage is S3-API compatible but does NOT provide a
#     DynamoDB-equivalent state-lock primitive, and the `s3` backend's
#     experimental `use_lockfile` mode is not yet a substitute for
#     production-grade locking.
#   * Terraform Cloud free tier covers our team size (≤ 5 users) and
#     gives us remote state, native locking, run history, and OIDC-based
#     federated credentials to providers — all at $0/mo. See ADR-0001
#     §Decision.
#
# Operator bootstrap (one-time, before first `terraform init`):
#   1. Create a Terraform Cloud organization named `tastesee` (or whatever
#      matches `local.tfc_organization` below).
#   2. Create a workspace named `tastesee-dev` in that org. Execution
#      mode: `remote` (default). Terraform version: pinned to match
#      `versions.tf`.
#   3. Configure variables in the workspace:
#        - `contabo_oauth2_client_id` (sensitive)
#        - `contabo_oauth2_client_secret` (sensitive)
#        - `contabo_oauth2_user` (sensitive — Contabo customer email)
#        - `contabo_oauth2_pass` (sensitive — Contabo API password)
#        - `cloudflare_api_token` (sensitive)
#      Plus any non-sensitive vars from `terraform.tfvars.example`.
#   4. Locally: `terraform login` to authenticate the CLI to TF Cloud,
#      then `cd infra/terraform/env/dev && terraform init`.
#
# Local override for offline work:
#   Setting the env var TF_CLI_ARGS_init="-backend=false" disables backend
#   initialization for `terraform validate` / `terraform fmt` use, useful
#   in CI where TF Cloud credentials aren't desired. See the bootstrap
#   README §"Validate without TF Cloud credentials".

terraform {
  cloud {
    organization = "tastesee"

    workspaces {
      name = "tastesee-dev"
    }
  }
}
