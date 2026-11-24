# --- FinOps guard rails -------------------------------------------------------
#
#   budget slime-monthly hits 100% ACTUAL
#     -> AWS Budgets attaches slime-budget-freeze to slime-deployer and
#        slime-gha-apply (automatic, no approval)
#     -> both roles can no longer create new paid resources; reading,
#        updating code and DELETING still work, so spend can be cut
#   cost anomaly with impact >= var.anomaly_alert_usd -> daily email, and
#     immediately to SNS ops-alerts (Telegram)
#   every budget alert and the freeze also go to ops-alerts
#
# The freeze does not stop already-running resources (e.g. a Lambda being
# invoked). It stops the deploy path from growing the bill further.
# Undo after review (admin profile):
#   aws budgets describe-budget-actions-for-budget --account-id <id> --budget-name slime-monthly
#   aws budgets execute-budget-action --account-id <id> --budget-name slime-monthly \
#     --action-id <id> --execution-type REVERSE_BUDGET_ACTION

# Activation is only accepted once AWS has seen the tag in billing data.
resource "aws_ce_cost_allocation_tag" "project" {
  count = var.project_cost_tag_active ? 1 : 0

  tag_key = "Project"
  status  = "Active"
}

# --- Freeze policy -------------------------------------------------------------

data "aws_iam_policy_document" "budget_freeze" {
  statement {
    sid    = "DenyNewPaidResources"
    effect = "Deny"
    actions = [
      # compute
      "ec2:RunInstances", "ec2:CreateNatGateway", "ec2:AllocateAddress",
      "ec2:CreateVolume", "ec2:CreateVpcEndpoint", "ec2:Purchase*",
      "ecs:CreateService", "ecs:RunTask", "ecs:UpdateService",
      "eks:CreateCluster", "eks:CreateNodegroup",
      "lambda:CreateFunction", "lambda:PutProvisionedConcurrencyConfig",
      "elasticloadbalancing:CreateLoadBalancer",
      # data
      "rds:CreateDB*", "rds:RestoreDB*", "rds:ModifyDB*",
      "dynamodb:CreateTable", "dynamodb:UpdateTable", "dynamodb:RestoreTable*",
      "elasticache:Create*", "es:CreateDomain", "redshift:CreateCluster",
      "kinesis:CreateStream",
      # edge / network
      "cloudfront:CreateDistribution*", "globalaccelerator:Create*",
      "wafv2:CreateWebACL", "route53:CreateHostedZone",
      "route53domains:RegisterDomain", "route53domains:TransferDomain",
      # ML and commitments
      "sagemaker:Create*", "bedrock:CreateProvisionedModelThroughput",
      "savingsplans:CreateSavingsPlan",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "budget_freeze" {
  name        = "${var.project}-budget-freeze"
  description = "Attached by AWS Budgets when ${var.project}-monthly hits 100%: blocks new paid resources."
  policy      = data.aws_iam_policy_document.budget_freeze.json
}

# --- Role AWS Budgets uses to attach/detach the freeze policy -----------------

data "aws_iam_policy_document" "budgets_action_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["budgets.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_iam_role" "budgets_action" {
  name               = "${var.project}-budgets-action"
  description        = "Lets AWS Budgets attach ${var.project}-budget-freeze to the deploy roles."
  assume_role_policy = data.aws_iam_policy_document.budgets_action_trust.json
}

locals {
  freeze_target_roles = [aws_iam_role.deployer, aws_iam_role.gha["apply"]]
}

data "aws_iam_policy_document" "budgets_action" {
  statement {
    actions   = ["iam:AttachRolePolicy", "iam:DetachRolePolicy"]
    resources = [for r in local.freeze_target_roles : r.arn]

    condition {
      test     = "ArnEquals"
      variable = "iam:PolicyARN"
      values   = [aws_iam_policy.budget_freeze.arn]
    }
  }
}

resource "aws_iam_role_policy" "budgets_action" {
  name   = "attach-freeze"
  role   = aws_iam_role.budgets_action.id
  policy = data.aws_iam_policy_document.budgets_action.json
}

resource "aws_budgets_budget_action" "freeze" {
  budget_name        = aws_budgets_budget.project.name
  action_type        = "APPLY_IAM_POLICY"
  approval_model     = "AUTOMATIC"
  notification_type  = "ACTUAL"
  execution_role_arn = aws_iam_role.budgets_action.arn

  action_threshold {
    action_threshold_type  = "PERCENTAGE"
    action_threshold_value = 100
  }

  definition {
    iam_action_definition {
      policy_arn = aws_iam_policy.budget_freeze.arn
      roles      = [for r in local.freeze_target_roles : r.name]
    }
  }

  dynamic "subscriber" {
    for_each = toset(var.budget_alert_emails)
    content {
      address           = subscriber.value
      subscription_type = "EMAIL"
    }
  }

  subscriber {
    address           = local.alerts_topic_arn
    subscription_type = "SNS"
  }

  depends_on = [aws_iam_role_policy.budgets_action]
}

# --- Cost Anomaly Detection (free) ---------------------------------------------
# Account-wide on purpose: a runaway resource is worth an email no matter
# which project owns it. AWS allows one SERVICE-dimension monitor per account.

resource "aws_ce_anomaly_monitor" "services" {
  name              = "account-services"
  monitor_type      = "DIMENSIONAL"
  monitor_dimension = "SERVICE"
}

resource "aws_ce_anomaly_subscription" "services" {
  name             = "account-services-daily"
  frequency        = "DAILY"
  monitor_arn_list = [aws_ce_anomaly_monitor.services.arn]

  dynamic "subscriber" {
    for_each = toset(var.budget_alert_emails)
    content {
      type    = "EMAIL"
      address = subscriber.value
    }
  }

  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
      match_options = ["GREATER_THAN_OR_EQUAL"]
      values        = [tostring(var.anomaly_alert_usd)]
    }
  }
}

# Same monitor and threshold, pushed as soon as an anomaly is detected: SNS
# subscribers require IMMEDIATE, email subscribers DAILY or WEEKLY, so the
# daily email digest above stays as it is.
resource "aws_ce_anomaly_subscription" "services_immediate" {
  name             = "account-services-immediate"
  frequency        = "IMMEDIATE"
  monitor_arn_list = [aws_ce_anomaly_monitor.services.arn]

  subscriber {
    type    = "SNS"
    address = local.alerts_topic_arn
  }

  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
      match_options = ["GREATER_THAN_OR_EQUAL"]
      values        = [tostring(var.anomaly_alert_usd)]
    }
  }
}
