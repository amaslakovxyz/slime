# --- GitHub Actions OIDC roles ----------------------------------------------
# CI authenticates with short-lived OIDC tokens; no AWS keys live in GitHub.
#
# The account-wide GitHub OIDC provider already exists and is OWNED by the
# ex-infra repository's Terraform. Read it here; never manage it from slime.
#
# Trust boundaries (the `sub` claim):
#   plan  <- <prefix>:pull_request          any PR in this repo, read-only
#   apply <- <prefix>:ref:refs/heads/main   only pushes/dispatches on main
# The repository uses GitHub's immutable subject, so <prefix> embeds owner and
# repo IDs (`repo:owner@<id>/name@<id>`), not just names. Read it with
# `gh api repos/<repo>/actions/oidc/customization/sub` (sub_claim_prefix).
# A name-based `repo:owner/name:...` subject would never match.
# PR workflows always get the `pull_request` subject, so PR code can never
# obtain the apply role. The apply job must NOT declare `environment:`, because
# that changes the subject to `repo:<repo>:environment:<name>`.

data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

locals {
  gha_subjects = {
    plan  = "${var.github_oidc_sub_prefix}:pull_request"
    apply = "${var.github_oidc_sub_prefix}:ref:refs/heads/main"
  }
}

data "aws_iam_policy_document" "gha_trust" {
  for_each = local.gha_subjects

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [each.value]
    }
  }
}

resource "aws_iam_role" "gha" {
  for_each = local.gha_subjects

  name                 = "${var.project}-gha-${each.key}"
  description          = "GitHub Actions Terraform ${each.key} for ${var.github_repository}"
  assume_role_policy   = data.aws_iam_policy_document.gha_trust[each.key].json
  max_session_duration = 3600
}

resource "aws_iam_role_policy" "gha_region_guard" {
  for_each = aws_iam_role.gha

  name   = "region-guard"
  role   = each.value.id
  policy = data.aws_iam_policy_document.region_guard.json
}

# Both CI roles: S3 and secret reads are limited to project-named resources.
# This keeps CI (and PR-triggered plans) away from other data in the account,
# e.g. the ex-infra state bucket. Stacks must name buckets `slime-*`, secrets
# `slime-*`, and SSM parameters `/slime/*`.
data "aws_iam_policy_document" "gha_project_scope" {
  statement {
    sid           = "DenyNonProjectS3"
    effect        = "Deny"
    actions       = ["s3:*"]
    not_resources = ["arn:aws:s3:::${var.project}-*", "arn:aws:s3:::${var.project}-*/*"]
  }

  statement {
    sid           = "DenyNonProjectSecrets"
    effect        = "Deny"
    actions       = ["secretsmanager:GetSecretValue"]
    not_resources = ["arn:aws:secretsmanager:*:*:secret:${var.project}-*"]
  }

  statement {
    sid           = "DenyNonProjectParameters"
    effect        = "Deny"
    actions       = ["ssm:GetParameter*"]
    not_resources = ["arn:aws:ssm:*:*:parameter/${var.project}/*"]
  }
}

# Foreign resources in the home region (ex-infra keeps a Lambda, an
# EventBridge rule and ACM certificates in eu-central-1): CI must not read
# their data (Lambda env vars, logs) or, for apply, change them. Name/tag
# fences only cover these known services; full isolation needs a separate
# AWS account.
locals {
  project_lambda_arns = [
    "arn:aws:lambda:*:*:function:${var.project}-*",
    "arn:aws:lambda:*:*:function:${var.project}-*:*",
  ]
}

data "aws_iam_policy_document" "gha_foreign_reads" {
  statement {
    sid           = "DenyForeignLambdaConfig"
    effect        = "Deny"
    actions       = ["lambda:GetFunction", "lambda:GetFunctionConfiguration"]
    not_resources = local.project_lambda_arns
  }

  statement {
    sid     = "DenyForeignLogData"
    effect  = "Deny"
    actions = ["logs:GetLogEvents", "logs:FilterLogEvents", "logs:StartQuery", "logs:StartLiveTail"]
    not_resources = [
      "arn:aws:logs:*:*:log-group:*${var.project}-*",
      "arn:aws:logs:*:*:log-group:*${var.project}-*:*",
    ]
  }
}

resource "aws_iam_role_policy" "gha_foreign_reads" {
  for_each = aws_iam_role.gha

  name   = "foreign-reads"
  role   = each.value.id
  policy = data.aws_iam_policy_document.gha_foreign_reads.json
}

resource "aws_iam_role_policy" "gha_project_scope" {
  for_each = aws_iam_role.gha

  name   = "project-scope"
  role   = each.value.id
  policy = data.aws_iam_policy_document.gha_project_scope.json
}

