# Slime runtime (Gas / Liquid / Crystal engine) on Lambda, Liquid handlers in DynamoDB.
#
#   function   slime-runtime      <- slime-cloud/runtime/dist/lambda (build.sh)
#   URL        public, auth NONE; the function itself requires x-api-key
#   table      slime-handlers     <- pk tenantId, sk artifactKey
#   settings   SSM /slime/runtime/<ENV_NAME>, read at cold start
#
# The SSM parameters are created by hand (see infra/aws/README.md), never by
# Terraform: their values are secrets (DB URL, model key, API key) and would
# otherwise land in state, which the read-only plan role can read.
#
# Build first (build.sh): Terraform zips the bundle, so plan fails without it.

locals {
  runtime_name   = "${var.project}-runtime"
  runtime_ssm    = "/${var.project}/runtime"
  runtime_bundle = "${path.module}/../../../slime-cloud/runtime/dist/lambda"
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
  name               = local.runtime_name
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
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

  # SecureString parameters use the AWS managed key aws/ssm, whose key policy
  # already allows decryption through SSM for principals in the account.
  statement {
    sid     = "Settings"
    actions = ["ssm:GetParametersByPath"]
    resources = [
      "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter${local.runtime_ssm}",
      "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter${local.runtime_ssm}/*",
    ]
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
  description      = "Slime runtime: Gas/Liquid/Crystal handlers over the configured database"
  role             = aws_iam_role.runtime.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.runtime.output_path
  source_code_hash = data.archive_file.runtime.output_base64sha256
  # Generation budget is 25 s (GENERATION_BUDGET_MS); leave room for the response.
  timeout     = 30
  memory_size = 1024

  # No reserved concurrency: the account limit is 10 and AWS keeps at least 10
  # unreserved, so nothing can be reserved until a quota increase.

  environment {
    variables = {
      SLIME_SSM_PREFIX     = "${local.runtime_ssm}/"
      SLIME_HANDLERS_TABLE = aws_dynamodb_table.handlers.name
      SLIME_TENANT_ID      = var.runtime_tenant_id
      SLIME_CRYSTAL_DIR    = "/var/task/crystal"
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
