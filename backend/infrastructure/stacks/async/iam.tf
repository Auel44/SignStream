# ── Shared IAM helpers ────────────────────────────────────────────────────────
#
# Every Lambda gets its own execution role with least-privilege policies. We
# don't share roles across Lambdas because that would grant, for example,
# text-to-gloss the ability to read from SQS which it never should.

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# ── asr execution role ───────────────────────────────────────────────────────

resource "aws_iam_role" "asr" {
  name               = "${local.name_prefix}-asr-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "asr_basic" {
  role       = aws_iam_role.asr.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "asr" {
  statement {
    sid = "ConsumeAudioQueue"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
    ]
    resources = [aws_sqs_queue.audio.arn]
  }
  statement {
    sid       = "PublishTranscripts"
    actions   = ["events:PutEvents"]
    resources = [aws_cloudwatch_event_bus.signstream.arn]
  }
  statement {
    sid     = "PushToWebSocketClients"
    actions = ["execute-api:ManageConnections"]
    # Scoped to var.websocket_api_id — defaults to "*" for the first deploy
    # (before the api stack exists) and should be set to the real API id
    # afterwards so this grant covers exactly one WebSocket API.
    resources = [
      "arn:aws:execute-api:${var.aws_region}:${data.aws_caller_identity.current.account_id}:${var.websocket_api_id}/*/POST/@connections/*"
    ]
  }
}

resource "aws_iam_role_policy" "asr" {
  role   = aws_iam_role.asr.name
  policy = data.aws_iam_policy_document.asr.json
}

# ── text-to-gloss execution role ─────────────────────────────────────────────

resource "aws_iam_role" "text_to_gloss" {
  name               = "${local.name_prefix}-text-to-gloss-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "text_to_gloss_basic" {
  role       = aws_iam_role.text_to_gloss.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "text_to_gloss" {
  statement {
    sid       = "PublishSignIdEvents"
    actions   = ["events:PutEvents"]
    resources = [aws_cloudwatch_event_bus.signstream.arn]
  }
  statement {
    sid     = "PushToWebSocketClients"
    actions = ["execute-api:ManageConnections"]
    resources = [
      "arn:aws:execute-api:${var.aws_region}:${data.aws_caller_identity.current.account_id}:*/*/POST/@connections/*"
    ]
  }
}

resource "aws_iam_role_policy" "text_to_gloss" {
  role   = aws_iam_role.text_to_gloss.name
  policy = data.aws_iam_policy_document.text_to_gloss.json
}

# ── health-warmer execution role ─────────────────────────────────────────────

resource "aws_iam_role" "health_warmer" {
  name               = "${local.name_prefix}-health-warmer-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "health_warmer_basic" {
  role       = aws_iam_role.health_warmer.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "health_warmer" {
  statement {
    sid     = "InvokeWarmedLambdas"
    actions = ["lambda:InvokeFunction"]
    # Narrower than "*": only the specific warmed functions.
    resources = [
      aws_lambda_function.asr.arn,
      aws_lambda_function.text_to_gloss.arn,
      "arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:${local.name_prefix}-ws-audio-ingest",
    ]
  }
}

resource "aws_iam_role_policy" "health_warmer" {
  role   = aws_iam_role.health_warmer.name
  policy = data.aws_iam_policy_document.health_warmer.json
}

# ── EventBridge Scheduler assume role (for health-warmer schedule) ───────────

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "warmer_scheduler" {
  name               = "${local.name_prefix}-warmer-scheduler-role"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

resource "aws_iam_role_policy" "warmer_scheduler" {
  role = aws_iam_role.warmer_scheduler.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "lambda:InvokeFunction"
        Resource = aws_lambda_function.health_warmer.arn
      }
    ]
  })
}
