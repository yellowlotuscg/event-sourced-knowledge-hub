variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "aws_account_id" {
  type    = string
  default = "000000000000"
}

variable "name_prefix" {
  type    = string
  default = "event-sourced-knowledge-hub"
}

variable "events_table_name" {
  type    = string
  default = "knowledge-events"
}

variable "latest_projection_table_name" {
  type    = string
  default = "knowledge-latest"
}

variable "author_projection_table_name" {
  type    = string
  default = "knowledge-by-author"
}

variable "body_bucket_name" {
  type    = string
  default = "replace-with-globally-unique-bucket"
}

variable "lambda_package_path" {
  type    = string
  default = "lambda.zip"
}

variable "github_repository" {
  type    = string
  default = "example/example"
}

variable "github_branch" {
  type    = string
  default = "main"
}
