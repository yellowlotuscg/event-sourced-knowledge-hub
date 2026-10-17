output "api_url" { value = aws_apigatewayv2_api.http.api_endpoint }
output "events_table" { value = aws_dynamodb_table.events.name }
output "body_bucket" { value = aws_s3_bucket.bodies.bucket }
output "github_deploy_role_arn" { value = aws_iam_role.github_deploy.arn }
