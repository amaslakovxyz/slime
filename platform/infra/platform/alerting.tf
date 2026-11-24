# Operational alerting: CloudWatch alarms -> SNS slime-alerts -> email.
#
#   per function (runtime, admin)   Errors >= 1, Throttles >= 1 in 5 min,
#                                   p99 Duration > 50 s (timeout is 60 s)
#   account                         ConcurrentExecutions >= 800 (limit 1000,
#                                   shared by every function in the account)
#
# Budgets and Cost Anomaly Detection (bootstrap/) cover money; these cover
# failures. Seven alarms stay inside CloudWatch's free 10.
#
# Lambda "Errors" counts unhandled errors and timeouts only: an HTTP 500 that
# the app returns itself does not trip it.
#
# The email subscription is created by hand (platform/infra/README.md): the
# address stays out of this CI-applied stack, and email subscriptions need a
# click to confirm anyway.

resource "aws_sns_topic" "alerts" {
  name = "${var.project}-alerts"
  # No encryption: CloudWatch alarms cannot publish to a topic under the AWS
  # managed key aws/sns, and a customer-managed key costs $1/month. Alarm
  # notifications carry metric names and values, no data (.trivyignore.yaml).
}

locals {
  alarm_functions = {
    runtime = aws_lambda_function.runtime.function_name
    admin   = aws_lambda_function.admin.function_name
  }
  alarm_actions = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each = local.alarm_functions

  alarm_name          = "${each.value}-errors"
  alarm_description   = "${each.value}: unhandled errors or timeouts in the last 5 minutes."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = each.value }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "lambda_throttles" {
  for_each = local.alarm_functions

  alarm_name          = "${each.value}-throttles"
  alarm_description   = "${each.value}: invocations throttled in the last 5 minutes (account concurrency exhausted)."
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  dimensions          = { FunctionName = each.value }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# Both functions time out at 60 s; p99 above 50 s means requests are about to
# be cut off (slow model, slow customer database, cold engine builds).
resource "aws_cloudwatch_metric_alarm" "lambda_duration" {
  for_each = local.alarm_functions

  alarm_name          = "${each.value}-duration-p99"
  alarm_description   = "${each.value}: p99 duration above 50 s over 5 minutes (timeout 60 s)."
  namespace           = "AWS/Lambda"
  metric_name         = "Duration"
  dimensions          = { FunctionName = each.value }
  extended_statistic  = "p99"
  period              = 300
  evaluation_periods  = 1
  threshold           = 50000
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# No dimension: the account-wide metric. The runtime, admin, landing and
# foreign functions all draw on the same 1000 (no reserved concurrency).
resource "aws_cloudwatch_metric_alarm" "account_concurrency" {
  alarm_name          = "${var.project}-account-concurrency"
  alarm_description   = "Account Lambda concurrency at 80% of the 1000 limit; next comes throttling."
  namespace           = "AWS/Lambda"
  metric_name         = "ConcurrentExecutions"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = 800
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}
