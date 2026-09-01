#!/usr/bin/env python3
"""Exercise Twodart's Python Firebase Admin client against a running Fireside suite."""

from __future__ import annotations

import argparse
import json
import os
import time
import uuid
from pathlib import Path
from typing import Any

import firebase_admin
from firebase_admin import auth, firestore, storage


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--auth-host", required=True)
    parser.add_argument("--firestore-host", required=True)
    parser.add_argument("--storage-host", required=True)
    parser.add_argument("--project-id", required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def percentile(values: list[float], quantile: float) -> float:
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(len(ordered) * quantile + 0.999999) - 1))
    return ordered[index]


def summarize(values: list[float]) -> dict[str, float | int]:
    if not values:
        raise RuntimeError("cannot summarize zero samples")
    return {
        "p50Milliseconds": percentile(values, 0.50),
        "p95Milliseconds": percentile(values, 0.95),
        "p99Milliseconds": percentile(values, 0.99),
        "samples": len(values),
    }


def main() -> None:
    args = parse_arguments()
    os.environ["GCLOUD_PROJECT"] = args.project_id
    os.environ["GOOGLE_CLOUD_PROJECT"] = args.project_id
    os.environ["FIREBASE_AUTH_EMULATOR_HOST"] = args.auth_host
    os.environ["FIRESTORE_EMULATOR_HOST"] = args.firestore_host
    os.environ["STORAGE_EMULATOR_HOST"] = f"http://{args.storage_host}"
    os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)

    run_id = f"phase4-python-{int(time.time() * 1000)}-{uuid.uuid4()}"
    uid = f"{run_id}-user"
    email = f"{uid}@example.test"
    document_path = f"_firesidePhase4/{run_id}"
    object_path = f"_firesidePhase4/{run_id}-火🔥.txt"
    app = firebase_admin.initialize_app(
        options={
            "projectId": args.project_id,
            "storageBucket": f"{args.project_id}.appspot.com",
        },
        name=run_id,
    )
    created_user = False
    document: Any = None
    blob: Any = None
    try:
        auth_latencies: list[float] = []
        for index in range(10):
            iteration_uid = f"{uid}-{index}"
            iteration_email = f"{iteration_uid}@example.test"
            started = time.perf_counter()
            auth.create_user(
                uid=iteration_uid,
                email=iteration_email,
                email_verified=True,
                display_name=f"Python Admin 火🔥 {index}",
                app=app,
            )
            observed = auth.get_user(iteration_uid, app=app)
            by_email = auth.get_user_by_email(iteration_email, app=app)
            auth.set_custom_user_claims(iteration_uid, {"phase": 4}, app=app)
            if observed.email != iteration_email or by_email.uid != iteration_uid:
                raise RuntimeError("Python Admin Auth round trip diverged")
            auth.delete_user(iteration_uid, app=app)
            auth_latencies.append((time.perf_counter() - started) * 1000)

        auth.create_user(uid=uid, email=email, email_verified=True, app=app)
        created_user = True
        page = auth.list_users(max_results=1000, app=app)
        if not any(user.uid == uid for user in page.users):
            raise RuntimeError("Python Admin Auth pagination omitted the synthetic user")

        client = firestore.client(app=app)
        document = client.document(document_path)
        document.set({"client": "python-admin", "unicode": "火🔥", "runId": run_id})
        value = document.get().to_dict()
        if value is None or value.get("unicode") != "火🔥":
            raise RuntimeError("Python Admin Firestore round trip diverged")

        bucket = storage.bucket(app=app)
        blob = bucket.blob(object_path)
        payload = f"Python Admin Storage 火🔥 {run_id}".encode()
        blob.metadata = {"phase": "4", "unicode": "火🔥"}
        blob.upload_from_string(payload, content_type="text/plain; charset=utf-8")
        downloaded = blob.download_as_bytes()
        blob.reload()
        listed = list(bucket.list_blobs(prefix=object_path))
        if (
            downloaded != payload
            or blob.metadata is None
            or blob.metadata.get("unicode") != "火🔥"
            or len(listed) != 1
            or listed[0].name != object_path
        ):
            raise RuntimeError("Python Admin Storage round trip diverged")

        evidence = {
            "auth": summarize(auth_latencies),
            "client": "Twodart Python Firebase Admin SDK",
            "firestore": {"passed": True, "unicode": "火🔥"},
            "firebaseAdmin": getattr(firebase_admin, "__version__", "unknown"),
            "passed": True,
            "projectId": args.project_id,
            "schemaVersion": 1,
            "storage": {"bucket": bucket.name, "passed": True},
        }
        output = Path(args.output).resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(evidence, indent=2, ensure_ascii=False) + "\n")
    finally:
        if blob is not None:
            try:
                blob.delete()
            except Exception:
                pass
        if document is not None:
            try:
                document.delete()
            except Exception:
                pass
        if created_user:
            try:
                auth.delete_user(uid, app=app)
            except Exception:
                pass
        firebase_admin.delete_app(app)


if __name__ == "__main__":
    main()
