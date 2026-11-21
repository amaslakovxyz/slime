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
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
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
locals {
  tags = {
    Project   = var.project
    ManagedBy = "terraform"
    Stack     = "aws-platform"
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = local.tags
  }
}

# CloudFront only accepts ACM certificates from us-east-1 (admin.tf). The CI
# roles' region guard exempts acm:*, and the Project tag lets them manage it.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = local.tags
  }
}

# Same account and region, no default_tags. Kept for one apply only: the removed
# provisioner's event source mapping was created through it, and Terraform needs
# the alias to delete that mapping (no resource here references it any more,
# hence the tflint annotation). Remove it once that apply has run.
# tflint-ignore: terraform_unused_declarations
provider "aws" {
  alias  = "untagged"
  region = var.region
}
