terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Bootstrap layer keeps local state on purpose: it creates the identity that
  # every later stack (and any remote state backend) depends on. The path is
  # supplied at init time and lives OUTSIDE the repo, so removing a git
  # worktree cannot delete it. See README.md.
  backend "local" {}
}

provider "aws" {
  region  = var.region
  profile = var.bootstrap_profile

  default_tags {
    tags = local.tags
  }
}
