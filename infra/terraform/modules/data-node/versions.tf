terraform {
  required_version = ">= 1.6.0, < 2.0.0"

  required_providers {
    contabo = {
      source = "contabo/contabo"
    }
    random = {
      source = "hashicorp/random"
    }
  }
}
