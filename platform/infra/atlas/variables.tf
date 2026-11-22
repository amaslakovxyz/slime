variable "project" {
  description = "Project name; Project tag and resource name prefix."
  type        = string
  default     = "slime"
}

variable "region" {
  description = "Home region."
  type        = string
  default     = "eu-central-1"
}

variable "log_retention_days" {
  description = "CloudWatch retention for the site function logs."
  type        = number
  default     = 14
}
