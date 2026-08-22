# storage stack

**Owns the durable state that survives every code redeploy:** the DynamoDB
Connections table, one ECR repository per Lambda image, and the sign-clip
dictionary bucket with its CDN.

## Resources

| Resource | Purpose |
| --- | --- |
| `aws_dynamodb_table.connections` | Live WebSocket session registry. Partition key `connectionId`, TTL on `expiresAt`. Point-in-time recovery only in production. |
| `aws_ecr_repository.lambda[*]` (×6) | Container image storage for each Lambda. Lifecycle policy keeps only the latest 5 images per repo. |
| `aws_s3_bucket.dictionary` | Sign-clip JSON. Private — readable only through CloudFront. |
| `aws_cloudfront_distribution.dictionary` | Public read path for clips. Compression on, `PriceClass_100`. |
| `aws_ssm_parameter.*` | Cross-stack references — table name/ARN, ECR repo URLs, dictionary bucket + base URL. |

## Outputs (via SSM)

| SSM path | Consumed by |
| --- | --- |
| `/signstream/<env>/storage/connections/table_name` | api, async, monitoring |
| `/signstream/<env>/storage/connections/table_arn` | api, async, monitoring |
| `/signstream/<env>/storage/ecr/<function-name>` (×6) | api, async |
| `/signstream/<env>/storage/dictionary/bucket_name` | `scripts/upload-dictionary.py` |
| `/signstream/<env>/storage/dictionary/base_url` | the extension build (`VITE_DICTIONARY_BASE_URL`) |

## The dictionary CDN

Clips are static, immutable JSON fetched one-per-sign by the extension the
moment a sign id arrives. Serving them from Lambda would burn concurrency on
the latency-critical path, so they go to S3 behind CloudFront instead.

The URL layout is fixed by `extension/src/shared/config.ts`:

```text
https://<distribution>.cloudfront.net/<language>/<sign-id>.json
https://d111.cloudfront.net/ghsl/ghsl-hello-v1.json
```

Note the language appears twice — once as the folder, once inside the sign id.
That is deliberate: the object key is derived from each clip's own `signId`
field by the upload script, so the key can never drift from what the backend
asks for.

Populate the bucket with:

```bash
python backend/scripts/upload-dictionary.py --environment staging
```

`scripts/deploy.sh` runs this automatically right after the storage stack.

## Apply

```bash
terraform init
terraform apply -var environment=staging
```

## Notes

- **Billing mode is PAY_PER_REQUEST.** No provisioned capacity means zero
  cost when idle. At the project's demonstrated load (a handful of
  concurrent WebSocket sessions) the DynamoDB monthly bill is well inside
  the free tier.
- **`force_delete = true` on ECR is set for non-production** so `terraform
  destroy` can wipe repos containing images. Production repos require
  manual image cleanup before destroy — deliberate friction.
