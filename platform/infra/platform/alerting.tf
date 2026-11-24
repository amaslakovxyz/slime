# Operational alerting: CloudWatch alarms -> SNS ops-alerts -> Telegram + email.
#
# ops-alerts is the account-wide topic owned by ex-infra
# (infra/terraform/aws/alerting.tf, applied by hand): this stack only
# publishes to it by ARN and never manages it. CI may publish to and list
# foreign topics, not change them (bootstrap gha-apply guard).
#
#   slime-runtime   Errors >= 1             timeouts, crashes (unhandled only)
#                   handled 500s >= 1       log metric filter: app.onError and
#                                           core INTERNAL answer 500 without a
#                                           Lambda error, so Errors misses them
#                   "Flush failed" >= 1     log metric filter: usage writes
#                                           denied or failing, billing data lost
#                   p99 Duration > 50 s     timeout is 60 s
#   slime-admin     Url5xxCount >= 1        Next errors and function errors
#                                           (a failed invoke answers 502)
#                   p99 Duration > 50 s
#   slime-atlas     Url5xxCount >= 1        the public demo site; its stack has
#                                           no topic, so the alarm lives here
#   account         ClaimedAccountConcurrency >= var.account_concurrency_alarm
#                   Throttles >= 1          every function, one alarm
#
# Runtime 5xx are not alarmed on Url5xxCount: most of them are 503 NOT_READY
# from /healthz when a customer's database is unreachable (216 of 216 sampled
# on 2026-11-21/22), which is the customer's problem, not the platform's.
#
# Nine alarms here plus ex-infra's forwarder alarm: exactly CloudWatch's free
# 10 per account. Budgets and Cost Anomaly Detection (bootstrap/) cover money
# and publish to the same topic; these cover failures.
#
# Post-deploy CI warns while the topic has no confirmed subscription.

locals {
  alerts_topic_arn   = "arn:aws:sns:${var.region}:${local.account_id}:${var.alerts_topic_name}"
  alarm_actions      = [local.alerts_topic_arn]
  alarm_period_s     = 300
  duration_alarm_ms  = 50000 # 10 s below both functions' 60 s timeout
  runtime_metrics_ns = "Slime/Runtime"

  # Text patterns, not JSON selectors: the runtime logs JSON.stringify(...) via
  # console.log, which Lambda's JSON log format wraps as an escaped string in
  # "message", so $.status never resolves. Checked with test-metric-filter: the
  # status pattern matches \"status\":500 and not 503 or \"ms\":500.
  runtime_log_metrics = {
    handled-500 = {
      pattern     = "\"status\\\\\\\":500\""
      description = "answered 500 INTERNAL (an AWS call or the engine failed; see the log's error field)"
    }
    usage-flush-failed = {
      pattern     = "\"Flush failed\""
      description = "failed to write USAGE#<id> counters (often AccessDenied after a new usage attribute; runtime.tf usage_attributes)"
    }
  }

  duration_alarm_functions = {
    runtime = aws_lambda_function.runtime.function_name
    admin   = aws_lambda_function.admin.function_name
  }

  url_5xx_alarm_functions = {
    admin = aws_lambda_function.admin.function_name
    # Owned by the atlas stack; referenced by name so neither stack depends on
    # the other's apply order.
    atlas = "${var.project}-atlas"
  }
}

# --- slime-runtime ------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "runtime_errors" {
  alarm_name          = "${aws_lambda_function.runtime.function_name}-errors"
  alarm_description   = "${aws_lambda_function.runtime.function_name}: timeouts or unhandled errors in the last 5 minutes."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.runtime.function_name }
  statistic           = "Sum"
  period              = local.alarm_period_s
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_log_metric_filter" "runtime" {
  for_each = local.runtime_log_metrics

  name           = "${aws_lambda_function.runtime.function_name}-${each.key}"
  log_group_name = aws_cloudwatch_log_group.runtime.name
  pattern        = each.value.pattern

  metric_transformation {
    name      = each.key
    namespace = local.runtime_metrics_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "runtime_log" {
  for_each = local.runtime_log_metrics

  alarm_name          = "${aws_lambda_function.runtime.function_name}-${each.key}"
  alarm_description   = "${aws_lambda_function.runtime.function_name}: ${each.value.description}, last 5 minutes."
  namespace           = local.runtime_metrics_ns
  metric_name         = aws_cloudwatch_log_metric_filter.runtime[each.key].metric_transformation[0].name
  statistic           = "Sum"
  period              = local.alarm_period_s
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# --- Per-function latency and 5xx ------------------------------------------------------

# At hackathon traffic a 5-minute p99 is close to the maximum, so one slow
# Crystallize would page; two breaching periods out of three are required.
resource "aws_cloudwatch_metric_alarm" "lambda_duration" {
  for_each = local.duration_alarm_functions

  alarm_name          = "${each.value}-duration-p99"
  alarm_description   = "${each.value}: p99 duration above ${local.duration_alarm_ms / 1000} s in 2 of the last 3 five-minute periods (timeout 60 s)."
  namespace           = "AWS/Lambda"
  metric_name         = "Duration"
  dimensions          = { FunctionName = each.value }
  extended_statistic  = "p99"
  period              = local.alarm_period_s
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = local.duration_alarm_ms
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "url_5xx" {
  for_each = local.url_5xx_alarm_functions

  alarm_name          = "${each.value}-url-5xx"
  alarm_description   = "${each.value}: Function URL answered 5xx (app error, timeout or crash) in the last 5 minutes."
  namespace           = "AWS/Lambda"
  metric_name         = "Url5xxCount"
  dimensions          = { FunctionName = each.value }
  statistic           = "Sum"
  period              = local.alarm_period_s
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# --- Account ------------------------------------------------------------------------------

# No dimensions: account-wide metrics. Every function (slime and foreign)
# draws on one concurrency pool; nothing is reserved. ClaimedAccountConcurrency
# also counts reserved and provisioned concurrency, so it is the metric AWS
# compares against the quota.
resource "aws_cloudwatch_metric_alarm" "account_concurrency" {
  alarm_name          = "${var.project}-account-concurrency"
  alarm_description   = "Account Lambda claimed concurrency >= ${var.account_concurrency_alarm} (keep near 80% of the quota); next comes throttling."
  namespace           = "AWS/Lambda"
  metric_name         = "ClaimedAccountConcurrency"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = var.account_concurrency_alarm
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "account_throttles" {
  alarm_name          = "${var.project}-account-throttles"
  alarm_description   = "Lambda throttled invocations in the account in the last 5 minutes (callers got 429)."
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  statistic           = "Sum"
  period              = local.alarm_period_s
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}
