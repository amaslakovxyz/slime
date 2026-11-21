output "deployer_role_arn" {
  description = "Role to assume for all slime infra work."
  value       = aws_iam_role.deployer.arn
}

output "state_bucket" {
  value = aws_s3_bucket.state.bucket
}

output "gha_role_arns" {
  description = "Roles referenced by .github/workflows/terraform.yml."
  value       = { for k, r in aws_iam_role.gha : k => r.arn }
}

output "region" {
  value = var.region
}

output "resource_group" {
  value = aws_resourcegroups_group.project.name
}

output "aws_cli_profile" {
  description = "Snippet to append to ~/.aws/config."
  value       = <<-EOT
    [profile ${var.project}]
    role_arn = ${aws_iam_role.deployer.arn}
    source_profile = ${var.bootstrap_profile}
    region = ${var.region}
  EOT
}
