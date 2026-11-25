import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSealClock,
  scoreLimitUpDailyProxy,
  evaluateLimitUpQuality,
  evaluateIntradaySealQuality,
  evaluateOrderBookCancellationRisk,
  evaluateNextSessionContinuation
} from '../research/v16/limit_up_quality.js';

const DATE='2026-11-25';
const AS_OF='2026-11-25T15:10:00+08:00';
const breadth={universe:'full-market',fullMarket:true,upRatio:0.65,up:3500,down:1800,flat:100};

test('seal clock parser handles Eastmoney HHMMSS and rejects lunch/out-of-session values',()=>{
  assert.equal(parseSealClock(93000),570);
  assert.equal(parseSealClock('09:35:00'),575);
  assert.equal(parseSealClock(145000),890);
  assert.equal(parseSealClock('12:00:00'),null);
  assert.equal(parseSealClock('16:00:00'),null);
});

test('early stable seal with no reported reopen receives a positive daily proxy classification',()=>{
  const result=scoreLimitUpDailyProxy({
    code:'600001',name:'稳定封板样本',firstSeal:93000,lastSeal:93000,
    breakTimes:0,turnoverPct:8,sealFundCny:10000000,amountCny:100000000,limitDays:1
  },{tradeDate:DATE,sourceStatus:'AVAILABLE',marketBreadth:breadth});
  assert.equal(result.status,'AVAILABLE');
  assert.equal(result.classification,'PROXY_STABLE');
  assert.equal(result.dailyProxyScore,80);
  assert.ok(result.supportFlags.includes('NO_REPORTED_REOPEN'));
  assert.equal(result.calibration,'NOT_CALIBRATED');
  assert.equal(result.intradayStatus,'NOT_MEASURABLE');
  assert.equal(result.nextSessionFollowThroughStatus,'NOT_MEASURABLE');
});

test('late first seal and repeated reopens are flagged as high vendor-proxy risk',()=>{
  const result=scoreLimitUpDailyProxy({
    code:'600002',name:'反复开板样本',firstSeal:145000,lastSeal:145500,
    breakTimes:3,turnoverPct:28,sealFundCny:1000000,amountCny:50000000,limitDays:3
  },{tradeDate:DATE,sourceStatus:'AVAILABLE',marketBreadth:{...breadth,upRatio:0.35}});
  assert.equal(result.classification,'PROXY_RISKY');
  assert.equal(result.dailyProxyScore,15);
  for(const flag of ['FREQUENT_REOPENS','LATE_FIRST_SEAL_AFTER_14_30','HIGH_TURNOVER_REQUIRES_CONTEXT','MULTI_BOARD_EXTENSION_RISK','WEAK_FULL_MARKET_BREADTH'])
    assert.ok(result.riskFlags.includes(flag));
});

test('missing first-seal or reopen count remains partial rather than being imputed',()=>{
  const result=scoreLimitUpDailyProxy({code:'600003',firstSeal:null,breakTimes:null},
    {tradeDate:DATE,sourceStatus:'AVAILABLE',marketBreadth:breadth});
  assert.equal(result.status,'PARTIAL');
  assert.equal(result.dailyProxyScore,null);
  assert.equal(result.classification,'UNCLASSIFIED');
});

test('limit-up pool summary preserves source coverage and never invents intraday or next-session evidence',()=>{
  const result=evaluateLimitUpQuality({
    tradeDate:DATE,marketBreadth:breadth,
    limitPools:{
      status:'PARTIAL',
      sourceStatus:{limitUp:'AVAILABLE',broken:'NOT_MEASURABLE'},
      limitUp:[{code:'600001',name:'样本',firstSeal:93000,breakTimes:0}],
      broken:[]
    }
  });
  assert.equal(result.status,'AVAILABLE');
  assert.equal(result.limitUpCount,1);
  assert.equal(result.brokenBoardCount,null);
  assert.equal(result.rows[0].classification,'PROXY_STABLE');
  assert.equal(result.intradayStatus,'NOT_MEASURABLE');
  assert.equal(result.orderBookCancellationStatus,'NOT_MEASURABLE');
  assert.equal(result.nextSessionFollowThroughStatus,'NOT_MEASURABLE');
  const missing=evaluateLimitUpQuality({tradeDate:DATE,limitPools:{status:'PARTIAL'}});
  assert.equal(missing.status,'NOT_MEASURABLE');
});

test('intraday seal quality requires complete timestamped minute evidence',()=>{
  const evidence={
    source:'minute-feed-fixture',availableAt:AS_OF,firstSealAt:'2026-11-25T09:35:00+08:00',
    coverage:{expectedBars:240,observedBars:240,complete:true},
    reopenCount:1,sealedSeconds:10000,observedSeconds:15000,medianResealSeconds:45,
    evidenceLevel:'MINUTE_BAR_PROXY'
  };
  const result=evaluateIntradaySealQuality(evidence,AS_OF);
  assert.equal(result.status,'AVAILABLE');
  assert.equal(result.coverage,1);
  assert.equal(result.reopenCount,1);
  assert.equal(result.evidenceLevel,'MINUTE_BAR_PROXY');
  assert.equal(evaluateIntradaySealQuality({...evidence,coverage:{...evidence.coverage,observedBars:100}},AS_OF).status,'PARTIAL');
  assert.equal(evaluateIntradaySealQuality({...evidence,availableAt:'2026-11-26T09:00:00+08:00'},AS_OF).status,'NOT_MEASURABLE');
});

test('order-book cancellation risk is measurable only from complete event-flow coverage',()=>{
  const evidence={
    source:'level2-event-fixture',availableAt:AS_OF,coverageComplete:true,
    addedBidCny:100000000,cancelledBidCny:70000000,executedBidCny:20000000
  };
  const result=evaluateOrderBookCancellationRisk(evidence,AS_OF);
  assert.equal(result.status,'AVAILABLE');
  assert.equal(result.cancelRatio,0.7);
  assert.equal(result.riskClass,'HIGH');
  assert.equal(evaluateOrderBookCancellationRisk({...evidence,cancelledBidCny:120000000},AS_OF).status,'PARTIAL');
});

test('next-session follow-through is a post-open confirmation, not a prior-close prediction',()=>{
  const result=evaluateNextSessionContinuation({
    signalDate:DATE,signalClose:10,asOf:'2026-11-26T09:46:00+08:00',
    nextSession:{
      tradeDate:'2026-11-26',
      auction:{open:10.3},
      first15m:{
        source:'minute-feed-fixture',availableAt:'2026-11-26T09:45:00+08:00',
        open:10.3,close:10.5,vwap:10.4,
        coverage:{expectedBars:15,observedBars:15,complete:true}
      }
    },
    marketFirst15m:{returnPct:0.2,availableAt:'2026-11-26T09:45:00+08:00'},
    sectorFirst15m:{returnPct:0.4,availableAt:'2026-11-26T09:45:00+08:00'}
  });
  assert.equal(result.status,'AVAILABLE');
  assert.equal(result.classification,'STRONG_FOLLOW_THROUGH');
  assert.equal(result.forecastConvention,'POST_OPEN_CONFIRMATION_NOT_PREVIOUS_CLOSE_PREDICTION');
  const missing=evaluateNextSessionContinuation({signalDate:DATE,signalClose:10,asOf:'2026-11-26T09:46:00+08:00'});
  assert.equal(missing.status,'NOT_MEASURABLE');
});
