output "account_id" {
  value = data.aws_caller_identity.current.account_id
}

output "runtime_url" {
  description = "Slime runtime Function URL (send x-api-key)."
  value       = aws_lambda_function_url.runtime.function_url
}

output "runtime_function_name" {
  value = aws_lambda_function.runtime.function_name
}

output "handlers_table" {
  value = aws_dynamodb_table.handlers.name
}
