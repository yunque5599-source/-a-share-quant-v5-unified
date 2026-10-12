"""V10.4.1 evidence manifest utilities."""

import hashlib
import json


def sha256_json(data):
    raw = json.dumps(data, ensure_ascii=False, sort_keys=True).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def create_manifest(snapshot):
    return {
        "sha256": sha256_json(snapshot),
        "algorithm": "sha256",
    }
