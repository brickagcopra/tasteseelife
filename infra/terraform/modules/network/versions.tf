# Provider version constraints inherited from the root module.
# Child modules declare `required_providers` without source pins;
# root pins win at composition time.

terraform {
  required_version = ">= 1.6.0, < 2.0.0"

  required_providers {
    contabo = {
      source = "contabo/contabo"
    }
  }
}
