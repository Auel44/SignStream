# scripts — Operational Helpers

Small Bash scripts that automate the repetitive parts of building,
deploying, and inspecting SignStream.

| Script | What it does |
| --- | --- |
| [`build-and-push-images.sh`](build-and-push-images.sh) | Builds and pushes all 6 Lambda container images to ECR. |
| [`deploy.sh`](deploy.sh) | `terraform init` + `apply` in the right order across all four stacks. |
| [`teardown.sh`](teardown.sh) | Reverse of deploy. Prompts before each destroy. |
| [`test-all.sh`](test-all.sh) | Runs every Python test suite (6 Lambdas + layer). Exits non-zero on the first failure. |
| [`logs.sh`](logs.sh) | `aws logs tail` shortcut for any Lambda by short name. |

## Usage from the backend root

```bash
cd backend

# One-off setup
./scripts/deploy.sh staging          # storage → images → async → api → async → monitoring

# During dev
./scripts/test-all.sh                 # runs all pytest suites locally
./scripts/build-and-push-images.sh    # rebuilds and pushes changed images
./scripts/logs.sh asr                 # tails the asr Lambda

# Wind everything down
./scripts/teardown.sh staging
```

## Requirements

- `bash` 4+
- `aws` CLI v2 authenticated with credentials that can write to your target account
- `docker` (for image builds)
- `terraform` ≥ 1.6
- `python` 3.11 (for `test-all.sh`)

All scripts default to region `eu-west-1` — override with `AWS_REGION=...`.
