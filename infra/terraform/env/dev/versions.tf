# Terraform + provider version pins for the Taste & See `dev` env root.
#
# Pinning strategy: minor-version pessimistic constraints (`~>`) per
# CLAUDE.md §13 (approved-libraries discipline applied to providers).
# The Terraform CLI floor is set so `terraform init` rejects older CLIs
# that lack the features used in this tree (cloud backend with workspace
# tags, optional object attributes, embedded test framework).
#
# Mirror this file to `env/staging/` and `env/prod/` when those envs land
# (TS-150-followup).

terraform {
  required_version = ">= 1.6.0, < 2.0.0"

  required_providers {
    # Official Contabo provider — VPS / Object Storage / private networking.
    # https://registry.terraform.io/providers/contabo/contabo
    contabo = {
      source  = "contabo/contabo"
      version = "~> 0.1"
    }

    # DNS + edge (Cloudflare free tier per ADR-0001).
    # https://registry.terraform.io/providers/cloudflare/cloudflare
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.49"
    }

    # SSH keypair generation for the operator + cluster nodes.
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }

    # Cluster-join token + Postgres replication password generation.
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }

    # Operator-facing kubeconfig / pgBackRest config file outputs (sensitive,
    # never committed — see root .gitignore).
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
  }
}
