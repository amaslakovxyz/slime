terraform {
  required_version = ">= 1.10" # native S3 lockfile

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

  # Bucket is created by infra/aws/bootstrap (PR #8 / #10).
  backend "s3" {
    bucket       = "slime-tfstate-025772230981"
    key          = "landing/terraform.tfstate"
    region       = "eu-central-1"
    encrypt      = true
    use_lockfile = true
  }
}

# Credentials from the environment: AWS_PROFILE=slime locally.
provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = var.project
      ManagedBy = "terraform"
      Stack     = "aws-landing"
    }
  }
}
