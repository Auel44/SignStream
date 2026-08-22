terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }

  # backend "s3" {
  #   bucket         = "signstream-terraform-state"
  #   key            = "api.tfstate"
  #   region         = "eu-west-1"
  #   dynamodb_table = "signstream-terraform-locks"
  #   encrypt        = true
  # }
}
