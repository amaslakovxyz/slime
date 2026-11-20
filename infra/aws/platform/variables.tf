variable "project" {
  description = "Project name; Project tag value and required resource name prefix (CI roles only manage slime-* IAM/S3)."
  type        = string
  default     = "slime"
}

variable "region" {
  description = "Home region; the CI roles deny regional services elsewhere."
  type        = string
  default     = "eu-central-1"
}

variable "runtime_tenant_id" {
  description = "Partition key the single-tenant runtime writes its handlers under."
  type        = string
  default     = "demo"
}

variable "log_retention_days" {
  description = "CloudWatch retention for Lambda logs in this stack."
  type        = number
  default     = 14
}
