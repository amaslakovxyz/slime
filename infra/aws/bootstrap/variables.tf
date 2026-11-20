variable "project" {
  description = "Project name; used as the Project tag value and resource name prefix."
  type        = string
  default     = "slime"
}

variable "region" {
  description = "The only region the deployer role may use for regional services."
  type        = string
  default     = "eu-central-1"
}

variable "bootstrap_profile" {
  description = "Local AWS CLI profile with IAM admin rights used to create this stack."
  type        = string
  default     = "default"
}

variable "github_repository" {
  description = "owner/name of the repository whose Actions may assume the CI roles."
  type        = string
  default     = "amaslakovxyz/slime"
}

variable "github_oidc_sub_prefix" {
  description = "OIDC subject prefix for github_repository (immutable form, includes owner/repo IDs)."
  type        = string
  default     = "repo:amaslakovxyz@29117334/slime@1465448238"

  validation {
    condition     = startswith(var.github_oidc_sub_prefix, "repo:")
    error_message = "Must look like repo:owner@<id>/name@<id> (see sub_claim_prefix)."
  }
}

variable "trusted_principal_arns" {
  description = "IAM principals allowed to assume the deployer role."
  type        = list(string)
}

variable "budget_limit_usd" {
  description = "Monthly account-wide cost budget in USD."
  type        = number
  default     = 100
}

variable "project_budget_limit_usd" {
  description = "Monthly project budget in USD (spend in var.region only)."
  type        = number
  default     = 15
}

variable "project_budget_alert_usd" {
  description = "Early-warning alert on actual project spend, in USD."
  type        = number
  default     = 10.5

  validation {
    condition     = var.project_budget_alert_usd < var.project_budget_limit_usd
    error_message = "project_budget_alert_usd must be below project_budget_limit_usd."
  }
}

variable "budget_alert_emails" {
  description = "Recipients of budget alerts. Keep real addresses in the gitignored terraform.tfvars."
  type        = list(string)
}
