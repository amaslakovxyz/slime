# Slime runtime: one multi-tenant Lambda serving every endpoint under /ep/<id>/.
#
#   function   slime-runtime      <- platform/runtime/dist/lambda (build.sh)
#   URL        public, auth NONE; the function checks each endpoint's x-api-key
#   table      slime-handlers     <- pk tenantId (= endpoint id), sk artifactKey
#   settings   SSM /slime/endpoints/<id>/ (written by the admin) and
#              /slime/shared/ (model keys, set by hand), re-read every
#              SLIME_TENANT_TTL_MS into a per-endpoint env, never process.env
#   Crystals   s3://slime-crystals-<account>/endpoints/<id>/crystal/ (crystals.tf)
#   usage      slime-control items USAGE#<id> only
#
# Terraform never manages the SSM parameters: their values are secrets (DB URL,
# model key, API key) and would otherwise land in state, which the read-only
# plan role can read.
#
# One role reads every endpoint's settings, handler partition and Crystal
# prefix: per-endpoint IAM isolation is a non-goal of the cloud MVP
# (docs/architecture/2026-11-21-cloud-mvp-design.md).
#
# Build first (build.sh): Terraform zips the bundle, so plan fails without it.

locals {
  runtime_name   = "${var.project}-runtime"
  runtime_bundle = "${path.module}/../../../platform/runtime/dist/lambda"
  account_id     = data.aws_caller_identity.current.account_id
  ssm_arn_prefix = "arn:aws:ssm:${var.region}:${local.account_id}:parameter/${var.project}"
  # Every attribute the runtime's usage flush writes on USAGE#<id> day items:
  # USAGE_ATTRIBUTES in platform/runtime/src/usage.ts, plus the key. A new
  # attribute there needs the same name here, or every flush gets AccessDenied.
  usage_attributes = [
    "pk",
    "sk",
    "requests",
    "generations",
    "gasRequests",
    "liquidRequests",
    "crystalRequests",
    "gasMs",
    "liquidMs",
    "crystalMs",
    "tokens",
    "gasHandlers",
    "liquidHandlers",
    "crystalHandlers",
    "updatedAt",
  ]
}

# --- Handler store --------------------------------------------------------------

resource "aws_dynamodb_table" "handlers" {
  name         = "${var.project}-handlers"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "tenantId"
  range_key    = "artifactKey"

  attribute {
    name = "tenantId"
    type = "S"
  }

  attribute {
    name = "artifactKey"
    type = "S"
  }

  # Reviewed Liquid handlers are the product's learned state: keep them.
  deletion_protection_enabled = true

  point_in_time_recovery {
    enabled = true
  }
}

# --- Execution role ---------------------------------------------------------------

data "aws_iam_policy_document" "lambda_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "runtime" {
  name                 = local.runtime_name
  assume_role_policy   = data.aws_iam_policy_document.lambda_trust.json
  permissions_boundary = local.workload_boundary_arn
}

resource "aws_cloudwatch_log_group" "runtime" {
  name              = "/aws/lambda/${local.runtime_name}"
  retention_in_days = var.log_retention_days
}

