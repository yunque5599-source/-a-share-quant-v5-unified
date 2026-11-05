"""Manifest and raw-response tamper / consistency regression tests; no web access."""
import datetime as dt
import hashlib
import json
import pathlib
import tempfile
import unittest
import io
from research import forward_capture as fc
from research import verify_capture as vc

NOW = dt.datetime(2026, 10, 8, 2, 15, tzinfo=dt.timezone.utc)


def payload():
    return {'data':{'generatedAt':'2026-10-08T02:14:59Z','listsOk':6,'listsTotal':6,
                    'failures':[],'serverStale':False,'universeTotal':5920,
                    'candidateCount':2,'candidates':[{'f12':'600707'},{'f12':'002436'}]}}


class VerifyTests(unittest.TestCase):
    def fixture(self, td, data=None, failed=None):
        directory = pathlib.Path(td)
        obj = payload() if data is None else data
        raw = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        meta = fc.audit(obj, NOW, 200, {'Date':'Thu, 08 Oct 2026 02:15:00 GMT','Age':'0'})
        if failed is not None:
            meta['rawRankArchiveComplete'] = False
        meta.update(schema=vc.MANIFEST_SCHEMA,
                    requestStartedAt=(NOW-dt.timedelta(seconds=3)).isoformat(),
                    requestFinishedAt=NOW.isoformat(),
                    rawSha256=hashlib.sha256(raw).hexdigest(), rawBytes=len(raw),
                    fetchError=failed, captureRepository='test/repo',
                    captureWorkflowSha='a'*40, githubRunId='42', githubRunAttempt='1')
        (directory/'rank_raw_response.bin').write_bytes(raw)
        (directory/'manifest.json').write_text(json.dumps(meta),encoding='utf-8')
        return directory, meta, raw

    def test_valid_pair_integrity_only_not_trade_signal(self):
        with tempfile.TemporaryDirectory() as td:
            path,_,_=self.fixture(td)
            x=vc.verify(path)
            self.assertTrue(x['integrityVerified'])
            self.assertTrue(x['rankArchiveResearchUsable'])
            self.assertFalse(x['qualifiedForTradingSignal'])
            self.assertFalse(x['originalModelBuyWaitRecovered'])

    def test_tampered_raw_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            path,_,raw=self.fixture(td)
            (path/'rank_raw_response.bin').write_bytes(raw+b'\n')
            x=vc.verify(path)
            self.assertFalse(x['integrityVerified'])
            self.assertIn('sha256_matches',x['failures'])

    def test_forged_candidate_count_even_with_rehashed_raw_is_detected(self):
        with tempfile.TemporaryDirectory() as td:
            path,meta,raw=self.fixture(td)
            obj=json.loads(raw);obj['data']['candidateCount']=500
            altered=json.dumps(obj).encode()
            (path/'rank_raw_response.bin').write_bytes(altered)
            meta['rawSha256']=hashlib.sha256(altered).hexdigest()
            meta['rawBytes']=len(altered)
            (path/'manifest.json').write_text(json.dumps(meta))
            x=vc.verify(path)
            self.assertFalse(x['integrityVerified'])
            self.assertIn('derived_fields_match_original_raw',x['failures'])

    def test_forged_trade_signal_flag_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            path,meta,_=self.fixture(td)
            meta['qualifiedForTradingSignal']=True
            (path/'manifest.json').write_text(json.dumps(meta))
            self.assertIn('raw_evidence_only',vc.verify(path)['failures'])

    def test_reversed_capture_clock_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            path,meta,_=self.fixture(td)
            meta['requestStartedAt']=(NOW+dt.timedelta(minutes=1)).isoformat()
            (path/'manifest.json').write_text(json.dumps(meta))
            self.assertIn('capture_time_order',vc.verify(path)['failures'])

    def test_missing_raw_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            path,_,_=self.fixture(td)
            (path/'rank_raw_response.bin').unlink()
            self.assertIn('raw_present',vc.verify(path)['failures'])

    def test_stale_or_incomplete_archive_not_promoted(self):
        with tempfile.TemporaryDirectory() as td:
            obj=payload();obj['data']['listsOk']=2
            path,_,_=self.fixture(td,data=obj)
            r=vc.verify(path)
            # Files may be internally intact while a provider response is bad.
            self.assertTrue(r['integrityVerified'])
            self.assertFalse(r['rankArchiveResearchUsable'])

    def test_correctly_recorded_transport_failure_preserves_integrity_not_usability(self):
        with tempfile.TemporaryDirectory() as td:
            path,meta,_=self.fixture(td,failed='UPSTREAM_HTTP_502')
            x=vc.verify(path)
            self.assertTrue(x['integrityVerified'])
            self.assertFalse(x['rankArchiveResearchUsable'])

    def test_missing_manifest_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            path,_,_=self.fixture(td)
            (path/'manifest.json').unlink()
            self.assertIn('manifest_json_object',vc.verify(path)['failures'])

    def test_actual_capture_outputs_are_offline_verifiable(self):
        class Response:
            status=200
            headers={'Age':'0'}
            def __init__(self, raw):self.handle=io.BytesIO(raw)
            def __enter__(self):return self
            def __exit__(self,*a):pass
            def read(self,n):return self.handle.read(n)
        with tempfile.TemporaryDirectory() as td:
            body=json.dumps(payload()).encode()
            fc.capture(td,opener=lambda *a,**k:Response(body))
            result=vc.verify(td)
            self.assertTrue(result['integrityVerified'])
            self.assertTrue(result['rankArchiveResearchUsable'])

    def test_transport_failure_capture_is_intact_but_not_usable(self):
        with tempfile.TemporaryDirectory() as td:
            fc.capture(td,opener=lambda *a,**k:(_ for _ in ()).throw(OSError('offline')))
            result=vc.verify(td)
            self.assertTrue(result['integrityVerified'])
            self.assertFalse(result['rankArchiveResearchUsable'])

    def test_manifest_status_tampering_detected(self):
        with tempfile.TemporaryDirectory() as td:
            path,meta,_=self.fixture(td)
            meta['httpStatus']=500
            (path/'manifest.json').write_text(json.dumps(meta))
            self.assertIn('derived_fields_match_original_raw',vc.verify(path)['failures'])


if __name__=='__main__':
    unittest.main()
