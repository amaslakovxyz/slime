# Slime application infrastructure, applied by GitHub Actions on merge to main.
#
# Naming contract enforced by the CI role policies (see bootstrap/github_oidc.tf):
#   IAM roles/policies/instance profiles -> slime-*
#   S3 buckets                           -> slime-*
#   Secrets Manager secrets              -> slime-*
#   SSM parameters                       -> /slime/*
# Anything else fails at plan or apply with an explicit deny.

data "aws_caller_identity" "current" {}

# Required on every role this stack creates: the CI apply role refuses to
# create or change a role without it (bootstrap/boundary.tf).
locals {
  workload_boundary_arn = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:policy/${var.project}-workload-boundary"
}
