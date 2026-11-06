import test from 'node:test';
import assert from 'node:assert/strict';
import {buildV16DailySnapshot} from '../research/v16/snapshot_archive.js';

function context({full=true,close=true,sameDate=true,coverage=1,rows=500}={}) {
  const quoteAt=sameDate?'2026-11-06T07:00:00.000Z':'2026-11-05T07:00:00.000Z';
  return {
    schema:'ashare-v16-market-context-v1',
    capturedAt:'2026-11-06T08:20:00.000Z',
    chinaCalendarDate:'2026-11-06',
    chinaCloseFinalized:close,
    aShareSessionDate:'2026-11-06',
    aShare:{
      indices:[{key:'shanghai',changePct:0.8}],
      breadth:{universe:full?'full-market':'partial-market',fullMarket:full,coverage,totalReported:rows,uniqueSymbols:rows},
      turnover:{amountCny:1000000000},
      sentiment:{limitUpCount:10},
      sectors:[],leaders:[],narrativeStocks:[],
      dataStatus:close?'FINALIZED_SESSION':'INTRADAY_PROVISIONAL',
      source:{provider:'Eastmoney',complete:full,total:rows,uniqueSymbols:rows,pagesFetched:10,pageCount:10,collectionStartedAt:'2026-11-06T07:50:00.000Z',collectionFinishedAt:'2026-11-06T08:15:00.000Z'},
      stockRows:Array.from({length:rows},(_,i)=>({
        code:String(600000+i).padStart(6,'0'),name:'样本'+i,price:10,pct:1,amount:200000000,
        turn:5,mcap:5000000000,pct60:4,mainNet:1000000,mainPct:5,industry:'半导体',
        open:9.9,high:10.1,low:9.8,prevClose:9.9,quoteAt,specialTreatment:false,mainBoard:true
      }))
    },
    us:{asOf:'2026-11-05'}
  };
}

test('daily archive snapshot qualifies only with finalized same-date full-market evidence',()=>{
  const result=buildV16DailySnapshot(context());
  assert.equal(result.schema,'ashare-v16-daily-snapshot-v1');
  assert.equal(result.tradeDate,'2026-11-06');
  assert.equal(result.sourceScope,'full-market');
  assert.equal(result.quality.qualifiedForReplay,true);
  assert.equal(result.quality.status,'QUALIFIED');
  assert.equal(result.quality.quoteTimestampCoverage,1);
  assert.equal(result.quality.sameDateQuoteRatio,1);
  assert.equal(result.stockRows.length,500);
  assert.equal(result.strategies.v15Stage1Top10.length,10);
  assert.equal(result.strategies.v15Stage1Top30.length,30);
  assert.equal(result.strategies.v15Stage1Top50.length,50);
  assert.equal(result.quality.notAtomicSnapshot,true);
});

test('partial universe is archived as diagnostic data but not qualified for replay',()=>{
  const result=buildV16DailySnapshot(context({full:false,coverage:0.7}));
  assert.equal(result.quality.qualifiedForReplay,false);
  assert.ok(result.quality.reasons.includes('universe-not-full-market'));
  assert.ok(result.quality.reasons.includes('universe-coverage-below-99pct'));
});

test('provisional intraday snapshot cannot be used as a daily close signal',()=>{
  const result=buildV16DailySnapshot(context({close:false}));
  assert.equal(result.quality.qualifiedForReplay,false);
  assert.ok(result.quality.reasons.includes('market-close-not-finalized'));
});

test('stale-date quote timestamps fail the point-in-time quality gate',()=>{
  const result=buildV16DailySnapshot(context({sameDate:false}));
  assert.equal(result.quality.qualifiedForReplay,false);
  assert.ok(result.quality.reasons.includes('same-date-quote-coverage-below-95pct'));
});
