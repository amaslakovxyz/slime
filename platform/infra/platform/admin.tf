# Slime Cloud admin (platform/admin, Next.js standalone) on Lambda behind CloudFront.
#
#   https://<admin_domain>/ -> CloudFront (adds x-slime-origin) -> Function URL
#     -> slime-admin: run.sh -> start.mjs (loads /slime/admin/* from SSM) -> Next
#        server on PORT, fronted by the AWS Lambda Web Adapter layer
#
# The admin owns endpoint provisioning in the cloud: it writes the endpoint's
# SSM settings and control item, health-checks it through the runtime URL, and
# tears down the handler partition, Crystal prefix, control item and settings.
#
# The Function URL is auth NONE, not CloudFront OAC as in the landing stack: OAC
# requires the client to send x-amz-content-sha256 on POST, which browsers do
# not, so every server action (sign-in, create, Crystallize) would fail. A
# random header that only CloudFront sends, checked by platform/admin/proxy.ts,
# keeps direct *.lambda-url.* hits out; sessions still guard every page.
#
# Build first (build.sh): plan needs platform/admin/dist/lambda and
# platform/admin/dist/source-hash.txt.

locals {
  admin_name        = "${var.project}-admin"
  admin_bundle      = "${path.module}/../../../platform/admin/dist/lambda"
  admin_source_hash = "${path.module}/../../../platform/admin/dist/source-hash.txt"
  # "https://<id>.lambda-url.<region>.on.aws/" -> "<id>.lambda-url.<region>.on.aws"
  admin_origin_host = trimsuffix(trimprefix(aws_lambda_function_url.admin.function_url, "https://"), "/")
}

# --- Execution role ---------------------------------------------------------------

resource "aws_iam_role" "admin" {
  name                 = local.admin_name
  assume_role_policy   = data.aws_iam_policy_document.lambda_trust.json
  permissions_boundary = local.workload_boundary_arn
}

resource "aws_cloudwatch_log_group" "admin" {
  name              = "/aws/lambda/${local.admin_name}"
  retention_in_days = var.log_retention_days
}

data "aws_iam_policy_document" "admin" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.admin.arn}:*"]
  }

  # Users, endpoint records and usage reads.
  statement {
    sid       = "Control"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query"]
    resources = [aws_dynamodb_table.control.arn]
  }

  # Teardown deletes the endpoint's Liquid handlers.
  statement {
    sid       = "HandlerCleanup"
    actions   = ["dynamodb:Query", "dynamodb:BatchWriteItem"]
    resources = [aws_dynamodb_table.handlers.arn]
  }

  # DATABASE_URL, SLIME_API_KEY, CRYSTAL_TOKENS, SLIME_PROVIDER per endpoint.
  # SecureString writes use the AWS managed key aws/ssm (no KMS grant needed).
  statement {
    sid       = "EndpointSettings"
    actions   = ["ssm:PutParameter", "ssm:GetParameter", "ssm:GetParametersByPath", "ssm:DeleteParameters"]
    resources = ["${local.ssm_arn_prefix}/endpoints/*"]
  }

  # SESSION_SECRET and ADMIN_ALLOWED_EMAILS, loaded by start.mjs at cold start.
  statement {
    sid     = "AdminSettings"
    actions = ["ssm:GetParametersByPath"]
    resources = [
      "${local.ssm_arn_prefix}/admin",
      "${local.ssm_arn_prefix}/admin/*",
    ]
  }

  # Teardown lists every version under endpoints/<id>/ and deletes them.
  statement {
    sid       = "CrystalList"
    actions   = ["s3:ListBucket", "s3:ListBucketVersions"]
    resources = [aws_s3_bucket.crystals.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["endpoints/*"]
    }
  }

  statement {
    sid       = "CrystalCleanup"
    actions   = ["s3:DeleteObject", "s3:DeleteObjectVersion"]
    resources = ["${aws_s3_bucket.crystals.arn}/endpoints/*"]
  }
}

resource "aws_iam_role_policy" "admin" {
  name   = "admin"
  role   = aws_iam_role.admin.id
  policy = data.aws_iam_policy_document.admin.json
}

# --- Function + public URL -----------------------------------------------------------

# Mode 0755 for every file: Lambda runs the handler run.sh directly, so it must
# stay executable. The zip is not reproducible anyway (Next writes per-build
# keys); source_code_hash below is the deploy trigger.
data "archive_file" "admin" {
  type             = "zip"
  source_dir       = local.admin_bundle
  output_path      = "${path.module}/.build/admin.zip"
  output_file_mode = "0755"
}

# The origin header value only proves a request came through CloudFront; it
# opens no data, so having it in state is acceptable.
resource "random_password" "origin" {
  length  = 48
  special = false
}

