# Slime Cloud control plane: users, endpoints, usage.
#
#   USER#<email>   PROFILE              user (scrypt password hash)
#   USER#<email>   ENDPOINT#<id>        endpoint: name, provider, connectorType, status, url, ...
#   USAGE#<id>     <YYYY-MM-DD>         daily counters: requests/latency per tier, generations, tokens
#
# Two writers only: the admin (admin.tf) owns users and endpoint items and moves
# endpoint status itself; the runtime (runtime.tf) may only update USAGE#<id>
# items. No stream: nothing reacts to item changes.
# Item shapes: docs/architecture/2026-11-21-cloud-mvp-design.md.

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

  stream_enabled = false

  # Accounts, endpoint records and billing history.
  deletion_protection_enabled = true

  point_in_time_recovery {
    enabled = true
  }
}
