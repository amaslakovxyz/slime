# Crystal modules per endpoint, written by the runtime's Crystallize and read
# on every tenant build; the admin's teardown deletes an endpoint's prefix.
#
#   s3://slime-crystals-<account>/endpoints/<id>/crystal/manifest.json
#   s3://slime-crystals-<account>/endpoints/<id>/crystal/<crystal key>.mjs
#
# The runtime checks each module against the manifest's sha256 and runs it as
# data in QuickJS; nothing in this bucket is ever imported as code.
# Versioning keeps overwritten manifests recoverable (restore the previous
# version to undo a bad Crystallize); deleting a prefix therefore deletes every
# object version, not just the current one.

resource "aws_s3_bucket" "crystals" {
  bucket = "${var.project}-crystals-${local.account_id}"
}

resource "aws_s3_bucket_ownership_controls" "crystals" {
  bucket = aws_s3_bucket.crystals.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "crystals" {
  bucket                  = aws_s3_bucket.crystals.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "crystals" {
  bucket = aws_s3_bucket.crystals.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "crystals" {
  bucket = aws_s3_bucket.crystals.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "crystals" {
  bucket = aws_s3_bucket.crystals.id

  rule {
    id     = "expire-old-crystal-versions"
    status = "Enabled"
    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.crystals]
}

data "aws_iam_policy_document" "crystals_bucket" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.crystals.arn, "${aws_s3_bucket.crystals.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "crystals" {
  bucket = aws_s3_bucket.crystals.id
  policy = data.aws_iam_policy_document.crystals_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.crystals]
}
