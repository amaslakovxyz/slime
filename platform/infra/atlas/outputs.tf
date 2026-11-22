output "site_url" {
  description = "Public Atlas customer site (Function URL), with trailing slash."
  value       = aws_lambda_function_url.site.function_url
}

output "function_name" {
  value = aws_lambda_function.site.function_name
}
