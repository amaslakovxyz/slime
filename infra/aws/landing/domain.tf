# Custom domain: <domain> and www.<domain> -> CloudFront -> Function URL.
#
# Function URLs cannot take a custom domain, so CloudFront fronts the URL.
# Its cache also shields the function: the account Lambda concurrency limit is
# 10 and shared by every function.
#
# The hosted zone is owned outside Terraform (created by the Route 53
# registrar) and also carries iCloud mail records (MX, SPF/TXT, DKIM, DMARC);
# this file only adds/overwrites the records listed below and never touches
# those. Before this stack, the apex A record pointed at 142.93.162.168 (an
# unreachable host); allow_overwrite replaces it with the CloudFront alias.

locals {
  domain_names = [var.domain_name, "www.${var.domain_name}"]
  # "https://<id>.lambda-url.<region>.on.aws/" -> "<id>.lambda-url.<region>.on.aws"
  origin_host = trimsuffix(trimprefix(aws_lambda_function_url.landing.function_url, "https://"), "/")
}

data "aws_route53_zone" "site" {
  name         = var.domain_name
  private_zone = false
}

# --- Certificate (CloudFront requires us-east-1) ------------------------------

resource "aws_acm_certificate" "site" {
  provider                  = aws.us_east_1
  domain_name               = var.domain_name
  subject_alternative_names = ["www.${var.domain_name}"]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# ACM validation CNAMEs are deterministic per account+name, so the apex one may
# already exist from older certificates (e.g. the eu-central-1 ones):
# overwrite instead of failing.
resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.site.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      record = dvo.resource_record_value
    }
  }

  zone_id         = data.aws_route53_zone.site.zone_id
  name            = each.value.name
  type            = each.value.type
  ttl             = 300
  records         = [each.value.record]
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "site" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.site.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

# --- CloudFront ----------------------------------------------------------------

# AWS managed policies (stable IDs).
data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

resource "aws_cloudfront_distribution" "site" {
  enabled         = true
  is_ipv6_enabled = true
  http_version    = "http2and3"
  comment         = "${local.name}: ${var.domain_name}"
  aliases         = local.domain_names
  price_class     = "PriceClass_100" # NA + EU edges only; cheapest

  origin {
    origin_id   = "function-url"
    domain_name = local.origin_host

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # No origin request policy: CloudFront then sends the origin's own Host
  # header, which the Function URL requires. The function honours
  # Cache-Control (HTML 5 min, assets 1 day) and gzips by Accept-Encoding,
  # which CachingOptimized normalises into the cache key.
  default_cache_behavior {
    target_origin_id       = "function-url"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = data.aws_cloudfront_cache_policy.caching_optimized.id
    compress               = true
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.site.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

# --- DNS -------------------------------------------------------------------------

resource "aws_route53_record" "site" {
  for_each = {
    for pair in setproduct(local.domain_names, ["A", "AAAA"]) : "${pair[0]}/${pair[1]}" => {
      name = pair[0]
      type = pair[1]
    }
  }

  zone_id         = data.aws_route53_zone.site.zone_id
  name            = each.value.name
  type            = each.value.type
  allow_overwrite = true

  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}
