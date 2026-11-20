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
