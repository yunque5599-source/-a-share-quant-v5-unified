"""V10.4.1 forward evidence prototype.
Research only. Stores immutable-style signal records before evaluation.
"""

from datetime import datetime, timezone
import hashlib
import json


def build_signal_record(version, candidates):
    return {
        "version": version,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "candidates": candidates,
    }


def generate_sha256(record):
    payload = json.dumps(record, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
