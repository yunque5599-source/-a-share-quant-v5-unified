#!/usr/bin/env python3
"""Read-only source ranking capture. Never infer executable model BUY/WAIT."""
from __future__ import annotations
import datetime as dt
import hashlib
import json
import os
import pathlib
import re
import sys
import urllib.error
import urllib.request
from zoneinfo import ZoneInfo

SOURCE_URL = "https://a-share-quant-v5-unified.vercel.app/api/market?action=ranked_candidates"
SH = ZoneInfo("Asia/Shanghai")
MAX_BYTES = 8 * 1024 * 1024
API_CANDIDATE_CAP = 420  # api/market.js: candidates: rows.slice(0, 420)


def aware(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.astimezone(dt.timezone.utc) if parsed.tzinfo else None
    except (ValueError, OverflowError):
        return None


def audit(payload, captured_at, http_status, response_headers=None):
    """Evaluate a provider ranking ARCHIVE, not a trade or a certified point-in-time quote."""
    if captured_at.tzinfo is None:
        raise ValueError("captured_at must be timezone-aware")
    d = payload.get("data") if isinstance(payload, dict) else None
    d = d if isinstance(d, dict) else {}
    rows = d.get("candidates")
    rows = rows if isinstance(rows, list) else []
    codes = [str(x.get("f12", "")) for x in rows if isinstance(x, dict)]
    n_returned = len(rows)
    n_reported = d.get("candidateCount")
    # The current API reports FULL MERGED COUNT but slices delivered candidates at 420.
    count_consistent = (type(n_reported) is int and n_reported >= n_returned > 0
                        and n_returned <= API_CANDIDATE_CAP
                        and (n_reported == n_returned or n_returned == API_CANDIDATE_CAP))
    universe = d.get("universeTotal")
    universe_consistent = (type(universe) is int and universe >= n_reported > 0) if type(n_reported) is int else False
    codes_ok = (len(codes) == n_returned and all(re.fullmatch(r"(?:00|30|60|68)\d{4}", c) for c in codes))
    codes_unique = len(set(codes)) == n_returned
    gt = aware(d.get("generatedAt"))
    generated_age = (captured_at.astimezone(dt.timezone.utc) - gt).total_seconds() if gt else None
    sh = captured_at.astimezone(SH)
    minute = sh.hour * 60 + sh.minute
    continuous_window = sh.weekday() < 5 and (570 <= minute < 690 or 780 <= minute < 900)
    n_ok, n_total = d.get("listsOk"), d.get("listsTotal")
    complete_lists = (type(n_ok) is int and type(n_total) is int and n_total == 6
                      and n_ok == n_total and d.get("failures") == [])
    headers = dict(response_headers or {})
    cache_age_str = next((str(v) for k,v in headers.items() if k.lower()=="age"), None)
    cache_age = int(cache_age_str) if cache_age_str and cache_age_str.isdigit() else None
    checks = {
        "http_200": http_status == 200,
        "all_six_rank_lists": complete_lists,
        "candidate_count_respects_cap": count_consistent,
        "provider_universe_consistent": universe_consistent,
        "valid_candidate_codes": codes_ok,
        "unique_candidate_codes": codes_unique,
        "not_server_stale": d.get("serverStale") is False,
        "generated_recency_120s": generated_age is not None and -60 <= generated_age <= 120,
        "weekday_continuous_window": continuous_window,
        "quote_timestamp_verified": False,
        "exchange_holiday_verified": False,
        "original_model_buy_wait_captured": False,
        "broker_fill_verified": False,
    }
    raw_check_keys = ("http_200", "all_six_rank_lists", "candidate_count_respects_cap",
                      "provider_universe_consistent", "valid_candidate_codes",
                      "unique_candidate_codes", "not_server_stale")
    return {
        "schema": "ashare-rank-evidence-audit-v2",
        "source": SOURCE_URL,
        "capturedAt": captured_at.isoformat(),
        "httpStatus": http_status,
        "responseHeaders": headers,
        "cacheAgeSeconds": cache_age,
        "generatedAt": d.get("generatedAt"),
        "generatedAgeSeconds": generated_age,
        "rankListsOk": n_ok,
        "rankListsTotal": n_total,
        "failures": d.get("failures"),
        "universeProviderReported": universe,
        "candidateReported": n_reported,
        "candidateReturned": n_returned,
        "candidateApiCap": API_CANDIDATE_CAP,
        "providerFullUniverseCertified": False,
        "checks": checks,
        "rawRankArchiveComplete": all(checks[k] for k in raw_check_keys),
        "eligibleAsOriginalV10Backtest": False,
        "qualifiedForTradingSignal": False,
        "dataClass": "RAW_RANK_EVIDENCE_ONLY",
        "limitations": [
            "candidateCount may exceed capped returned 420 candidate rows",
            "ranked subset is not exchange-certified whole-market roster",
            "no per-stock quote timestamp, orderbook or trading-day calendar",
            "generatedAt denotes API processing, not stock-quote freshness",
            "no original browser-side BUY/WAIT, broker order or fill",
            "GITHUB_SHA identifies archival workflow, not production deployment",
        ],
    }


def capture(output_dir, now=None, opener=None):
    """Always write raw bytes + manifest, including transport/JSON failures."""
    out = pathlib.Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    started = dt.datetime.now(dt.timezone.utc)
    opener = opener or urllib.request.urlopen
    status, headers, raw, error = None, {}, b"", None
    req = urllib.request.Request(SOURCE_URL, headers={
        "User-Agent": "AShareQuant-Forward-Archive/2.0", "Accept": "application/json",
        "Cache-Control": "no-cache", "Pragma": "no-cache"})
    try:
        with opener(req, timeout=25) as resp:
            status = resp.status
            headers = {k: v for k, v in resp.headers.items()
                       if k.lower() in ("date", "age", "cache-control", "content-type", "etag")}
            raw = resp.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            error = "RESPONSE_TOO_LARGE"
    except urllib.error.HTTPError as exc:
        status = exc.code
        error = f"UPSTREAM_HTTP_{status}"
        raw = exc.read(MAX_BYTES + 1)
    except Exception as exc:
        error = f"{type(exc).__name__}: {str(exc)[:120]}"
    finished = now or dt.datetime.now(dt.timezone.utc)
    if finished.tzinfo is None:
        raise ValueError("now must be timezone-aware")
    raw = raw[:MAX_BYTES] if len(raw) > MAX_BYTES else raw
    (out / "rank_raw_response.bin").write_bytes(raw)
    try:
        payload = json.loads(raw) if error != "RESPONSE_TOO_LARGE" else None
    except (ValueError, UnicodeDecodeError):
        payload = None
        if not error:
            error = "INVALID_JSON"
    meta = audit(payload, finished, status, headers)
    if error:
        meta["rawRankArchiveComplete"] = False
    meta.update({
        "schema": "ashare-forward-rank-evidence-v2",
        "requestStartedAt": started.isoformat(),
        "requestFinishedAt": finished.isoformat(),
        "rawSha256": hashlib.sha256(raw).hexdigest(),
        "rawBytes": len(raw),
        "fetchError": error,
        "captureRepository": os.getenv("GITHUB_REPOSITORY", "unknown"),
        "captureWorkflowSha": os.getenv("GITHUB_SHA", "unknown"),
        "githubRunId": os.getenv("GITHUB_RUN_ID", "manual-local"),
        "githubRunAttempt": os.getenv("GITHUB_RUN_ATTEMPT", "1"),
    })
    (out / "manifest.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    summary = os.getenv("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(f"## Raw ranking evidence: {'PASS' if meta['rawRankArchiveComplete'] else 'FAIL'}\n\n")
            f.write(f"- {meta['candidateReturned']} delivered / {meta['candidateReported']} reported (420 cap)\n")
            f.write(f"- SHA256: `{meta['rawSha256']}`\n")
            f.write("- **NOT a trading signal or original V10 backtest.**\n")
    print(json.dumps({"rawRankArchiveComplete": meta["rawRankArchiveComplete"],
                      "candidateReturned": meta["candidateReturned"],
                      "candidateReported": meta["candidateReported"],
                      "rawSha256": meta["rawSha256"], "fetchError": error}, ensure_ascii=False))
    return meta


if __name__ == "__main__":
    m = capture(sys.argv[1] if len(sys.argv) > 1 else "forward-evidence")
    sys.exit(0 if m["rawRankArchiveComplete"] else 1)
