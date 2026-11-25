import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateLimitUpQualityBacktest} from '../research/v16/limit_up_quality_backtest.js';

function nextWeekday(date) {
  const cursor=new Date(date+'T00:00:00Z');
  do { cursor.setUTCDate(cursor.getUTCDate()+1); } while(cursor.getUTCDay()===0||cursor.getUTCDay()===6);
  return cursor.toISOString().slice(0,10);
}
function makeSnapshot(date,index) {
  const stableClose=10+index*0.05;
  const riskyClose=20-index*0.05;
  const stockRows=[
    {code:'600001',name:'稳定代理样本',price:stableClose,open:stableClose*1.01,high:stableClose*1.06,low:stableClose*0.99},
    {code:'600002',name:'风险代理样本',price:riskyClose,open:riskyClose*0.99,high:riskyClose*1.01,low:riskyClose*0.90},
    {code:'600003',name:'炸板池样本',price:15,open:15,high:15.2,low:14.7}
  ];
  for(let i=0;i<497;i++)stockRows.push({
    code:String(100000+i).padStart(6,'0'),name:'其他'+i,price:10,open:10,high:10.1,low:9.9
  });
  return {
    schema:'ashare-v16-daily-snapshot-v1',tradeDate:date,capturedAt:date+'T15:10:00+08:00',
    sourceScope:'full-market',quality:{qualifiedForReplay:true,status:'QUALIFIED'},stockRows,
    market:{
      breadth:{universe:'full-market',fullMarket:true,upRatio:0.62,up:3500,down:1800,flat:100},
      limitPools:{
        status:'AVAILABLE',
        sourceStatus:{limitUp:'AVAILABLE',broken:'AVAILABLE',limitDown:'AVAILABLE'},
        limitUp:[
          {code:'600001',name:'稳定代理样本',firstSeal:93000,lastSeal:93000,breakTimes:0,price:stableClose},
          {code:'600002',name:'风险代理样本',firstSeal:145000,lastSeal:145500,breakTimes:3,price:riskyClose}
        ],
        broken:[{code:'600003',name:'炸板池样本',breakTimes:2,pct:7.5,turnoverPct:18}]
      }
    }
  };
}
function history(count=22) {
  const dates=['2026-01-05'];
  while(dates.length<count)dates.push(nextWeekday(dates.at(-1)));
  return dates.map((date,index)=>makeSnapshot(date,index));
}

test('limit-up proxy backtest separates stable and risky cohorts without future leakage',()=>{
  const snapshots=history(22);
  const report=evaluateLimitUpQualityBacktest({snapshots,asOf:snapshots.at(-1).tradeDate,minSignalDates:20,minSampleCoverage:0.95});
  assert.equal(report.status,'MEASURABLE');
  assert.equal(report.eligibleSignalDates,21);
  assert.equal(report.aggregate.PROXY_STABLE.status,'MEASURABLE');
  assert.equal(report.aggregate.PROXY_RISKY.status,'MEASURABLE');
  assert.ok(report.aggregate.PROXY_STABLE.meanCloseToClosePct>0);
  assert.ok(report.aggregate.PROXY_RISKY.meanCloseToClosePct<0);
  assert.equal(report.aggregate.BROKEN_POOL.candidateCount,21);
  assert.equal(report.promotionEligible,false);
  assert.equal(report.calibration,'NOT_CALIBRATED');
});

test('future snapshots beyond asOf are excluded from signal and outcome samples',()=>{
  const snapshots=history(23);
  const cutoff=snapshots[21].tradeDate;
  const report=evaluateLimitUpQualityBacktest({snapshots,asOf:cutoff,minSignalDates:1,minSampleCoverage:0.95});
  assert.equal(report.asOf,cutoff);
  assert.equal(report.eligibleSignalDates,21);
  assert.ok(report.aggregate.ALL_LIMIT_UP.candidateCount<=42);
});

test('partial or unqualified snapshots do not contribute to replay',()=>{
  const snapshots=history(3);
  snapshots[0].quality.qualifiedForReplay=false;
  const report=evaluateLimitUpQualityBacktest({snapshots,minSignalDates:1});
  assert.equal(report.eligibleSignalDates,1);
  assert.equal(report.aggregate.ALL_LIMIT_UP.candidateCount,2);
});