# --- plan: read-only + state lock ------------------------------------------

resource "aws_iam_role_policy_attachment" "gha_plan_readonly" {
  role       = aws_iam_role.gha["plan"].name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

data "aws_iam_policy_document" "gha_plan_state" {
  statement {
    sid       = "StateRead"
    actions   = ["s3:ListBucket", "s3:GetObject"]
    resources = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
  }

  # `terraform plan` takes the lock too: it writes and removes <key>.tflock.
  statement {
    sid       = "StateLock"
    actions   = ["s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.state.arn}/*.tflock"]
  }
}

resource "aws_iam_role_policy" "gha_plan_state" {
  name   = "state-access"
  role   = aws_iam_role.gha["plan"].id
  policy = data.aws_iam_policy_document.gha_plan_state.json
}

# --- apply: admin minus self-escalation -------------------------------------
# AdministratorAccess so stacks can create anything, fenced by explicit denies:
# IAM writes only on slime-* identities, never on the bootstrap-owned roles,
# the OIDC provider, or the state bucket's own configuration.

resource "aws_iam_role_policy_attachment" "gha_apply_admin" {
  role       = aws_iam_role.gha["apply"].name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}

locals {
  iam_write_actions = [
    "iam:Add*", "iam:Attach*", "iam:Create*", "iam:Delete*", "iam:Detach*",
    "iam:PassRole", "iam:Put*", "iam:Remove*", "iam:Set*", "iam:Tag*",
    "iam:Untag*", "iam:Update*", "iam:Upload*",
  ]
  account_arn = "arn:aws:iam::${data.aws_caller_identity.current.account_id}"
}

data "aws_iam_policy_document" "gha_apply_guard" {
  statement {
    sid     = "DenyIamOutsideProject"
    effect  = "Deny"
    actions = local.iam_write_actions
    not_resources = [
      "${local.account_arn}:role/${var.project}-*",
      "${local.account_arn}:policy/${var.project}-*",
      "${local.account_arn}:instance-profile/${var.project}-*",
      # Service-linked roles are created on first use of some services.
      "${local.account_arn}:role/aws-service-role/*",
    ]
  }

  statement {
    sid     = "DenyBootstrapIdentities"
    effect  = "Deny"
    actions = local.iam_write_actions
    resources = [
      aws_iam_role.deployer.arn,
      "${local.account_arn}:role/${var.project}-gha-*",
      "${local.account_arn}:oidc-provider/*",
    ]
  }

  statement {
    sid    = "DenyStateBucketConfig"
    effect = "Deny"
    actions = [
      "s3:DeleteBucket*", "s3:PutBucket*", "s3:PutLifecycleConfiguration",
      "s3:PutEncryptionConfiguration", "s3:PutReplicationConfiguration",
      "s3:DeleteObjectVersion",
    ]
    resources = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
  }

  statement {
    sid    = "DenyForeignLambdaChanges"
    effect = "Deny"
    actions = [
      "lambda:AddPermission", "lambda:DeleteFunction*", "lambda:InvokeFunction",
      "lambda:PutFunction*", "lambda:RemovePermission", "lambda:TagResource",
      "lambda:UntagResource", "lambda:UpdateFunction*",
    ]
    not_resources = local.project_lambda_arns
  }

  statement {
    sid    = "DenyForeignEventRuleChanges"
    effect = "Deny"
    actions = [
      "events:DeleteRule", "events:DisableRule", "events:EnableRule", "events:PutRule",
      "events:PutTargets", "events:RemoveTargets", "events:TagResource", "events:UntagResource",
    ]
    not_resources = [
      "arn:aws:events:*:*:rule/${var.project}-*",
      "arn:aws:events:*:*:rule/*/${var.project}-*",
    ]
  }

  # ACM ARNs are random IDs, so fence by tag. New certificates must be
  # requested with the Project tag (provider default_tags does this).
  statement {
    sid    = "DenyForeignCertificateChanges"
    effect = "Deny"
    actions = [
      "acm:AddTagsToCertificate", "acm:DeleteCertificate", "acm:ExportCertificate",
      "acm:ImportCertificate", "acm:RemoveTagsFromCertificate", "acm:UpdateCertificateOptions",
    ]
    resources = ["arn:aws:acm:*:*:certificate/*"]

    condition {
      test     = "StringNotEquals"
      variable = "aws:ResourceTag/Project"
      values   = [var.project]
    }
  }

  statement {
    sid       = "DenyBudgetChanges"
    effect    = "Deny"
    actions   = ["budgets:ModifyBudget", "budgets:DeleteBudget*"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "gha_apply_guard" {
  name   = "self-escalation-guard"
  role   = aws_iam_role.gha["apply"].id
  policy = data.aws_iam_policy_document.gha_apply_guard.json
}
