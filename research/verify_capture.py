#!/usr/bin/env python3
"""Offline consistency verifier for the V10.3.8 raw ranking capture pair.

SHA-256 ties the local raw file to its local manifest. It is not a digital
signature, immutable ledger, trusted timestamp, or model BUY/WAIT signal.
No network request, broker execution, or model inference occurs here.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import pathlib
import re

try:
    from .forward_capture import MAX_BYTES, audit, aware
except ImportError:  # direct CLI execution from research/
    from forward_capture import MAX_BYTES, audit, aware

MANIFEST_SCHEMA = 'ashare-forward-rank-evidence-v2'
REQUIRED_RAW = 'rank_raw_response.bin'
REQUIRED_MANIFEST = 'manifest.json'


def verify(directory):
    path = pathlib.Path(directory)
    checks = {}
    issues = []
    manifest, raw = None, None

    def check(label, valid):
        checks[label] = bool(valid)
        if not valid:
            issues.append(label)

    try:
        raw = (path / REQUIRED_RAW).read_bytes()
    except OSError:
        raw = None
    try:
        manifest = json.loads((path / REQUIRED_MANIFEST).read_text(encoding='utf-8'))
    except (OSError, ValueError, UnicodeDecodeError):
        manifest = None

    check('raw_present', raw is not None)
    check('manifest_json_object', isinstance(manifest, dict))
    if raw is None or not isinstance(manifest, dict):
        return outcome(checks, issues, False)

    check('manifest_schema', manifest.get('schema') == MANIFEST_SCHEMA)
    check('raw_size_within_limit', len(raw) <= MAX_BYTES)
    check('raw_bytes_match', type(manifest.get('rawBytes')) is int and manifest['rawBytes'] == len(raw))
    check('sha256_matches',
          isinstance(manifest.get('rawSha256'), str)
          and bool(re.fullmatch(r'[0-9a-f]{64}', manifest['rawSha256']))
          and hashlib.sha256(raw).hexdigest() == manifest['rawSha256'])

    captured = aware(manifest.get('capturedAt'))
    started = aware(manifest.get('requestStartedAt'))
    finished = aware(manifest.get('requestFinishedAt'))
    check('timezone_aware_timestamps', all(x is not None for x in (captured, started, finished)))
    check('capture_time_order',
          captured is not None and started is not None and finished is not None
          and started <= finished and finished == captured and (finished-started).total_seconds() <= 180)

    status = manifest.get('httpStatus')
    headers = manifest.get('responseHeaders')
    check('http_status_type', status is None or (type(status) is int and 100 <= status <= 599))
    check('response_headers_dict', isinstance(headers, dict) and all(isinstance(k, str) and isinstance(v, str)
                                                                      for k,v in headers.items()))
    fetch_error = manifest.get('fetchError')
    check('fetch_error_type', fetch_error is None or (isinstance(fetch_error,str) and bool(fetch_error)))
    check('raw_evidence_only',
          manifest.get('dataClass') == 'RAW_RANK_EVIDENCE_ONLY'
          and manifest.get('eligibleAsOriginalV10Backtest') is False
          and manifest.get('qualifiedForTradingSignal') is False)

    try:
        payload = json.loads(raw)
        parsed = True
    except (ValueError, UnicodeDecodeError):
        payload, parsed = None, False
    check('invalid_json_disclosed', parsed or fetch_error in ('INVALID_JSON','RESPONSE_TOO_LARGE')
          or (isinstance(fetch_error,str) and fetch_error.startswith('UPSTREAM_HTTP_'))
          or bool(fetch_error))

    if captured is not None and checks['http_status_type'] and checks['response_headers_dict']:
        expected = audit(payload, captured, status, headers)
        # The capture script deliberately overrides the structural status on an
        # upstream transport failure. Check that override rather than accepting
        # any user edited quality summary.
        if fetch_error:
            expected['rawRankArchiveComplete'] = False
        expected['schema'] = MANIFEST_SCHEMA
        derived_match = all(manifest.get(k) == v for k,v in expected.items())
    else:
        derived_match = False
    check('derived_fields_match_original_raw', derived_match)

    if not parsed and fetch_error is None:
        check('invalid_json_failure_recorded', False)
    if fetch_error is not None and manifest.get('rawRankArchiveComplete') is not False:
        check('failed_fetch_cannot_be_marked_complete', False)

    complete = not issues
    usable = complete and manifest.get('rawRankArchiveComplete') is True and fetch_error is None
    return outcome(checks, issues, usable)


def outcome(checks, issues, usable):
    return {
        'schema': 'ashare-offline-evidence-verification-v1',
        'integrityVerified': not issues,
        'rankArchiveResearchUsable': bool(usable),
        'originalModelBuyWaitRecovered': False,
        'qualifiedForTradingSignal': False,
        'evidenceClass': 'RAW_RANK_EVIDENCE_ONLY',
        'checks': checks,
        'failures': issues,
        'limitations': ['local hash and manifest can both be altered; no independently trusted timestamp',
                        'no independently verified per-symbol quote times',
                        'not an original V10 BUY/WAIT record or brokerage fill'],
    }


def main():
    parser = argparse.ArgumentParser(description='Verify captured raw ranking bytes and manifest offline')
    parser.add_argument('archive_dir', type=pathlib.Path)
    parser.add_argument('--output', type=pathlib.Path)
    args = parser.parse_args()
    result = verify(args.archive_dir)
    result_path = args.output or args.archive_dir / 'verification.json'
    result_path.parent.mkdir(parents=True, exist_ok=True)
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({k:result[k] for k in ('integrityVerified','rankArchiveResearchUsable','failures')}))
    # Incomplete source evidence never silently becomes a passing workflow.
    return 0 if result['rankArchiveResearchUsable'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
