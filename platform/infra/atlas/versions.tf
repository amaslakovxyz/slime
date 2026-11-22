terraform {
  required_version = ">= 1.11" # use_lockfile is GA from 1.11 (experimental in 1.10)

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.7"
    }
  }

  # Bucket is created by platform/infra/bootstrap.
  backend "s3" {
    bucket       = "slime-tfstate-025772230981"
    key          = "atlas/terraform.tfstate"
    region       = "eu-central-1"
    encrypt      = true
    use_lockfile = true
  }
}

# Credentials from the environment: AWS_PROFILE=slime locally.
locals {
  tags = {
    Project   = var.project
    ManagedBy = "terraform"
    Stack     = "aws-atlas"
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = local.tags
  }
}
