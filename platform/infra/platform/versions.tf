terraform {
  required_version = ">= 1.10" # native S3 lockfile

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0" # invoked_via_function_url on aws_lambda_permission
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.7"
    }
  }

  backend "s3" {
    bucket       = "slime-tfstate-025772230981"
    key          = "platform/terraform.tfstate"
    region       = "eu-central-1"
    encrypt      = true
    use_lockfile = true
  }
}

# Credentials come from the environment: OIDC roles in CI
# (slime-gha-plan / slime-gha-apply), AWS_PROFILE=slime locally.
provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = var.project
      ManagedBy = "terraform"
      Stack     = "aws-platform"
    }
  }
}

# Same account and region, no default_tags: for resources whose tag-on-create
# the CI apply role may not perform (the provisioner's event source mapping).
provider "aws" {
  alias  = "untagged"
  region = var.region
}
