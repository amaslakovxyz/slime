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

variable "log_retention_days" {
  description = "CloudWatch retention for Lambda logs in this stack."
  type        = number
  default     = 14
}

variable "admin_domain" {
  description = "Hostname of the admin (CloudFront alias); must sit inside zone_name."
  type        = string
  default     = "admin.amaslakov.com"
}

variable "zone_name" {
  description = "Existing public Route 53 hosted zone that gets the admin's certificate validation and alias records."
  type        = string
  default     = "amaslakov.com"
}

variable "lwa_layer_version" {
  description = "Version of the AWS Lambda Web Adapter layer (LambdaAdapterLayerArm64) the admin runs on."
  type        = number
  default     = 30
}
