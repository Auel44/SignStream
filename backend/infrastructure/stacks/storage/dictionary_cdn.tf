# ── Dictionary CDN: S3 origin + CloudFront ───────────────────────────────────
#
# Sign clips are static, immutable JSON. The extension fetches one per sign the
# moment it is emitted, so the read path has to be low-latency and must not
# consume Lambda concurrency — a CDN in front of a private bucket is the whole
# design.
#
# Why this shape:
#   * Immutable objects. A clip's URL contains its version (`ghsl-hello-v1`),
#     so a changed clip becomes v2 and never needs a cache invalidation. That
#     lets us cache for a year at the edge and in the browser.
#   * Private bucket + Origin Access Control. The bucket blocks all public
#     access; only this distribution can read it. Making the bucket itself
#     public would work but leaves the origin URL reachable, bypassing the
#     cache and the CORS/security headers below.
#   * Cost: CloudFront's 1 TB/month egress and 10M requests are *always* free
#     (not a 12-month trial), and clips gzip to a few KB. This stays inside the
#     free tier at realistic usage, unlike serving clips from a Lambda.
#
# The URL layout must match extension/src/shared/config.ts `signClipUrl`:
#     <distribution-domain>/<language>/<sign-id>.json
#     e.g. https://d111.cloudfront.net/ghsl/ghsl-hello-v1.json

resource "aws_s3_bucket" "dictionary" {
  bucket = "${local.name_prefix}-dictionary-${data.aws_caller_identity.current.account_id}"

  # Staging is disposable; production clips are re-generatable from the source
  # datasets but a stray destroy should still not silently succeed.
  force_destroy = var.environment != "production"

  tags = {
    Name = "${local.name_prefix}-dictionary"
  }
}

# The bucket is reachable only through CloudFront. Belt and braces alongside
# the bucket policy below: if the policy is ever loosened by mistake, these
# account-level blocks still prevent an ACL from making objects world-readable.
resource "aws_s3_bucket_public_access_block" "dictionary" {
  bucket                  = aws_s3_bucket.dictionary.id
  block_public_acls       = true
  block_public_policy     = false # the OAC policy below is a bucket policy
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "dictionary" {
  bucket = aws_s3_bucket.dictionary.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_ownership_controls" "dictionary" {
  bucket = aws_s3_bucket.dictionary.id

  rule {
    object_ownership = "BucketOwnerEnforced" # disables ACLs entirely
  }
}

# Versioning on a bucket of immutable, regenerable files would only accumulate
# storage cost. Clip changes go through the sign-id version suffix instead.

# ── CloudFront ───────────────────────────────────────────────────────────────

resource "aws_cloudfront_origin_access_control" "dictionary" {
  name                              = "${local.name_prefix}-dictionary-oac"
  description                       = "Lets only the dictionary distribution read the dictionary bucket."
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Managed policy: cache on URL only, no cookies/headers/query strings, and
# request compressed objects from the origin. Correct here because a clip URL
# fully determines its content.
data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

# CORS is required, not optional: the fetch originates from a content script
# whose Origin is `chrome-extension://<id>`. That id differs per install and
# per browser, so it cannot be enumerated — hence `*`. Safe here because the
# clips are public, non-personal, read-only data and credentials are never
# sent (allow_credentials = false).
resource "aws_cloudfront_response_headers_policy" "dictionary" {
  name    = "${local.name_prefix}-dictionary-headers"
  comment = "CORS for extension fetches + baseline security headers."

  cors_config {
    access_control_allow_credentials = false
    origin_override                  = true

    access_control_allow_headers {
      items = ["*"]
    }

    access_control_allow_methods {
      items = ["GET", "HEAD", "OPTIONS"]
    }

    access_control_allow_origins {
      items = ["*"]
    }

    access_control_max_age_sec = 86400
  }

  security_headers_config {
    content_type_options {
      override = true
    }

    frame_options {
      frame_option = "DENY"
      override     = true
    }

    referrer_policy {
      referrer_policy = "no-referrer"
      override        = true
    }

    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      override                   = true
    }
  }
}

resource "aws_cloudfront_distribution" "dictionary" {
  enabled     = true
  comment     = "${local.name_prefix} sign dictionary"
  price_class = "PriceClass_100" # NA + EU only; cheapest tier

  # No custom domain — the *.cloudfront.net name is used directly, which keeps
  # this stack free of Route53/ACM dependencies.

  origin {
    domain_name              = aws_s3_bucket.dictionary.bucket_regional_domain_name
    origin_id                = "dictionary-s3"
    origin_access_control_id = aws_cloudfront_origin_access_control.dictionary.id
  }

  default_cache_behavior {
    target_origin_id       = "dictionary-s3"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]

    # Clips are JSON; gzip/brotli at the edge cuts them by roughly 10x, which
    # matters more than anything else for time-to-first-sign.
    compress = true

    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.dictionary.id
  }

  # A missing clip is normal — not every gloss has a recording. Cache the miss
  # briefly so a word the dictionary lacks doesn't hit the origin on every
  # utterance. No response_page_path: the client checks `res.ok` and treats any
  # non-2xx as "skip this sign", so a rewritten body would go unread.
  custom_error_response {
    error_code            = 403 # S3 returns 403, not 404, for absent keys
    error_caching_min_ttl = 60
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = {
    Name = "${local.name_prefix}-dictionary"
  }
}

# Grant the distribution — and nothing else — read access to the bucket.
data "aws_iam_policy_document" "dictionary_bucket" {
  statement {
    sid     = "AllowCloudFrontRead"
    effect  = "Allow"
    actions = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.dictionary.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    # Without this condition ANY CloudFront distribution in ANY AWS account
    # could read the bucket — the service principal alone is not an identity.
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.dictionary.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "dictionary" {
  bucket = aws_s3_bucket.dictionary.id
  policy = data.aws_iam_policy_document.dictionary_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.dictionary]
}

# ── SSM: publish for the upload script and the extension build ───────────────

resource "aws_ssm_parameter" "dictionary_bucket_name" {
  name  = "/${var.project}/${var.environment}/storage/dictionary/bucket_name"
  type  = "String"
  value = aws_s3_bucket.dictionary.id
}

resource "aws_ssm_parameter" "dictionary_base_url" {
  name  = "/${var.project}/${var.environment}/storage/dictionary/base_url"
  type  = "String"
  value = "https://${aws_cloudfront_distribution.dictionary.domain_name}"
}
