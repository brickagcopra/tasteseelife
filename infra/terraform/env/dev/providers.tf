# Provider configuration for the `dev` env.
#
# Credentials are NEVER passed via tfvars or environment variables in
# this file — they come from the Terraform Cloud workspace's sensitive
# variables (see `backend.tf` operator bootstrap step 3). The locals
# below name the workspace-var keys that must be set.
#
# CLAUDE.md §3.5 / §17.12 — no secrets in code, env files, or commits.

provider "contabo" {
  # Contabo's OAuth2 flow needs client credentials AND a customer user/pass.
  # All four are workspace-sensitive vars in Terraform Cloud.
  oauth2_client_id     = var.contabo_oauth2_client_id
  oauth2_client_secret = var.contabo_oauth2_client_secret
  oauth2_user          = var.contabo_oauth2_user
  oauth2_pass          = var.contabo_oauth2_pass
}

provider "cloudflare" {
  # Scoped API token (not the legacy global key). Token permissions
  # required: Zone:Read, DNS:Edit on the target zone only — see
  # `infra/terraform/README.md` § Cloudflare scoped-token recipe.
  api_token = var.cloudflare_api_token
}

provider "tls" {}
provider "random" {}
provider "local" {}
