output "url" {
  description = "Public landing URL (Lambda Function URL)."
  value       = aws_lambda_function_url.landing.function_url
}

output "function_name" {
  value = aws_lambda_function.landing.function_name
}
