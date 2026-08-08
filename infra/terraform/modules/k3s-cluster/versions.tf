terraform {
  required_version = ">= 1.6.0, < 2.0.0"

  required_providers {
    contabo = {
      source = "contabo/contabo"
    }
    tls = {
      source = "hashicorp/tls"
    }
    random = {
      source = "hashicorp/random"
    }
    local = {
      source = "hashicorp/local"
    }
  }
}
