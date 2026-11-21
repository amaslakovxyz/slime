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

variable "domain_name" {
  description = "Apex domain served by CloudFront (plus www.); its Route 53 zone must exist in the account."
  type        = string
  default     = "amaslakov.com"
}

variable "log_retention_days" {
  description = "CloudWatch retention for the landing function logs."
  type        = number
  default     = 14
}
