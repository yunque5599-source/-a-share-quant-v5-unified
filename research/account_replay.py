#!/usr/bin/env python3
"""Conservative as-of account replay for explicit frozen signals; never derives signals from future prices.

Limitations: daily bar next-session OPEN execution is hypothetical, not a broker fill;
no intraday stop/take-profit simulation and no order-book/auction priority modeling.
"""
from __future__ import annotations
import argparse
import csv
import datetime as dt
import hashlib
import json
import math
import pathlib
import re
from collections import defaultdict
from zoneinfo import ZoneInfo

SH = ZoneInfo('Asia/Shanghai')
EXPECTED_SCHEMA = 'ashare-frozen-original-signal-v1'


def require(cond, reason):
    if not cond:
        raise ValueError(reason)


def decimal(value, label):
    try:
        z = float(value)
    except (ValueError, TypeError):
        raise ValueError(f'invalid {label}') from None
    require(z > 0 and z < 1e10 and z == z and abs(z) != float('inf'), f'invalid {label}')
    return z


def parse_stamp(value):
    try:
        z = dt.datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except ValueError:
        raise ValueError('invalid decisionAt timestamp') from None
    require(z.tzinfo is not None, 'decisionAt missing timezone')
    return z.astimezone(SH)


def parse_flag(value, label):
    require(str(value) in ('0', '1'), f'{label} must be explicit 0 or 1')
    return str(value) == '1'


def load_bars(path):
    """Bars must explicitly mark buyable/sellable; unknown exchange state is not assumed tradable."""
    bars, all_days = {}, set()
    with open(path, encoding='utf-8-sig', newline='') as f:
        rd = csv.DictReader(f)
        require(set(['date','code','open','high','low','close','buyable','sellable']).issubset(rd.fieldnames or []),
                'missing required bar columns')
        for x in rd:
            try:
                date = dt.date.fromisoformat(x['date'])
            except ValueError:
                raise ValueError('invalid bar date') from None
            code = x['code']
            require(bool(re.fullmatch(r'(?:00|60)\d{4}',code)), 'only A-share main-board bars allowed')
            key = (date, code)
            require(key not in bars, 'duplicate date/code bars')
            o,h,l,c = [decimal(x[k], k) for k in ('open','high','low','close')]
            require(l <= min(o,c) <= max(o,c) <= h, 'inconsistent OHLC')
            bars[key] = {'open':o,'high':h,'low':l,'close':c,
                         'buyable':parse_flag(x['buyable'],'buyable'),
                         'sellable':parse_flag(x['sellable'],'sellable')}
            all_days.add(date)
    require(len(all_days)>=2,'need >= 2 trading dates')
    return bars, sorted(all_days)


def load_signals(path, days, synthetic=False):
    """One independently frozen original decision per day; WAIT is an essential observation."""
    items = {}
    with open(path, encoding='utf-8') as f:
        for line in f:
            if not line.strip():
                continue
            x=json.loads(line)
            require(x.get('schema')==EXPECTED_SCHEMA,'wrong signal schema')
            if synthetic:
                require(x.get('evidenceLevel')=='SYNTHETIC_TEST','synthetic mode requires SYNTHETIC_TEST')
            else:
                require(x.get('evidenceLevel')=='ORIGINAL_MODEL_CAPTURE','not an original frozen model signal')
                require(bool(re.fullmatch(r'[0-9a-f]{64}',str(x.get('evidenceSha256','')))),
                        'missing original evidence SHA-256')
            when=parse_stamp(x['decisionAt'])
            day=when.date()
            require(day in days,'signal decision date missing in provided bar calendar')
            require(day not in items,'more than one decision on one day, unresolved conflict')
            require(x.get('action') in ('BUY','WAIT'),'only frozen BUY/WAIT allowed')
            if x['action']=='BUY':
                code=x.get('code','')
                require(bool(re.fullmatch(r'(?:00|60)\d{4}',code)), 'non main-board signal code')
                shares=x.get('shares')
                require(type(shares) is int and shares>=100 and shares%100==0,'shares must be 100-share lots')
                low,high=decimal(x.get('buyLow'), 'buyLow'),decimal(x.get('buyHigh'),'buyHigh')
                require(low<=high,'buyLow > buyHigh')
                x={**x,'buyLow':low,'buyHigh':high,'shares':shares}
            items[day]=x
    missing = [str(day) for day in days[:-1] if day not in items]
    require(not missing,'original BUY/WAIT missing for trading date(s): '+','.join(missing[:5]))
    return items


