import test from 'node:test';
import assert from 'node:assert/strict';
import {rankV15Stage1Candidates,evaluateV15TopKForwardReturns} from '../research/v16/selection_backtest.js';

const dates=['2026-10-26','2026-10-27','2026-10-28','2026-10-29','2026-10-30','2026-11-02','2026-11-03'];
function rowsFor(dayIndex,{eventCode=null,partialCode=null}={}) {
  return Array.from({length:60},(_,i)=>{
    const code=String(600000+i).padStart(6,'0');
    let pct=dayIndex===0?1+(i%10)*0.1:1;
    if(eventCode===code&&dayIndex===1)pct=10;
    if(partialCode===code&&dayIndex===1)pct=null;
    return {
      code,name:'样本'+i,price:10+i/10,pct,amount:200000000+i*1000000,
      turn:5+i%10,mcap:5000000000+i*10000000,pct60:5+i/10,
      mainNet:10000000-i*10000,mainPct:20-i/10,industry:i%2?'半导体':'机械',
      specialTreatment:false
    };
  });
}
function makeSnapshots({eventCode='600000',partialFuture=false}={}) {
  return dates.map((tradeDate,index)=>({
    schema:'ashare-v16-daily-snapshot-v1',
    tradeDate,capturedAt:tradeDate+'T08:20:00.000Z',
    sourceScope:'full-market',
    quality:{qualifiedForReplay:!(partialFuture&&index===1)},
    market:{indices:[{key:'shanghai',changePct:0.8}]},
    stockRows:rowsFor(index,{eventCode,partialCode:partialFuture&&index===1?'600005':null})
  }));
}

test('V15 stage-one reconstruction creates deterministic Top10/30/50 from full-market rows',()=>{
  const result=rankV15Stage1Candidates(rowsFor(0),[{key:'shanghai',changePct:1.2}]);
  assert.equal(result.status,'AVAILABLE');
  assert.equal(result.sourceRows,60);
  assert.equal(result.rankedPoolCount,60);
  assert.equal(result.hardFilteredCount,60);
  assert.equal(result.candidates.length,60);
  assert.ok(result.candidates[0].stage1Score>result.candidates.at(-1).stage1Score);
  assert.equal(result.candidates[0].code,'600000');
  assert.ok(result.candidates[0].rankHits>=5);
});

test('V15 stage-one reconstruction excludes growth-board, ST and hard-filter failures',()=>{
  const rows=rowsFor(0);
  rows.push(
    {...rows[0],code:'300001',name:'创业板样本'},
    {...rows[0],code:'688001',name:'科创板样本'},
    {...rows[0],code:'600900',name:'*ST风险'},
    {...rows[0],code:'600901',name:'高价股',price:500},
    {...rows[0],code:'600902',name:'低成交额',amount:1000}
  );
  const result=rankV15Stage1Candidates(rows);
  const codes=new Set(result.candidates.map(row=>row.code));
  assert.equal(codes.has('300001'),false);
  assert.equal(codes.has('688001'),false);
  assert.equal(codes.has('600900'),false);
  assert.equal(codes.has('600901'),false);
  assert.equal(codes.has('600902'),false);
});

test('Top10/30/50 forward returns use only future daily observations and compound T+ horizons',()=>{
  const snapshots=makeSnapshots();
  const result=evaluateV15TopKForwardReturns({snapshots,asOf:'2026-11-03',minSignalDates:1});
  assert.equal(result.schema,'ashare-v16-v15-topk-forward-backtest-v1');
  assert.equal(result.uniqueTradeDates,7);
  assert.equal(result.eligibleSignalDates,7);
  assert.equal(result.aggregate.top10['T+1'].status,'MEASURABLE');
  assert.equal(result.aggregate.top30['T+3'].status,'MEASURABLE');
  assert.equal(result.aggregate.top50['T+5'].status,'MEASURABLE');
  assert.ok(result.aggregate.top10['T+1'].meanReturnPct>1);
  assert.ok(result.aggregate.top10['T+3'].meanReturnPct>3);
  assert.ok(result.aggregate.top10['T+5'].meanReturnPct>5);
  assert.equal(result.promotionEligible,false);
  assert.equal(result.metricsConvention.execution,'No order-book, auction, intraday fill, limit-lock or T+1 sellability simulation.');
});

test('near-limit-up proxy capture is measured against all future eligible constituents',()=>{
  const snapshots=makeSnapshots({eventCode:'600000'});
  const result=evaluateV15TopKForwardReturns({snapshots,asOf:'2026-11-03',minSignalDates:1});
  const metric=result.daily[0].topK.top10.horizons['T+1'];
  assert.equal(metric.nearLimitUpProxyEventCount,1);
  assert.equal(metric.nearLimitUpProxyCapturedCount,1);
  assert.equal(metric.nearLimitUpProxyCaptureRate,1);
  assert.equal(metric.limitLabelQuality,'APPROXIMATE_PROXY');
});

test('as-of cutoff excludes later snapshots from both signal and outcome history',()=>{
  const result=evaluateV15TopKForwardReturns({snapshots:makeSnapshots(),asOf:'2026-10-28',minSignalDates:1});
  assert.equal(result.asOf,'2026-10-28');
  assert.equal(result.uniqueTradeDates,3);
  assert.equal(result.daily.at(-1).tradeDate,'2026-10-28');
  assert.equal(result.aggregate.top10['T+1'].signalDateCount,2);
});

test('missing weekday snapshots are labelled calendar gaps rather than false T+1 observations',()=>{
  const snapshots=makeSnapshots().filter(row=>row.tradeDate!=='2026-10-27');
  const result=evaluateV15TopKForwardReturns({snapshots,asOf:'2026-11-03',minSignalDates:1});
  assert.equal(result.daily[0].topK.top10.horizons['T+1'].status,'CALENDAR_GAP');
});

test('unqualified future snapshots are not used as outcome labels',()=>{
  const snapshots=makeSnapshots({partialFuture:true});
  const result=evaluateV15TopKForwardReturns({snapshots,asOf:'2026-11-03',minSignalDates:1});
  assert.equal(result.daily[0].topK.top10.horizons['T+1'].status,'DATA_GAP');
});

test('future outcome mutations cannot change the signal-date candidate ranking',()=>{
  const original=makeSnapshots();
  const changed=makeSnapshots();
  changed[6].stockRows=changed[6].stockRows.map(row=>({...row,pct:-9,mainNet:-999999999}));
  const a=evaluateV15TopKForwardReturns({snapshots:original,asOf:'2026-11-03',minSignalDates:1});
  const b=evaluateV15TopKForwardReturns({snapshots:changed,asOf:'2026-11-03',minSignalDates:1});
  assert.deepEqual(a.daily[0].topK.top10.top,b.daily[0].topK.top10.top);
});
