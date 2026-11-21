output "url" {
  description = "Lambda Function URL (CloudFront origin; IAM-auth, direct requests get 403)."
  value       = aws_lambda_function_url.landing.function_url
}

output "site_url" {
  description = "Public landing URL on the custom domain (CloudFront)."
  value       = "https://${var.domain_name}/"
}

output "cloudfront_distribution_id" {
  description = "For cache invalidations after platform/landing/ changes."
  value       = aws_cloudfront_distribution.site.id
}

output "function_name" {
  value = aws_lambda_function.landing.function_name
}