resource "aws_lambda_function" "admin" {
  function_name = local.admin_name
  description   = "Slime Cloud admin (Next.js standalone on the Lambda Web Adapter)"
  role          = aws_iam_role.admin.arn
  runtime       = "nodejs22.x"
  architectures = ["arm64"]
  handler       = "run.sh"
  filename      = data.archive_file.admin.output_path
  # ADMIN_SOURCE_HASH from platform/admin/scripts/build-lambda.mjs: a hash over
  # the admin's inputs, so an unchanged admin keeps the deployed function even
  # though every build zips different bytes. Read only when the file exists so
  # `terraform validate` runs without a build; the precondition fails the plan.
  source_code_hash = fileexists(local.admin_source_hash) ? trimspace(file(local.admin_source_hash)) : null
  layers           = ["arn:aws:lambda:${var.region}:753240598075:layer:LambdaAdapterLayerArm64:${var.lwa_layer_version}"]
  # Cloud create and Crystallize wait for the runtime (health check up to 20 s,
  # Crystallize up to the runtime's 60 s) inside one server action.
  timeout     = 60
  memory_size = 1024

  environment {
    variables = {
      AWS_LAMBDA_EXEC_WRAPPER      = "/opt/bootstrap"
      PORT                         = "8080"
      AWS_LWA_READINESS_CHECK_PATH = "/login"
      # Next's standalone server binds to HOSTNAME; the adapter proxies to it locally.
      HOSTNAME               = "0.0.0.0"
      SLIME_SECRETS          = "ssm"
      SLIME_CONTROL_TABLE    = aws_dynamodb_table.control.name
      SLIME_HANDLERS_TABLE   = aws_dynamodb_table.handlers.name
      SLIME_CRYSTAL_BUCKET   = aws_s3_bucket.crystals.bucket
      SLIME_RUNTIME_URL      = aws_lambda_function_url.runtime.function_url
      SLIME_ORIGIN_SECRET    = random_password.origin.result
      SLIME_ADMIN_SSM_PREFIX = "/${var.project}/admin/"
    }
  }

  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.admin.name
  }

  lifecycle {
    precondition {
      condition     = fileexists(local.admin_source_hash)
      error_message = "platform/admin/dist/source-hash.txt is missing: run platform/infra/platform/build.sh first."
    }
  }

  depends_on = [aws_iam_role_policy.admin]
}

resource "aws_lambda_function_url" "admin" {
  function_name      = aws_lambda_function.admin.function_name
  authorization_type = "NONE"
}

# Public Function URLs need both statements; the second is scoped to URL
# invocations so the function is not publicly invokable through the Invoke API.
resource "aws_lambda_permission" "admin_url" {
  statement_id           = "PublicFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.admin.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "admin_invoke_via_url" {
  statement_id             = "PublicInvokeViaFunctionUrl"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.admin.function_name
  principal                = "*"
  invoked_via_function_url = true
}

# --- Certificate (CloudFront requires us-east-1) ------------------------------

# The zone is owned outside Terraform (see platform/infra/landing/domain.tf);
# this stack only adds the admin's records to it.
data "aws_route53_zone" "admin" {
  name         = var.zone_name
  private_zone = false
}

resource "aws_acm_certificate" "admin" {
  provider          = aws.us_east_1
  domain_name       = var.admin_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# ACM validation CNAMEs are deterministic per account+name, so one may already
# exist from an earlier certificate: overwrite instead of failing.
resource "aws_route53_record" "admin_cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.admin.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      record = dvo.resource_record_value
    }
  }

  zone_id         = data.aws_route53_zone.admin.zone_id
  name            = each.value.name
  type            = each.value.type
  ttl             = 300
  records         = [each.value.record]
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "admin" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.admin.arn
  validation_record_fqdns = [for r in aws_route53_record.admin_cert_validation : r.fqdn]
}

# --- CloudFront ----------------------------------------------------------------

# AWS managed policies (stable IDs).
data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

# Forwards cookies, query strings and every viewer header except Host: the
# Function URL rejects a foreign Host, so CloudFront sends the origin's own.
data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

# HSTS, nosniff, Referrer-Policy, X-Frame-Options SAMEORIGIN, XSS protection.
data "aws_cloudfront_response_headers_policy" "security_headers" {
  name = "Managed-SecurityHeadersPolicy"
}

resource "aws_cloudfront_distribution" "admin" {
  enabled         = true
  is_ipv6_enabled = true
  http_version    = "http2and3"
  comment         = "${local.admin_name}: ${var.admin_domain}"
  aliases         = [var.admin_domain]
  price_class     = "PriceClass_100" # NA + EU edges only; cheapest

  origin {
    origin_id   = "admin-function-url"
    domain_name = local.admin_origin_host

    custom_header {
      name  = "x-slime-origin"
      value = random_password.origin.result
    }

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
      # Server actions can wait on the runtime (create, Crystallize) for up
      # to the function timeout.
      origin_read_timeout = 60
    }
  }

  # Every page is dynamic and behind a session: nothing is cached.
  default_cache_behavior {
    target_origin_id           = "admin-function-url"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security_headers.id
    compress                   = true
  }

  # Next's hashed build assets are immutable: cache them at the edge.
  ordered_cache_behavior {
    path_pattern               = "/_next/static/*"
    target_origin_id           = "admin-function-url"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security_headers.id
    compress                   = true
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.admin.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

# --- DNS -------------------------------------------------------------------------

resource "aws_route53_record" "admin" {
  for_each = toset(["A", "AAAA"])

  zone_id         = data.aws_route53_zone.admin.zone_id
  name            = var.admin_domain
  type            = each.value
  allow_overwrite = true

  alias {
    name                   = aws_cloudfront_distribution.admin.domain_name
    zone_id                = aws_cloudfront_distribution.admin.hosted_zone_id
    evaluate_target_health = false
  }
}
