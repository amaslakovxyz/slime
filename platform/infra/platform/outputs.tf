output "account_id" {
  value = data.aws_caller_identity.current.account_id
}

output "runtime_url" {
  description = "Slime runtime Function URL; endpoints live under ep/<id>/ (send x-api-key)."
  value       = aws_lambda_function_url.runtime.function_url
}

output "runtime_function_name" {
  value = aws_lambda_function.runtime.function_name
}

output "handlers_table" {
  value = aws_dynamodb_table.handlers.name
}

output "control_table" {
  value = aws_dynamodb_table.control.name
}

output "crystals_bucket" {
  description = "S3 bucket holding Crystal modules under endpoints/<id>/crystal/."
  value       = aws_s3_bucket.crystals.bucket
}

output "admin_url" {
  description = "Public admin URL on the custom domain (CloudFront), with trailing slash."
  value       = "https://${var.admin_domain}/"
}

output "alerts_topic_arn" {
  description = "Account-wide alerts topic (owned by ex-infra) that the CloudWatch alarms publish to."
  value       = local.alerts_topic_arn
}

output "cloudfront_distribution_id" {
  description = "Admin distribution; CI invalidates it after each apply."
  value       = aws_cloudfront_distribution.admin.id
}