def buy_fees(notional, commission_rate=0.0003, transfer_rate=0.00001):
    return max(5.0, commission_rate * notional) + transfer_rate * notional


def sell_fees(notional, commission_rate=0.0003, transfer_rate=0.00001, stamp_rate=0.0005):
    return max(5.0, commission_rate * notional) + transfer_rate * notional + stamp_rate * notional


def replay(bars, days, signals, cash=80000.0, hold_sessions=3, slip_bps=5):
    """BUY submitted on day D only tries to execute at open of NEXT supplied session.

    Exit after hold_sessions starts at next-session open or later; no same-day selling.
    No optimistic fills when auction price outside buy band or exchange buy/sell permission unknown.
    """
    require(math.isfinite(cash) and cash>0,'cash must be finite and positive')
    require(hold_sessions>=1 and type(hold_sessions) is int,'hold_sessions must be >=1 integer')
    require(0<=slip_bps<=100,'slippage must be between 0 and 100 bps')
    initial_cash=float(cash)
    held={}
    log=[]
    equities=[]
    buys=[]
    for i, day in enumerate(days):
        # Sales first, never same-day; at least one full night held (T+1).
        for code,lot in list(held.items()):
            if i-lot['entryIndex']<hold_sessions:continue
            bar=bars.get((day,code))
            require(bar is not None,f'missing held-stock bar: {day} {code}')
            if not bar['sellable']:
                log.append({'date':str(day),'code':code,'event':'EXIT_BLOCKED','reason':'explicitly_not_sellable'})
                continue
            price=bar['open']*(1-slip_bps/10000)
            gross=price*lot['shares']; fee=sell_fees(gross)
            cash+=gross-fee
            log.append({'date':str(day),'code':code,'event':'SELL_SIMULATED_NEXT_OPEN',
                        'shares':lot['shares'],'price':round(price,4),'fees':round(fee,2),
                        'buyDate':str(lot['entryDate'])})
            del held[code]
        if i>0:
            prior=days[i-1]
            decision=signals[prior]
            if decision['action']=='WAIT':
                log.append({'date':str(day),'event':'WAIT','sourceDate':str(prior)})
            else:
                code=decision['code'];bar=bars.get((day,code))
                why=None
                if bar is None:why='missing_execution_day_bar'
                elif not bar['buyable']:why='explicitly_not_buyable'
                elif not decision['buyLow']<=bar['open']<=decision['buyHigh']:why='open_outside_frozen_buy_band'
                elif code in held:why='already_holding'
                else:
                    shares=decision['shares']
                    price=bar['open']*(1+slip_bps/10000)
                    gross=shares*price
                    fee=buy_fees(gross)
                    equity_at_open=cash+sum(lot['shares']*bars[(day,ticker)]['open'] for ticker,lot in held.items())
                    # Reject rather than clamp: a limit breach is not evidence of a fill.
                    if not decision['buyLow']<=price<=decision['buyHigh']:
                        why='slippage_outside_frozen_buy_band'
                    elif gross>0.35*equity_at_open:why='position_cap_35pct'
                    elif gross+sum(lot['shares']*bars[(day,ticker)]['open'] for ticker,lot in held.items())>0.70*equity_at_open:
                        why='total_exposure_cap_70pct'
                    elif gross+fee>cash:why='insufficient_cash'
                if why:
                    log.append({'date':str(day),'code':code,'event':'BUY_REJECTED','reason':why,'sourceDate':str(prior)})
                else:
                    cash-=gross+fee
                    held[code]={'entryDate':day,'entryIndex':i,'shares':shares,'entryPrice':price}
                    log.append({'date':str(day),'code':code,'event':'BUY_SIMULATED_NEXT_OPEN',
                                'shares':shares,'price':round(price,4),'fees':round(fee,2),'sourceDate':str(prior)})
                    buys.append(code)
        equity=cash
        for code,lot in held.items():
            bar=bars.get((day,code))
            require(bar is not None,f'missing close mark for holding: {day} {code}')
            equity+=bar['close']*lot['shares']
        equities.append({'date':str(day),'cash':round(cash,2),'equity':round(equity,2),
                         'heldSymbols':sorted(held.keys())})
    peak=initial_cash;max_dd=0.0
    for row in equities:
        peak=max(peak,row['equity'])
        max_dd=min(max_dd,row['equity']/peak-1)
    return {'schema':'ashare-hypothetical-next-open-replay-v1',
            'status':'HYPOTHETICAL_REPLAY_NOT_BROKER_VERIFIED',
            'initialCash':round(initial_cash,2),
            'endingEquity':equities[-1]['equity'],
            'netReturnPct':round((equities[-1]['equity']/initial_cash-1)*100,4),
            'maxDrawdownPct':round(max_dd*100,4),
            'fillAssumptions':'NEXT_SESSION_OPEN_PLUS_SLIPPAGE_IF_BUYABLE_AND_BOTH_PRICES_WITHIN_FROZEN_BAND',
            'riskAssumptions':'35% single name, 70% new-entry total exposure, 100-share lots, T+1, fixed hold days',
            'limitations':['not original V10 exit algorithm','no verified auction orderbook','no intraday stop execution',
                           'calendar from input bar dates','bar buyable/sellable fields require independent source validation',
                           'SHA proves integrity only, not independent historical timestamp attestation'],
            'simulatedBuys':len(buys),'equity':equities,'events':log}


