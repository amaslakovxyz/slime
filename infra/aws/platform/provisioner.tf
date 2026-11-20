# Endpoint provisioner: one Lambda per customer endpoint, created at runtime.
#
#   slime-control stream (endpoint item -> pending | deleting)
#     -> slime-provisioner   <- slime-cloud/provisioner/dist/lambda (build.sh)
#          creates/deletes   role slime-ep-<id>, function slime-ep-<id> (shim + Gas
#                            layer), its public Function URL and log group
#
# Guard rails, because this function creates IAM roles at runtime:
#   * it may only create roles named slime-ep-* that carry the permissions
#     boundary slime-endpoint-boundary, so an endpoint role can never exceed it;
#   * it may only pass slime-ep-* roles, and only to Lambda;
#   * every name it touches is prefixed slime-ep-*, inside the CI apply fences.
# Per-endpoint isolation (dynamodb:LeadingKeys, /slime/endpoints/<id>/) is in the
# inline policy the provisioner writes (slime-cloud/provisioner/src/provision.ts).
#
# The stream filter matches only `pending` and `deleting`; the provisioner's own
# writes (provisioning, ready, failed) never re-trigger it.

locals {
  provisioner_name   = "${var.project}-provisioner"
  provisioner_bundle = "${path.module}/../../../slime-cloud/provisioner/dist/lambda"
  account_id         = data.aws_caller_identity.current.account_id
  endpoint_prefix    = "${var.project}-ep-"
  endpoint_functions = "arn:aws:lambda:${var.region}:${local.account_id}:function:${local.endpoint_prefix}*"
  endpoint_roles     = "arn:aws:iam::${local.account_id}:role/${local.endpoint_prefix}*"
  endpoint_log_group = "arn:aws:logs:${var.region}:${local.account_id}:log-group:/aws/lambda/${local.endpoint_prefix}*"
  ssm_arn_prefix     = "arn:aws:ssm:${var.region}:${local.account_id}:parameter/${var.project}"
}

# --- Permissions boundary for every endpoint role ------------------------------------

