#!/usr/bin/env python3
"""Upload sign clips from `dictionary/` to the S3 bucket behind the CDN.

Why a script and not `aws s3 sync`
-----------------------------------
Two things a plain sync gets wrong:

1. **The key is not the filename.** On disk a clip is
   `dictionary/ghsl/hello-v1.json`, but the extension requests it at
   `<cdn>/ghsl/ghsl-hello-v1.json` — the language is repeated in the object
   name because the sign id the backend emits *is* `ghsl-hello-v1`. Rather
   than trusting the path, this script reads each clip's own `signId` field
   and uses that, so the uploaded key is guaranteed to be the URL the
   backend will ask for. A mismatch here is invisible until a user sees a
   sign silently not play.

2. **Content-Type.** S3 defaults to `binary/octet-stream` for unknown
   extensions; CloudFront only compresses a response when the origin's
   content type is compressible. Getting this wrong costs ~10x bandwidth.

Objects are immutable (the version lives in the key), so they are uploaded
with a one-year `Cache-Control` and skipped on re-run unless the local file
differs — an unchanged 1,198-clip dictionary re-uploads nothing.

Usage
-----
    python upload-dictionary.py --environment staging
    python upload-dictionary.py --environment staging --language ghsl
    python upload-dictionary.py --bucket my-bucket --dry-run
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

try:
    import boto3
    from botocore.exceptions import ClientError
except ImportError:  # pragma: no cover - dependency hint
    sys.exit("boto3 is required: pip install boto3")

log = logging.getLogger("upload-dictionary")
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

# Immutable objects: the sign id in the key changes when the clip changes.
CACHE_CONTROL = "public, max-age=31536000, immutable"

# S3 PUTs are latency-bound, not CPU-bound, so parallelism helps a lot and the
# GIL is irrelevant here.
UPLOAD_THREADS = 16


def repo_root() -> Path:
    """backend/scripts/ -> repo root."""
    return Path(__file__).resolve().parents[2]


def resolve_bucket(project: str, environment: str, region: str) -> str:
    """Read the bucket name the storage stack published to SSM."""
    ssm = boto3.client("ssm", region_name=region)
    name = f"/{project}/{environment}/storage/dictionary/bucket_name"
    try:
        return ssm.get_parameter(Name=name)["Parameter"]["Value"]
    except ClientError as exc:
        sys.exit(
            f"could not read {name} from SSM ({exc.response['Error']['Code']}).\n"
            "Has the storage stack been applied? Otherwise pass --bucket."
        )


def clip_key(path: Path, language_dir: str) -> str | None:
    """The S3 key for a clip, taken from its own signId field.

    Returns None when the file is not a usable clip, so a stray file in the
    dictionary folder cannot land in the bucket as a broken sign.
    """
    try:
        sign_id = json.loads(path.read_text(encoding="utf-8")).get("signId")
    except Exception as exc:  # noqa: BLE001
        log.warning("skip unreadable clip %s: %s", path.name, exc)
        return None
    if not sign_id:
        log.warning("skip %s: no signId field", path.name)
        return None
    if not sign_id.startswith(f"{language_dir}-"):
        # The URL layout derives the folder from the id's language prefix, so
        # a clip filed under the wrong language would be unreachable.
        log.warning("skip %s: signId %r does not match folder %r",
                    path.name, sign_id, language_dir)
        return None
    return f"{language_dir}/{sign_id}.json"


def etag_of(path: Path) -> str:
    """S3's ETag for a non-multipart object is the MD5 of its bytes.

    Used only to skip unchanged uploads — never as a security check, which is
    why a non-cryptographic digest is fine here.
    """
    return hashlib.md5(path.read_bytes()).hexdigest()  # noqa: S324


def existing_etags(s3, bucket: str, prefix: str) -> dict[str, str]:
    """Map key -> etag for everything already under `prefix`."""
    out: dict[str, str] = {}
    paginator = s3.get_paginator("list_objects_v2")
    try:
        for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
            for obj in page.get("Contents", []):
                out[obj["Key"]] = obj["ETag"].strip('"')
    except ClientError as exc:
        sys.exit(f"cannot list s3://{bucket}/{prefix}: {exc}")
    return out


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--bucket", help="Target bucket. Default: read from SSM.")
    p.add_argument("--project", default="signstream")
    p.add_argument("--environment", default="staging", choices=["staging", "production"])
    p.add_argument("--region", default="eu-west-1")
    p.add_argument("--dictionary-dir", default=None, help="Defaults to <repo>/dictionary.")
    p.add_argument("--language", default=None, help="Only this language folder, e.g. ghsl.")
    p.add_argument("--force", action="store_true", help="Re-upload even if unchanged.")
    p.add_argument("--dry-run", action="store_true", help="Report without uploading.")
    args = p.parse_args()

    root = Path(args.dictionary_dir) if args.dictionary_dir else repo_root() / "dictionary"
    if not root.is_dir():
        sys.exit(f"no dictionary directory at {root}")

    languages = (
        [args.language.lower()]
        if args.language
        else sorted(d.name for d in root.iterdir() if d.is_dir())
    )

    bucket = args.bucket or resolve_bucket(args.project, args.environment, args.region)
    s3 = boto3.client("s3", region_name=args.region)
    log.info("bucket: %s", bucket)

    total_uploaded = total_skipped = total_invalid = 0

    for language in languages:
        lang_dir = root / language
        if not lang_dir.is_dir():
            log.warning("no such language folder: %s", lang_dir)
            continue

        clips = sorted(lang_dir.glob("*.json"))
        if not clips:
            log.info("%s: no clips", language)
            continue

        remote = {} if args.dry_run else existing_etags(s3, bucket, f"{language}/")

        pending: list[tuple[Path, str]] = []
        for path in clips:
            key = clip_key(path, language)
            if key is None:
                total_invalid += 1
                continue
            if not args.force and remote.get(key) == etag_of(path):
                total_skipped += 1
                continue
            pending.append((path, key))

        log.info("%s: %d clips, %d to upload, %d unchanged",
                 language, len(clips), len(pending), len(clips) - len(pending))

        if args.dry_run:
            for _, key in pending[:5]:
                log.info("  would upload %s", key)
            if len(pending) > 5:
                log.info("  ... and %d more", len(pending) - 5)
            total_uploaded += len(pending)
            continue

        def put(item: tuple[Path, str]) -> bool:
            path, key = item
            try:
                s3.put_object(
                    Bucket=bucket,
                    Key=key,
                    Body=path.read_bytes(),
                    ContentType="application/json",
                    CacheControl=CACHE_CONTROL,
                )
                return True
            except ClientError as exc:
                log.error("failed %s: %s", key, exc)
                return False

        with ThreadPoolExecutor(max_workers=UPLOAD_THREADS) as pool:
            results = list(pool.map(put, pending))
        total_uploaded += sum(results)

    log.info("")
    log.info("uploaded : %d", total_uploaded)
    log.info("unchanged: %d", total_skipped)
    if total_invalid:
        log.warning("invalid  : %d (see warnings above)", total_invalid)
    if not args.dry_run and total_uploaded:
        log.info("")
        log.info("Point the extension at the CDN — from backend/infrastructure/stacks/storage:")
        log.info("  terraform output -raw dictionary_base_url")
    return 0


if __name__ == "__main__":
    sys.exit(main())
