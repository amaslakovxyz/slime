# Atlas customer site (examples/customer-site) on a public Lambda Function URL.
#
#   https://<id>.lambda-url.<region>.on.aws/ -> slime-atlas: src/lambda.mjs
#     loads /slime/atlas/* from SSM at cold start, then serves the Hono app
#
# No CloudFront: every answer is live (tier and timings change per call), so a
# cache would add nothing, and the browser POSTs panels, which CloudFront OAC
# cannot sign. The page can only send a panel id and one of its offered input
# values (src/app.mjs), so a public URL cannot make Slime generate anything new.
#
# Build first (build.sh): plan needs .build/site.

locals {
  name       = "${var.project}-atlas"
  ssm_prefix = "/${var.project}/atlas/"
  ssm_arn    = "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter"
}

data "aws_caller_identity" "current" {}

data "archive_file" "site" {
  type             = "zip"
  source_dir       = "${path.module}/.build/site"
  output_path      = "${path.module}/.build/site.zip"
  output_file_mode = "0644" # stable hash across machines
}

# --- Execution role: logs + its own settings ------------------------------------

data "aws_iam_policy_document" "lambda_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "site" {
  name               = local.name
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

resource "aws_cloudwatch_log_group" "site" {
  name              = "/aws/lambda/${local.name}"
  retention_in_days = var.log_retention_days
}

data "aws_iam_policy_document" "site" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.site.arn}:*"]
  }

  # SLIME_URL, SLIME_API_KEY, CRYSTAL_* (SecureString, AWS managed key aws/ssm).
  statement {
    sid     = "Settings"
    actions = ["ssm:GetParametersByPath"]
    resources = [
      "${local.ssm_arn}${trimsuffix(local.ssm_prefix, "/")}",
      "${local.ssm_arn}${local.ssm_prefix}*",
    ]
  }
}

resource "aws_iam_role_policy" "site" {
  name   = "site"
  role   = aws_iam_role.site.id
  policy = data.aws_iam_policy_document.site.json
}

# --- Function + public URL ------------------------------------------------------

resource "aws_lambda_function" "site" {
  function_name    = local.name
  description      = "Atlas demo customer site (examples/customer-site)"
  role             = aws_iam_role.site.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "src/lambda.handler"
  filename         = data.archive_file.site.output_path
  source_code_hash = data.archive_file.site.output_base64sha256
  memory_size      = 256
  timeout          = 30 # a Gas generation behind a panel took 5.6 s on 2026-11-22

  environment {
    variables = {
      ATLAS_SSM_PREFIX = local.ssm_prefix
      MULTI_SOURCE_URL = "off" # Customer 360 needs a self-hosted Slime; see src/app.mjs
    }
  }

  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.site.name
  }

  depends_on = [aws_iam_role_policy.site]
}

resource "aws_lambda_function_url" "site" {
  function_name      = aws_lambda_function.site.function_name
  authorization_type = "NONE"
}

# Public Function URLs need both statements; the second is scoped to URL
# invocations so the function is not publicly invokable through the Invoke API.
resource "aws_lambda_permission" "site_url" {
  statement_id           = "PublicFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.site.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "site_invoke_via_url" {
  statement_id             = "PublicInvokeViaFunctionUrl"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.site.function_name
  principal                = "*"
  invoked_via_function_url = true
}
