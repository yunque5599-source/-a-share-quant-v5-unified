import datetime as dt
import hashlib
import importlib.util
import io
import json
import pathlib
import tempfile
import unittest

MOD=pathlib.Path(__file__).resolve().parents[1]/'research'/'forward_capture.py'
sp=importlib.util.spec_from_file_location('forward_capture', MOD)
m=importlib.util.module_from_spec(sp);sp.loader.exec_module(m)
NOW=dt.datetime(2026,10,8,2,15,tzinfo=dt.timezone.utc)

class FakeResponse:
    status=200
    headers={'Date':'Thu, 08 Oct 2026 02:15:00 GMT','Age':'0'}
    def __init__(self,p):self.raw=json.dumps(p).encode();self.io=io.BytesIO(self.raw)
    def __enter__(self):return self
    def __exit__(self,*args):pass
    def read(self,n):return self.io.read(n)

class Tests(unittest.TestCase):
    def payload(self, rows=None, count=None, **kw):
        if rows is None: rows=[{'f12':'600707'},{'f12':'002436'}]
        d={'generatedAt':'2026-10-08T02:14:59Z', 'listsOk':6,'listsTotal':6,
           'failures':[],'serverStale':False,'universeTotal':5920,
           'candidateCount':len(rows) if count is None else count,'candidates':rows}
        d.update(kw);return {'data':d}
    def test_good_source_never_signal(self):
        with tempfile.TemporaryDirectory() as td:
            p=self.payload();o=m.capture(td,now=NOW,opener=lambda *a,**k:FakeResponse(p))
            self.assertTrue(o['rawRankArchiveComplete']);self.assertFalse(o['qualifiedForTradingSignal'])
            b=(pathlib.Path(td)/'rank_raw_response.bin').read_bytes()
            self.assertEqual(o['rawSha256'],hashlib.sha256(b).hexdigest())
            self.assertTrue((pathlib.Path(td)/'manifest.json').exists())
    def test_real_api_cap_at_420_passes(self):
        rows=[{'f12':f'60{i:04d}'} for i in range(420)]
        a=m.audit(self.payload(rows,count=501),NOW,200)
        self.assertTrue(a['rawRankArchiveComplete'])
        self.assertEqual(a['candidateReturned'],420)
        self.assertEqual(a['candidateReported'],501)
    def test_unexplained_truncation_is_failure(self):
        self.assertFalse(m.audit(self.payload(count=300),NOW,200)['rawRankArchiveComplete'])
    def test_universe_less_than_candidate_count_fails(self):
        self.assertFalse(m.audit(self.payload(universeTotal=1),NOW,200)['rawRankArchiveComplete'])
    def test_partial_rank_lists_fail(self):
        self.assertFalse(m.audit(self.payload(listsOk=5,failures=['timeout']),NOW,200)['rawRankArchiveComplete'])
    def test_duplicate_codes_fail(self):
        self.assertFalse(m.audit(self.payload(rows=[{'f12':'600707'},{'f12':'600707'}]),NOW,200)['rawRankArchiveComplete'])
    def test_bad_codes_fail(self):
        self.assertFalse(m.audit(self.payload(rows=[{'f12':'INVALID'}]),NOW,200)['rawRankArchiveComplete'])
    def test_weekend_is_not_trading_qualification(self):
        a=m.audit(self.payload(),dt.datetime(2026,10,10,2,15,tzinfo=dt.timezone.utc),200)
        self.assertFalse(a['checks']['weekday_continuous_window'])
        self.assertTrue(a['rawRankArchiveComplete'])
        self.assertFalse(a['qualifiedForTradingSignal'])
    def test_weekday_server_generated_time_not_quote_time(self):
        a=m.audit(self.payload(),NOW,200)
        self.assertTrue(a['checks']['generated_recency_120s'])
        self.assertFalse(a['checks']['quote_timestamp_verified'])
    def test_transport_failure_preserves_hash(self):
        with tempfile.TemporaryDirectory() as td:
            def fails(*a,**kw):raise OSError('offline')
            a=m.capture(td,now=NOW,opener=fails)
            self.assertFalse(a['rawRankArchiveComplete'])
            self.assertEqual(a['rawSha256'],hashlib.sha256(b'').hexdigest())
            self.assertEqual(a['rawBytes'],0)
            self.assertTrue((pathlib.Path(td)/'manifest.json').exists())
    def test_naive_time_rejected(self):
        self.assertIsNone(m.aware('2026-10-08T10:15:00'))
    def test_empty_candidates_fail(self):
        self.assertFalse(m.audit(self.payload(rows=[]),NOW,200)['rawRankArchiveComplete'])

if __name__=='__main__':unittest.main()
