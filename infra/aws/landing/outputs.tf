output "url" {
  description = "Public landing URL (Lambda Function URL)."
  value       = aws_lambda_function_url.landing.function_url
}

output "site_url" {
  description = "Public landing URL on the custom domain (CloudFront)."
  value       = "https://${var.domain_name}/"
}

output "cloudfront_distribution_id" {
  description = "For cache invalidations after landing/ changes."
  value       = aws_cloudfront_distribution.site.id
}

output "function_name" {
  value = aws_lambda_function.landing.function_name
}
