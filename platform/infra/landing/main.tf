# Landing page (platform/landing/) served by a Lambda Function URL.
#
#   layer    slime-landing-site  <- platform/landing/ minus tools/ and README (unpacked at /opt)
#   function slime-landing       <- function/index.mjs (static file server)
#   URL      AWS_IAM; only CloudFront (OAC, domain.tf) may invoke it
#
# Site files are a layer so Terraform packages them straight from platform/landing/
# with no build step; editing platform/landing/ yields a new layer version on apply.
# The layer description below keeps "landing/": it is ForceNew, so editing it
# would publish a new layer version.
# Names follow the slime-* convention that the CI roles enforce.

locals {
  name     = "${var.project}-landing"
  site_dir = "${path.module}/../../../platform/landing"
}

data "archive_file" "site" {
  type             = "zip"
  source_dir       = local.site_dir
  excludes         = ["README.md", "tools/**", "**/.DS_Store", ".DS_Store"]
  output_path      = "${path.module}/.build/site.zip"
  output_file_mode = "0644" # stable hash across machines
}

data "archive_file" "function" {
  type             = "zip"
  source_dir       = "${path.module}/function"
  excludes         = ["*.test.mjs"]
  output_path      = "${path.module}/.build/function.zip"
  output_file_mode = "0644"
}

resource "aws_lambda_layer_version" "site" {
  layer_name               = "${local.name}-site"
  description              = "Static files from landing/"
  filename                 = data.archive_file.site.output_path
  source_code_hash         = data.archive_file.site.output_base64sha256
  compatible_runtimes      = ["nodejs22.x"]
  compatible_architectures = ["arm64"]
}

# --- Execution role: logs only ------------------------------------------------

data "aws_iam_policy_document" "lambda_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "landing" {
  name               = local.name
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

resource "aws_cloudwatch_log_group" "landing" {
  name              = "/aws/lambda/${local.name}"
  retention_in_days = var.log_retention_days
}

data "aws_iam_policy_document" "landing_logs" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.landing.arn}:*"]
  }
}

resource "aws_iam_role_policy" "landing_logs" {
  name   = "logs"
  role   = aws_iam_role.landing.id
  policy = data.aws_iam_policy_document.landing_logs.json
}

# --- Function + public URL ----------------------------------------------------

resource "aws_lambda_function" "landing" {
  function_name    = local.name
  description      = "Serves the slime landing page"
  role             = aws_iam_role.landing.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.function.output_path
  source_code_hash = data.archive_file.function.output_base64sha256
  layers           = [aws_lambda_layer_version.site.arn]
  memory_size      = 256
  timeout          = 5

  # No reserved concurrency: the account limit is 10, and AWS keeps at least
  # 10 unreserved, so nothing can be reserved until a quota increase.

  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.landing.name
  }

  depends_on = [aws_iam_role_policy.landing_logs]
}

# The URL is IAM-authenticated: only our CloudFront distribution (signing via
# Origin Access Control, see domain.tf) may call it. Direct hits on the
# *.lambda-url.* host get 403 and never run the function, so traffic cannot
# bypass the CloudFront cache and burn the account's shared concurrency (10).
resource "aws_lambda_function_url" "landing" {
  function_name      = aws_lambda_function.landing.function_name
  authorization_type = "AWS_IAM"
}

# Both statements are required for a Function URL (AWS change, Oct 2025),
# each scoped to this one distribution.
resource "aws_lambda_permission" "cloudfront_url" {
  statement_id           = "CloudFrontFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.landing.function_name
  principal              = "cloudfront.amazonaws.com"
  source_arn             = aws_cloudfront_distribution.site.arn
  function_url_auth_type = "AWS_IAM"
}

resource "aws_lambda_permission" "cloudfront_invoke_via_url" {
  statement_id             = "CloudFrontInvokeViaFunctionUrl"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.landing.function_name
  principal                = "cloudfront.amazonaws.com"
  source_arn               = aws_cloudfront_distribution.site.arn
  invoked_via_function_url = true
}