data "aws_iam_policy_document" "runtime" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.runtime.arn}:*"]
  }

  statement {
    sid       = "HandlerStore"
    actions   = ["dynamodb:Query", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.handlers.arn]
  }

  # Usage counters only: the role cannot touch users or endpoint records, nor
  # shape an item with attributes other than the counters.
  statement {
    sid       = "Usage"
    actions   = ["dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.control.arn]

    condition {
      test     = "ForAllValues:StringLike"
      variable = "dynamodb:LeadingKeys"
      values   = ["USAGE#*"]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:Attributes"
      values   = local.usage_attributes
    }
  }

  # Reading the same counters back: the requests feed's total is the sum of an
  # endpoint's USAGE#<id> day items, the one count every warm instance adds to.
  statement {
    sid       = "UsageRead"
    actions   = ["dynamodb:Query"]
    resources = [aws_dynamodb_table.control.arn]

    condition {
      test     = "ForAllValues:StringLike"
      variable = "dynamodb:LeadingKeys"
      values   = ["USAGE#*"]
    }
  }

  # GetParametersByPath is authorized on the path itself: /slime/shared/ is the
  # ARN .../parameter/slime/shared, /slime/endpoints/<id>/ is matched by
  # endpoints/*. SecureString parameters use the AWS managed key aws/ssm, whose
  # key policy already allows decryption through SSM for principals in the account.
  statement {
    sid     = "Settings"
    actions = ["ssm:GetParametersByPath"]
    resources = [
      "${local.ssm_arn_prefix}/shared",
      "${local.ssm_arn_prefix}/shared/*",
      "${local.ssm_arn_prefix}/endpoints/*",
    ]
  }

  # Crystal manifests and modules: read on every tenant build, written by
  # Crystallize (conditional PUT on the manifest's ETag). No delete: teardown is
  # the admin's, and this role runs generated code for every endpoint, so it must
  # not be able to erase the versions that undo a bad Crystallize.
  statement {
    sid       = "CrystalObjects"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.crystals.arn}/endpoints/*"]
  }

  # Unconditional on purpose: S3 answers a GET/HEAD of a missing object with 404
  # only when the caller holds s3:ListBucket on the bucket, and that check
  # carries no s3:prefix. With a prefix-scoped grant an endpoint without
  # Crystals would get 403 for its manifest. The bucket holds nothing but
  # endpoints/*, which this role reads anyway.
  statement {
    sid       = "CrystalList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.crystals.arn]
  }
}

resource "aws_iam_role_policy" "runtime" {
  name   = "runtime"
  role   = aws_iam_role.runtime.id
  policy = data.aws_iam_policy_document.runtime.json
}

# --- Function + public URL -----------------------------------------------------------

data "archive_file" "runtime" {
  type             = "zip"
  source_dir       = local.runtime_bundle
  output_path      = "${path.module}/.build/runtime.zip"
  output_file_mode = "0644" # stable hash across machines
}

resource "aws_lambda_function" "runtime" {
  function_name    = local.runtime_name
  description      = "Slime runtime: Gas/Liquid/Crystal handlers for every endpoint under /ep/<id>/"
  role             = aws_iam_role.runtime.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.runtime.output_path
  source_code_hash = data.archive_file.runtime.output_base64sha256
  # Query generation stays capped at 25 s (GENERATION_BUDGET_MS); a Crystallize
  # call (equivalence test on fixtures, S3 uploads) needs the rest.
  timeout = 60
  # Shared by every cached endpoint engine (at most SLIME_TENANT_CACHE_MAX).
  # Raise to 2048 if peak RSS passes ~70 % with a full cache.
  memory_size = 1024

  # No reserved concurrency: the account limit is 1000 (checked 2026-11-21)
  # and shared with the admin and landing functions; nothing needs a floor yet.

  environment {
    variables = {
      SLIME_HANDLERS_TABLE     = aws_dynamodb_table.handlers.name
      SLIME_USAGE_TABLE        = aws_dynamodb_table.control.name
      SLIME_CRYSTAL_BUCKET     = aws_s3_bucket.crystals.bucket
      SLIME_SHARED_SSM_PREFIX  = "/${var.project}/shared/"
      SLIME_TENANT_CACHE_MAX   = "8"
      SLIME_TENANT_TTL_MS      = "30000"
      SLIME_MAX_DB_CONNECTIONS = "2"
      # Liquid run counts reach the store after every request: Crystallize can land on
      # another warm instance, which only sees the store (platform/runtime/src/live-runs.ts).
      SLIME_RUNS_SYNC_MS = "0"
    }
  }

  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.runtime.name
  }

  depends_on = [aws_iam_role_policy.runtime]
}

resource "aws_lambda_function_url" "runtime" {
  function_name      = aws_lambda_function.runtime.function_name
  authorization_type = "NONE"
}

# Public Function URLs need both statements; the second is scoped to URL
# invocations so the function is not publicly invokable through the Invoke API.
resource "aws_lambda_permission" "runtime_url" {
  statement_id           = "PublicFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.runtime.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "runtime_invoke_via_url" {
  statement_id             = "PublicInvokeViaFunctionUrl"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.runtime.function_name
  principal                = "*"
  invoked_via_function_url = true
}
