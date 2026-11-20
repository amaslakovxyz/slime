# Slime Cloud control plane: users, endpoints, usage (slime-cloud/admin).
#
#   USER#<email>   PROFILE              user (scrypt password hash)
#   USER#<email>   ENDPOINT#<id>        endpoint: name, provider, status, url, ...
#   USAGE#<id>     <YYYY-MM>            requests / generations counters
#
# The stream feeds slime-provisioner (provisioner.tf), which creates or deletes
# the endpoint's Lambda when an endpoint item turns `pending` or `deleting`.
# Item shapes: docs/slime-cloud/architecture.html.

resource "aws_dynamodb_table" "control" {
  name         = "${var.project}-control"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  stream_enabled   = true
  stream_view_type = "NEW_IMAGE"

  # Accounts, endpoint records and billing history.
  deletion_protection_enabled = true

  point_in_time_recovery {
    enabled = true
  }
}
