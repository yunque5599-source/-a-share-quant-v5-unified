"""V10.4.1 forward evidence capture.
Research only. Stores immutable-style signal snapshots.
"""

from datetime import datetime, timezone
import json


def create_snapshot(version, candidates):
    return {
        "version": version,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "candidates": candidates,
    }


def dump_snapshot(path, snapshot):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(snapshot, f, ensure_ascii=False, indent=2)
