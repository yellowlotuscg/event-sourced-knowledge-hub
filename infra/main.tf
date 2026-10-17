terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

resource "aws_dynamodb_table" "events" {
  name         = var.events_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "streamId"
  range_key    = "version"

  attribute {
    name = "streamId"
    type = "S"
  }
  attribute {
    name = "version"
    type = "N"
  }

  stream_enabled   = true
  stream_view_type = "NEW_IMAGE"
  point_in_time_recovery {
    enabled = true
  }
  server_side_encryption {
    enabled = true
  }
}

resource "aws_dynamodb_table" "latest" {
  name         = var.latest_projection_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"
  attribute {
    name = "id"
    type = "S"
  }
  server_side_encryption {
    enabled = true
  }
}

resource "aws_dynamodb_table" "by_author" {
  name         = var.author_projection_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "author"
  range_key    = "documentId"
  attribute {
    name = "author"
    type = "S"
  }
  attribute {
    name = "documentId"
    type = "S"
  }
  server_side_encryption {
    enabled = true
  }
}

resource "aws_s3_bucket" "bodies" {
  bucket = var.body_bucket_name
}

resource "aws_s3_bucket_versioning" "bodies" {
  bucket = aws_s3_bucket.bodies.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "bodies" {
  bucket = aws_s3_bucket.bodies.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "bodies" {
  bucket                  = aws_s3_bucket.bodies.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_iam_role" "projector" {
  name = "${var.name_prefix}-projector"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "projector" {
  role = aws_iam_role.projector.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource = "arn:aws:logs:${var.aws_region}:*:log-group:/aws/lambda/${var.name_prefix}-projector:*" },
      { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"], Resource = [aws_dynamodb_table.latest.arn, aws_dynamodb_table.by_author.arn] },
      { Effect = "Allow", Action = ["s3:GetObject"], Resource = "${aws_s3_bucket.bodies.arn}/*" }
    ]
  })
}

resource "aws_iam_role" "api" {
  name = "${var.name_prefix}-api"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "api" {
  role = aws_iam_role.api.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource = "arn:aws:logs:${var.aws_region}:*:log-group:/aws/lambda/${var.name_prefix}-api:*" },
      { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem"], Resource = [aws_dynamodb_table.events.arn, aws_dynamodb_table.latest.arn, aws_dynamodb_table.by_author.arn] },
      { Effect = "Allow", Action = ["s3:PutObject", "s3:GetObject"], Resource = "${aws_s3_bucket.bodies.arn}/*" }
    ]
  })
}

resource "aws_lambda_function" "projector" {
  function_name    = "${var.name_prefix}-projector"
  role             = aws_iam_role.projector.arn
  runtime          = "nodejs20.x"
  handler          = "projector.handler"
  filename         = var.lambda_package_path
  source_code_hash = filebase64sha256(var.lambda_package_path)
  environment {
    variables = {
      LATEST_PROJECTION_TABLE = aws_dynamodb_table.latest.name
      AUTHOR_PROJECTION_TABLE = aws_dynamodb_table.by_author.name
      BODY_BUCKET             = aws_s3_bucket.bodies.bucket
    }
  }
}

resource "aws_lambda_event_source_mapping" "projector" {
  event_source_arn  = aws_dynamodb_table.events.stream_arn
  function_name     = aws_lambda_function.projector.arn
  starting_position = "LATEST"
  batch_size        = 10
}

resource "aws_lambda_function" "api" {
  function_name    = "${var.name_prefix}-api"
  role             = aws_iam_role.api.arn
  runtime          = "nodejs20.x"
  handler          = "api.handler"
  filename         = var.lambda_package_path
  source_code_hash = filebase64sha256(var.lambda_package_path)
  environment {
    variables = {
      EVENTS_TABLE            = aws_dynamodb_table.events.name
      LATEST_PROJECTION_TABLE = aws_dynamodb_table.latest.name
      AUTHOR_PROJECTION_TABLE = aws_dynamodb_table.by_author.name
      BODY_BUCKET             = aws_s3_bucket.bodies.bucket
    }
  }
}

resource "aws_apigatewayv2_api" "http" {
  name          = "${var.name_prefix}-http"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "api" {
  statement_id  = "AllowHttpApiInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}

resource "aws_iam_role" "github_deploy" {
  name = "${var.name_prefix}-github-deploy"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Federated = "arn:aws:iam::${var.aws_account_id}:oidc-provider/token.actions.githubusercontent.com" }, Action = "sts:AssumeRoleWithWebIdentity", Condition = { StringLike = { "token.actions.githubusercontent.com:sub" = "repo:${var.github_repository}:ref:refs/heads/${var.github_branch}" }, StringEquals = { "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com" } } }]
  })
  inline_policy {
    name   = "deploy"
    policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["cloudformation:*", "dynamodb:*", "iam:PassRole", "lambda:*", "s3:*", "apigateway:*"], Resource = "*" }] })
  }
}