data "aws_iam_policy_document" "endpoint_boundary" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${local.endpoint_log_group}:*"]
  }

  statement {
    sid       = "HandlerStore"
    actions   = ["dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.handlers.arn]
  }

  statement {
    sid       = "Usage"
    actions   = ["dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.control.arn]
  }

  statement {
    sid     = "Settings"
    actions = ["ssm:GetParametersByPath"]
    resources = [
      "${local.ssm_arn_prefix}/shared",
      "${local.ssm_arn_prefix}/shared/*",
      "${local.ssm_arn_prefix}/endpoints/*",
    ]
  }

  statement {
    sid       = "Tracing"
    actions   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "endpoint_boundary" {
  name        = "${var.project}-endpoint-boundary"
  description = "Permissions boundary for provisioned endpoint roles (slime-ep-*)"
  policy      = data.aws_iam_policy_document.endpoint_boundary.json
}

# --- Provisioner role ---------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "provisioner" {
  name              = "/aws/lambda/${local.provisioner_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "provisioner" {
  name               = local.provisioner_name
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

data "aws_iam_policy_document" "provisioner" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.provisioner.arn}:*"]
  }

  statement {
    sid       = "ControlStream"
    actions   = ["dynamodb:GetRecords", "dynamodb:GetShardIterator", "dynamodb:DescribeStream", "dynamodb:ListStreams"]
    resources = ["${aws_dynamodb_table.control.arn}/stream/*"]
  }

  statement {
    sid       = "ControlItems"
    actions   = ["dynamodb:UpdateItem", "dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.control.arn]
  }

  # Teardown deletes the endpoint's Liquid handlers.
  statement {
    sid       = "HandlerCleanup"
    actions   = ["dynamodb:Query", "dynamodb:BatchWriteItem"]
    resources = [aws_dynamodb_table.handlers.arn]
  }

  # Reads the endpoint token for the health check; deletes secrets on teardown.
  statement {
    sid       = "EndpointSecrets"
    actions   = ["ssm:GetParameter", "ssm:GetParametersByPath", "ssm:DeleteParameters"]
    resources = ["${local.ssm_arn_prefix}/endpoints/*"]
  }

  statement {
    sid       = "CreateBoundedEndpointRoles"
    actions   = ["iam:CreateRole", "iam:PutRolePolicy"]
    resources = [local.endpoint_roles]

    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [aws_iam_policy.endpoint_boundary.arn]
    }
  }

  statement {
    sid       = "ManageEndpointRoles"
    actions   = ["iam:GetRole", "iam:TagRole", "iam:DeleteRolePolicy", "iam:DeleteRole"]
    resources = [local.endpoint_roles]
  }

  statement {
    sid       = "PassEndpointRolesToLambda"
    actions   = ["iam:PassRole"]
    resources = [local.endpoint_roles]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["lambda.amazonaws.com"]
    }
  }

  statement {
    sid = "EndpointFunctions"
    actions = [
      "lambda:CreateFunction", "lambda:GetFunction", "lambda:GetFunctionConfiguration", "lambda:DeleteFunction",
      "lambda:TagResource", "lambda:AddPermission", "lambda:CreateFunctionUrlConfig", "lambda:GetFunctionUrlConfig",
      "lambda:DeleteFunctionUrlConfig",
    ]
    resources = [local.endpoint_functions]
  }

  statement {
    sid       = "GasLayer"
    actions   = ["lambda:GetLayerVersion"]
    resources = [aws_lambda_layer_version.gas.arn]
  }

  statement {
    sid       = "EndpointLogGroups"
    actions   = ["logs:CreateLogGroup", "logs:PutRetentionPolicy", "logs:DeleteLogGroup", "logs:TagResource"]
    resources = [local.endpoint_log_group, "${local.endpoint_log_group}:*"]
  }

  statement {
    sid       = "Tracing"
    actions   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "provisioner" {
  name   = "provisioner"
  role   = aws_iam_role.provisioner.id
  policy = data.aws_iam_policy_document.provisioner.json
}

# --- Function + stream trigger ----------------------------------------------------------------

data "archive_file" "provisioner" {
  type             = "zip"
  source_dir       = local.provisioner_bundle
  output_path      = "${path.module}/.build/provisioner.zip"
  output_file_mode = "0644" # stable hash across machines
}

resource "aws_lambda_function" "provisioner" {
  function_name    = local.provisioner_name
  description      = "Creates and deletes Slime Cloud endpoint functions from slime-control"
  role             = aws_iam_role.provisioner.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.provisioner.output_path
  source_code_hash = data.archive_file.provisioner.output_base64sha256
  # Provisioning waits for IAM propagation, function activation and a health check.
  timeout     = 300
  memory_size = 256

  tracing_config {
    mode = "Active"
  }

  environment {
    variables = {
      SLIME_CONTROL_TABLE         = aws_dynamodb_table.control.name
      SLIME_HANDLERS_TABLE        = aws_dynamodb_table.handlers.name
      SLIME_GAS_LAYER_ARN         = aws_lambda_layer_version.gas.arn
      SLIME_ENDPOINT_BOUNDARY_ARN = aws_iam_policy.endpoint_boundary.arn
      # The shim zip is a few hundred bytes; inline it instead of an S3 bucket.
      SLIME_ENDPOINT_SHIM_ZIP_B64 = filebase64(data.archive_file.endpoint_shim.output_path)
      SLIME_SHARED_SSM_PREFIX     = "/${var.project}/shared/"
      SLIME_LOG_RETENTION_DAYS    = tostring(var.log_retention_days)
    }
  }

  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.provisioner.name
  }

  depends_on = [aws_iam_role_policy.provisioner]
}

# Untagged on purpose: tagging on create needs lambda:TagResource on the
# event-source-mapping ARN, which the CI apply guard denies (it allows only
# function:slime-*). See the `untagged` provider in versions.tf.
resource "aws_lambda_event_source_mapping" "provisioner" {
  provider               = aws.untagged
  function_name          = aws_lambda_function.provisioner.arn
  event_source_arn       = aws_dynamodb_table.control.stream_arn
  starting_position      = "LATEST"
  batch_size             = 1
  maximum_retry_attempts = 2

  filter_criteria {
    filter {
      pattern = jsonencode({
        eventName = ["INSERT", "MODIFY"]
        dynamodb = {
          NewImage = {
            # Endpoint items live under USER#; endpoint roles can write only
            # USAGE#<id>, so they cannot forge a record that reaches the worker.
            pk     = { S = [{ prefix = "USER#" }] }
            type   = { S = ["endpoint"] }
            status = { S = ["pending", "deleting"] }
          }
        }
      })
    }
  }
}
