terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }

  # Uncomment for team use — see backend/infrastructure/README.md.
  # backend "s3" {
  #   bucket         = "signstream-terraform-state"
  #   key            = "storage.tfstate"
  #   region         = "eu-west-1"
  #   dynamodb_table = "signstream-terraform-locks"
  #   encrypt        = true
  # }
}
