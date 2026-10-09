import datetime as dt
import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch

PATH=pathlib.Path(__file__).resolve().parents[1]/'research'/'account_replay.py'
sp=importlib.util.spec_from_file_location('account_replay',PATH)
m=importlib.util.module_from_spec(sp);sp.loader.exec_module(m)

class Tests(unittest.TestCase):
    DAYS=[dt.date(2026,10,i) for i in (8,9,12,13,14)]
    def fixture(self,buyable=True,sellable=True,opened=10):
        bars={}
        for i,day in enumerate(self.DAYS):
            op=opened if i==1 else (11 if i>=3 else 10)
            bars[(day,'600707')]={'open':op,'high':op,'low':op,'close':op,
                                  'buyable':buyable,'sellable':sellable}
        return bars
    def signals(self,buy=True):
        d={day:{'action':'WAIT'} for day in self.DAYS[:-1]}
        if buy:d[self.DAYS[0]]={'action':'BUY','code':'600707','shares':1000,'buyLow':9.5,'buyHigh':10.5}
        return d
    def test_time_locked_next_open_and_t_plus_one(self):
        out=m.replay(self.fixture(),self.DAYS,self.signals(),cash=80000,hold_sessions=2)
        buys=[x for x in out['events'] if x['event'].startswith('BUY_SIMULATED')]
        sells=[x for x in out['events'] if x['event'].startswith('SELL_SIMULATED')]
        self.assertEqual(buys[0]['date'],'2026-10-09')
        self.assertEqual(sells[0]['date'],'2026-10-13')
        self.assertGreater(out['netReturnPct'],0)
        self.assertEqual(out['status'],'HYPOTHETICAL_REPLAY_NOT_BROKER_VERIFIED')
    def test_no_trade_wait_days(self):
        out=m.replay(self.fixture(),self.DAYS,self.signals(False))
        self.assertEqual(out['netReturnPct'],0)
        self.assertEqual(out['simulatedBuys'],0)
    def test_missing_signal_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            p=pathlib.Path(td)/'s.jsonl'
            p.write_text(json.dumps({'schema':m.EXPECTED_SCHEMA,'evidenceLevel':'SYNTHETIC_TEST',
                                     'decisionAt':'2026-10-08T15:05:00+08:00','action':'WAIT'})+'\n')
            with self.assertRaisesRegex(ValueError,'missing for trading'):
                m.load_signals(p,self.DAYS,synthetic=True)
    def test_bad_real_provenance_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            p=pathlib.Path(td)/'s.jsonl'
            lines=[]
            for day in self.DAYS[:-1]:
                lines.append(json.dumps({'schema':m.EXPECTED_SCHEMA,'evidenceLevel':'SYNTHETIC_TEST',
                                          'decisionAt':day.isoformat()+'T15:00:00+08:00','action':'WAIT'}))
            p.write_text('\n'.join(lines)+'\n')
            with self.assertRaisesRegex(ValueError,'not an original'):
                m.load_signals(p,self.DAYS)
    def test_unbuyable_is_not_filled(self):
        out=m.replay(self.fixture(buyable=False),self.DAYS,self.signals())
        self.assertEqual(out['simulatedBuys'],0)
        self.assertIn('explicitly_not_buyable',[x.get('reason') for x in out['events']])
    def test_buy_band_is_enforced(self):
        out=m.replay(self.fixture(opened=12),self.DAYS,self.signals())
        self.assertEqual(out['simulatedBuys'],0)
    def test_sell_locked_cannot_mark_exit(self):
        out=m.replay(self.fixture(sellable=False),self.DAYS,self.signals(),hold_sessions=2)
        self.assertIn('EXIT_BLOCKED',[x['event'] for x in out['events']])
    def test_cash_and_position_limit_prevent_buy(self):
        s=self.signals();s[self.DAYS[0]]['shares']=3000
        out=m.replay(self.fixture(),self.DAYS,s,cash=80000)
        self.assertEqual(out['simulatedBuys'],0)
        self.assertIn('position_cap_35pct',[x.get('reason') for x in out['events']])
    def test_missing_bar_for_holding_fail_closed(self):
        b=self.fixture();del b[(self.DAYS[2],'600707')]
        with self.assertRaisesRegex(ValueError,'missing close mark'):
            m.replay(b,self.DAYS,self.signals())
    def test_missing_input_returns_unmeasurable(self):
        with tempfile.TemporaryDirectory() as td:
            outfile=pathlib.Path(td)/'result.json'
            with patch('sys.argv',['replay','--output',str(outfile)]):
                self.assertEqual(m.main(),2)
            self.assertIsNone(json.loads(outfile.read_text())['originalV10NetReturnPct'])
    def test_fee_not_zero(self):
        self.assertGreater(m.buy_fees(1000),0)
        self.assertGreater(m.sell_fees(1000),m.buy_fees(1000))
    def test_missing_boolean_tradability_rejected(self):
        with self.assertRaises(ValueError):m.parse_flag('', 'buyable')

    def test_slippage_cannot_cross_frozen_limit(self):
        for opening in (10.5, 10.499):
            with self.subTest(opening=opening):
                out=m.replay(self.fixture(opened=opening),self.DAYS,self.signals())
                self.assertEqual(out['simulatedBuys'],0)
                self.assertIn('slippage_outside_frozen_buy_band',[x.get('reason') for x in out['events']])
                self.assertEqual(out['equity'][1]['cash'],80000)
                self.assertEqual(out['equity'][1]['heldSymbols'],[])

    def test_zero_slippage_exact_limit_is_allowed(self):
        out=m.replay(self.fixture(opened=10.5),self.DAYS,self.signals(),slip_bps=0)
        self.assertEqual(out['simulatedBuys'],1)
        buy=next(x for x in out['events'] if x['event']=='BUY_SIMULATED_NEXT_OPEN')
        self.assertEqual(buy['price'],10.5)

    def test_slippage_exact_limit_and_cash_accounting(self):
        signals=self.signals()
        signals[self.DAYS[0]]['buyHigh']=10*(1+5/10000)
        out=m.replay(self.fixture(),self.DAYS,signals)
        buy=next(x for x in out['events'] if x['event']=='BUY_SIMULATED_NEXT_OPEN')
        self.assertEqual(buy['price'],10.005)
        self.assertEqual(out['equity'][1]['cash'],round(80000-10005-m.buy_fees(10005),2))

    def test_slippage_does_not_rescue_open_below_band(self):
        out=m.replay(self.fixture(opened=9.499),self.DAYS,self.signals())
        self.assertEqual(out['simulatedBuys'],0)
        self.assertIn('open_outside_frozen_buy_band',[x.get('reason') for x in out['events']])

    def test_duplicate_and_inconsistent_bars_rejected(self):
        header='date,code,open,high,low,close,buyable,sellable\n'
        good='2026-10-08,600707,10,10,10,10,1,1\n'
        for rows, reason in ((good+good,'duplicate'),('2026-10-08,600707,10,9,10,10,1,1\n','inconsistent OHLC')):
            with self.subTest(reason=reason), tempfile.TemporaryDirectory() as td:
                p=pathlib.Path(td)/'bars.csv';p.write_text(header+rows)
                with self.assertRaisesRegex(ValueError,reason):m.load_bars(p)

    def test_duplicate_signal_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            p=pathlib.Path(td)/'signals.jsonl'
            line=json.dumps({'schema':m.EXPECTED_SCHEMA,'evidenceLevel':'SYNTHETIC_TEST',
                             'decisionAt':'2026-10-08T15:05:00+08:00','action':'WAIT'})+'\n'
            p.write_text(line+line)
            with self.assertRaisesRegex(ValueError,'more than one decision'):m.load_signals(p,self.DAYS,synthetic=True)

    def test_missing_file_fail_closed(self):
        with tempfile.TemporaryDirectory() as td:
            out=pathlib.Path(td)/'result.json'
            with patch('sys.argv',['replay','--bars',str(pathlib.Path(td)/'missing.csv'),'--signals','missing.jsonl','--output',str(out)]):
                self.assertEqual(m.main(),2)
            result=json.loads(out.read_text())
            self.assertEqual(result['status'],'NOT_MEASURABLE')
            self.assertIsNone(result['originalV10NetReturnPct'])

    def test_nonfinite_cash_rejected(self):
        for cash in (float('inf'),float('nan')):
            with self.assertRaisesRegex(ValueError,'finite'):m.replay(self.fixture(),self.DAYS,self.signals(),cash=cash)

if __name__=='__main__':unittest.main()
