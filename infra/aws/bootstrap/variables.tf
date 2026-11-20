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

variable "trusted_principal_arns" {
  description = "IAM principals allowed to assume the deployer role."
  type        = list(string)
}

variable "budget_limit_usd" {
  description = "Monthly account-wide cost budget in USD."
  type        = number
  default     = 100
}

variable "budget_alert_emails" {
  description = "Recipients of budget alerts. Keep real addresses in the gitignored terraform.tfvars."
  type        = list(string)
}
