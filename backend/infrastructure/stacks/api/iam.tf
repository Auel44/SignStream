data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# ── ws-connect: put a row in Connections ──────────────────────────────────────

resource "aws_iam_role" "ws_connect" {
  name               = "${local.name_prefix}-ws-connect-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "ws_connect_basic" {
  role       = aws_iam_role.ws_connect.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "ws_connect" {
  role = aws_iam_role.ws_connect.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "PutConnection"
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem"]
        Resource = data.aws_ssm_parameter.connections_table_arn.value
      }
    ]
  })
}

# ── ws-disconnect: delete a row ──────────────────────────────────────────────

resource "aws_iam_role" "ws_disconnect" {
  name               = "${local.name_prefix}-ws-disconnect-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "ws_disconnect_basic" {
  role       = aws_iam_role.ws_disconnect.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "ws_disconnect" {
  role = aws_iam_role.ws_disconnect.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "DeleteConnection"
        Effect   = "Allow"
        Action   = ["dynamodb:DeleteItem"]
        Resource = data.aws_ssm_parameter.connections_table_arn.value
      }
    ]
  })
}

# ── ws-audio-ingest: UpdateItem + SQS SendMessage ─────────────────────────────

resource "aws_iam_role" "ws_audio_ingest" {
  name               = "${local.name_prefix}-ws-audio-ingest-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "ws_audio_ingest_basic" {
  role       = aws_iam_role.ws_audio_ingest.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "ws_audio_ingest" {
  role = aws_iam_role.ws_audio_ingest.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "IncrementSequenceAndLanguage"
        Effect   = "Allow"
        Action   = ["dynamodb:UpdateItem"]
        Resource = data.aws_ssm_parameter.connections_table_arn.value
      },
      {
        Sid      = "EnqueueAudio"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = data.aws_ssm_parameter.audio_queue_arn.value
      }
    ]
  })
}