def main():
    ap=argparse.ArgumentParser(description='Explicit original frozen BUY/WAIT next-open research replay')
    ap.add_argument('--signals',type=pathlib.Path)
    ap.add_argument('--bars',type=pathlib.Path)
    ap.add_argument('--output',type=pathlib.Path,default=pathlib.Path('research-replay.json'))
    ap.add_argument('--initial-cash',type=float,default=80000)
    ap.add_argument('--hold-sessions',type=int,default=3)
    ap.add_argument('--synthetic-test',action='store_true',help='ONLY for clearly fictional test inputs; not historical results')
    x=ap.parse_args()
    if not x.signals or not x.bars:
        result={'status':'NOT_MEASURABLE','reason':'frozen signals and date-aligned price bars required',
                'originalV10NetReturnPct':None}
        code=2
    else:
        try:
            bars,days=load_bars(x.bars)
            signals=load_signals(x.signals,days,synthetic=x.synthetic_test)
            result=replay(bars,days,signals,cash=x.initial_cash,hold_sessions=x.hold_sessions)
            result['sourceClass']='SYNTHETIC_TEST_NOT_REAL_PERFORMANCE' if x.synthetic_test else 'USER_SUPPLIED_ORIGINAL_SIGNAL_LOG_UNATTESTED'
            result['signalsFileSha256']=hashlib.sha256(x.signals.read_bytes()).hexdigest()
            result['barsFileSha256']=hashlib.sha256(x.bars.read_bytes()).hexdigest()
            code=0
        except (OSError, ValueError, KeyError, csv.Error, json.JSONDecodeError) as err:
            result={'status':'NOT_MEASURABLE','reason':str(err),'originalV10NetReturnPct':None}
            code=2
    x.output.parent.mkdir(parents=True,exist_ok=True)
    x.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({k:result.get(k) for k in ('status','netReturnPct','reason')},ensure_ascii=False))
    return code

if __name__=='__main__':raise SystemExit(main())
