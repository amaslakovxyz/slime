locals {
  tags = {
    Project   = var.project
    ManagedBy = "terraform"
    Stack     = "aws-bootstrap"
  }
}

# --- Deployer role -----------------------------------------------------------
# Day-to-day infra work assumes this role (CLI profile `slime`) instead of
# using the long-lived admin user keys directly.

data "aws_iam_policy_document" "deployer_trust" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]

    principals {
      type        = "AWS"
      identifiers = var.trusted_principal_arns
    }
  }
}

resource "aws_iam_role" "deployer" {
  name                 = "${var.project}-deployer"
  description          = "Infra deployer for ${var.project}; regional services locked to ${var.region}."
  assume_role_policy   = data.aws_iam_policy_document.deployer_trust.json
  max_session_duration = 43200
}

resource "aws_iam_role_policy_attachment" "deployer_admin" {
  role       = aws_iam_role.deployer.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}

# Region guard: deny every regional action outside var.region. Global services
# (IAM, STS, CloudFront, Route 53, billing, ...) are exempt because their API
# calls resolve to us-east-1. Pattern follows AWS's documented region-deny SCP.
data "aws_iam_policy_document" "region_guard" {
  statement {
    sid    = "DenyOutsideHomeRegion"
    effect = "Deny"
    not_actions = [
      "acm:*",
      "budgets:*",
      "ce:*",
      "cloudfront:*",
      "cur:*",
      "globalaccelerator:*",
      "health:*",
      "iam:*",
      "organizations:*",
      "pricing:*",
      "route53:*",
      "route53domains:*",
      "s3:GetAccountPublic*",
      "s3:ListAllMyBuckets",
      "s3:PutAccountPublic*",
      "shield:*",
      "sts:*",
      "support:*",
      "trustedadvisor:*",
      "waf:*",
      "wafv2:*",
    ]
    resources = ["*"]

    condition {
      test     = "StringNotEquals"
      variable = "aws:RequestedRegion"
      values   = [var.region]
    }
  }
}

resource "aws_iam_role_policy" "deployer_region_guard" {
  name   = "region-guard"
  role   = aws_iam_role.deployer.id
  policy = data.aws_iam_policy_document.region_guard.json
}

# --- Resource group ----------------------------------------------------------
# Console view of everything tagged Project=<project> in the home region.

resource "aws_resourcegroups_group" "project" {
  name = var.project
  # Description allows only [\sa-zA-Z0-9_.-]; no '=' or ':'.
  description = "All resources tagged Project ${var.project}"

  resource_query {
    query = jsonencode({
      ResourceTypeFilters = ["AWS::AllSupported"]
      TagFilters = [{
        Key    = "Project"
        Values = [var.project]
      }]
    })
  }
}

# --- Budget ------------------------------------------------------------------
# Account-wide on purpose: a tag-filtered budget only works after the Project
# cost-allocation tag is activated in Billing (possible ~24h after first use),
# and a hackathon guard rail must work from minute one.

resource "aws_budgets_budget" "monthly" {
  name         = "${var.project}-account-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.budget_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 50
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = var.budget_alert_emails
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = var.budget_alert_emails
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = var.budget_alert_emails
  }
}

# Project budget: tight limit on slime spend only. The account already
# carries unrelated spend (domain registration, Route 53, tax), so an
# account-wide $15 budget would breach on day one and never alert again that
# month.
#
# Filter, in order of preference:
#   - Project cost-allocation tag (var.project_cost_tag_active = true): exact,
#     includes global services such as CloudFront. AWS only lets the tag be
#     activated after it has appeared in billing data (~24h after first use).
#   - Region = var.region until then: region-guard keeps every regional slime
#     resource there; CloudFront ("global") is not counted, the account-wide
#     budget above still covers it.
# Budgets alert; the freeze action in finops.tf is what reacts at 100%.

resource "aws_budgets_budget" "project" {
  name         = "${var.project}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.project_budget_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = var.project_cost_tag_active ? "TagKeyValue" : "Region"
    values = var.project_cost_tag_active ? ["user:Project$${var.project}"] : [var.region]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = var.project_budget_alert_usd
    threshold_type             = "ABSOLUTE_VALUE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = var.budget_alert_emails
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = var.project_budget_limit_usd
    threshold_type             = "ABSOLUTE_VALUE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = var.budget_alert_emails
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = var.project_budget_limit_usd
    threshold_type             = "ABSOLUTE_VALUE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = var.budget_alert_emails
  }
}
