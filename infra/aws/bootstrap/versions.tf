terraform {
  required_version = ">= 1.11" # use_lockfile is GA from 1.11; 1.9 cannot init this backend

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # This stack creates the state bucket it is stored in. It was first applied
  # with local state and then migrated (`terraform init -migrate-state`).
  # Locking: native S3 lockfile, no DynamoDB. Applied by a human only; CI
  # never applies bootstrap because it owns the CI roles themselves.
  backend "s3" {
    bucket       = "slime-tfstate-025772230981"
    key          = "bootstrap/terraform.tfstate"
    region       = "eu-central-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region  = var.region
  profile = var.bootstrap_profile

  default_tags {
    tags = local.tags
  }
}
