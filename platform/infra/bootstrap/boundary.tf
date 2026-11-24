# --- Workload permissions boundary ---------------------------------------------
#
# Closes the escalation path through roles that CI creates. slime-gha-apply is
# AdministratorAccess minus explicit denies, and denies do not follow a role it
# creates: without a boundary, a commit on main could create role slime-x with
# ssm:GetParameter on /ex-infra/*, put it on Lambda slime-y and read another
# project's secrets (e.g. the Telegram bot token behind account alerting).
#
#   gha-apply guard (github_oidc.tf)  every role CI creates or changes must
#                                     carry this boundary; CI may not remove it
#                                     or edit this policy
#   this boundary                     caps any such role at: the same project
#                                     fences as the CI roles, no IAM writes,
#                                     no sts:AssumeRole into other roles
#
# Effective permissions of a bounded role = its own policies AND this boundary,
# so the workloads keep exactly what their policies grant inside slime-*.
# Owned here (bootstrap, human-applied): CI must never be able to edit it.

locals {
  workload_boundary_name = "${var.project}-workload-boundary"
  # Built from the name: the gha-apply guard references it, and a reference to
  # the resource would tie the guard's apply to the policy's creation order.
  workload_boundary_arn = "${local.account_arn}:policy/${local.workload_boundary_name}"
}

data "aws_iam_policy_document" "workload_boundary" {
  # The CI fences apply to bounded roles too: foreign S3, secrets, SSM
  # parameters, Lambda config, logs, tables, queues, streams, images, and every
  # foreign-resource change the apply guard denies.
  source_policy_documents = [
    data.aws_iam_policy_document.gha_project_scope.json,
    data.aws_iam_policy_document.gha_foreign_reads.json,
    data.aws_iam_policy_document.gha_foreign_changes.json,
  ]

  statement {
    sid       = "AllowWithinFences"
    effect    = "Allow"
    actions   = ["*"]
    resources = ["*"]
  }

  # Workloads never manage IAM; this also stops a bounded role from minting an
  # unbounded one.
  statement {
    sid       = "DenyIamWrites"
    effect    = "Deny"
    actions   = local.iam_write_actions
    resources = ["*"]
  }

  # Roles that trust the account root accept any principal with this
  # permission; workloads have no reason to switch identity.
  statement {
    sid       = "DenyRoleSwitch"
    effect    = "Deny"
    actions   = ["sts:AssumeRole", "sts:AssumeRoleWithWebIdentity", "sts:AssumeRoleWithSAML"]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "workload_boundary" {
  name        = local.workload_boundary_name
  description = "Permissions boundary for every role ${var.project} CI creates; owned by bootstrap."
  policy      = data.aws_iam_policy_document.workload_boundary.json
}
