import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateFlowLhbAblation} from '../research/v16/flow_lhb_backtest.js';

const dates=['2026-11-02','2026-11-03','2026-11-04','2026-11-05','2026-11-06','2026-11-09','2026-11-10','2026-11-11'];
function stockRows(dayIndex,{futureShock=false}={}) {
  return Array.from({length:500},(_,i)=>{
    const code=String(600000+i).padStart(6,'0');
    const price=10+i*0.01+dayIndex*0.02;
    const mainNet=i===20?50000000+(dayIndex>=0?dayIndex*1000000:0):10000000-i*1000;
    return {
      code,name:'样本'+i,price:futureShock&&dayIndex>=4?-5:price,
      open:dayIndex===0?price:price/1.1,
      high:price*1.12,low:price*0.98,
      pct:dayIndex===0?0.5:1,
      amount:200000000-i*10000,turn:5+i%8,mcap:5000000000+i*1000000,
      pct60:4+i*0.01,mainNet,mainPct:20-i*0.01,
      industry:i%2?'半导体':'机械',specialTreatment:false,mainBoard:true
    };
  });
}
function makeSnapshots({missingLhb=false,missingLimitPools=false,futureShock=false}={}) {
  return dates.map((tradeDate,index)=>{
    const rows=stockRows(index,{futureShock});
    const signals={
      '600000':{netBuyCny:9000000,institutionalNetBuyCny:3000000,institutionalSeatCount:1},
      '600020':{netBuyCny:1000000,institutionalNetBuyCny:-500000,institutionalSeatCount:1},
      '600001':{netBuyCny:-1000000,institutionalNetBuyCny:null,institutionalSeatCount:0}
    };
    return {
      schema:'ashare-v16-daily-snapshot-v1',tradeDate,capturedAt:tradeDate+'T12:10:00.000Z',
      sourceScope:'full-market',quality:{qualifiedForReplay:true,status:'QUALIFIED'},
      stockRows:rows,
      fundingRows:rows.slice(0,100),
      market:{
        indices:[{key:'shanghai',changePct:0.8}],
        lhb:missingLhb?{dailyStatus:'NOT_MEASURABLE',seatStatus:'NOT_MEASURABLE',stockSignalsByCode:{}}:{
          dailyStatus:'AVAILABLE',seatStatus:'AVAILABLE',status:'AVAILABLE',
          positiveStockRatio:0.6,institutionalPositiveStockRatio:0.5,
          stockSignalsByCode:signals
        },
        limitPools:missingLimitPools?{
          status:'PARTIAL',
          sourceStatus:{limitUp:'NOT_MEASURABLE',broken:'AVAILABLE',limitDown:'AVAILABLE'},
          limitUp:[],brokenBoardCount:5,limitDownCount:3
        }:{
          status:'AVAILABLE',
          sourceStatus:{limitUp:'AVAILABLE',broken:'AVAILABLE',limitDown:'AVAILABLE'},
          limitUp:[{code:'600000'},{code:'600001'}],
          limitUpCount:2,brokenBoardCount:5,limitDownCount:3,
          brokenBoardRate:5/7,highestBoard:3
        }
      }
    };
  });
}

test('ablation reports Top10/30/50 and T+1/T+3/T+5 using next-session open entry',()=>{
  const report=evaluateFlowLhbAblation({
    snapshots:makeSnapshots(),asOf:'2026-11-11',minSignalDates:1
  });
  assert.equal(report.schema,'ashare-v16-flow-lhb-ablation-v1');
  assert.deepEqual(Object.keys(report.aggregate),['baseline','funding','lhb','combined']);
  for(const variant of ['baseline','funding','lhb','combined']) {
    for(const topK of ['top10','top30','top50']) {
      for(const horizon of ['T+1','T+3','T+5']) {
        assert.ok(report.aggregate[variant][topK][horizon]);
      }
    }
  }
  const first=report.daily[0].topK.baseline.top10.horizons['T+1'];
  assert.equal(first.status,'MEASURABLE');
  assert.ok(Math.abs(first.meanReturnPct-10)<1e-9);
  assert.equal(first.exactLimitUpStatus,'AVAILABLE');
  assert.equal(first.exactLimitUpEventCount,2);
  assert.equal(first.exactLimitUpCapturedCount,2);
  assert.equal(report.daily[2].factorCoverage.fundingInputCoverage,1);
  assert.equal(report.daily[2].factorCoverage.lhbDailyCoverage,1);
  assert.equal(report.promotionEligible,false);
});

test('LHB and limit-pool gaps remain explicit while baseline daily returns remain measurable',()=>{
  const report=evaluateFlowLhbAblation({
    snapshots:makeSnapshots({missingLhb:true,missingLimitPools:true}),
    asOf:'2026-11-11',minSignalDates:1
  });
  const first=report.daily[0];
  assert.equal(first.marketContext.lhbDailyStatus,'NOT_MEASURABLE');
  assert.equal(first.marketContext.limitUpStatus,'NOT_MEASURABLE');
  assert.equal(first.factorCoverage.lhbDailyCoverage,0);
  assert.equal(first.topK.baseline.top10.horizons['T+1'].status,'MEASURABLE');
  assert.equal(first.topK.baseline.top10.horizons['T+1'].exactLimitUpStatus,'NOT_MEASURABLE');
});

test('future price mutations do not change signal-date ranking or factor scores',()=>{
  const original=evaluateFlowLhbAblation({
    snapshots:makeSnapshots(),asOf:'2026-11-04',minSignalDates:1
  });
  const changed=evaluateFlowLhbAblation({
    snapshots:makeSnapshots({futureShock:true}),asOf:'2026-11-04',minSignalDates:1
  });
  assert.deepEqual(
    original.daily.map(row=>row.topK.combined.top10.top),
    changed.daily.map(row=>row.topK.combined.top10.top)
  );
});

test('incomplete signal history does not create a funding score or false factor coverage',()=>{
  const snapshots=makeSnapshots();
  snapshots[0].stockRows=snapshots[0].stockRows.map(row=>({...row,low:null,mainNet:null}));
  snapshots[1].stockRows=snapshots[1].stockRows.map(row=>({...row,low:null,mainNet:null}));
  snapshots[0].fundingRows=[];
  snapshots[1].fundingRows=[];
  const report=evaluateFlowLhbAblation({snapshots,asOf:'2026-11-04',minSignalDates:1});
  assert.equal(report.daily.at(-1).factorCoverage.fundingInputCoverage,0);
  assert.equal(report.daily.at(-1).topK.funding.top10.top[0].fundingScore,null);
});

test('a missing or unqualified prior snapshot blocks the three-session funding factor',()=>{
  const snapshots=makeSnapshots();
  snapshots[1].quality={qualifiedForReplay:false,status:'PARTIAL',reasons:['universe-not-full-market']};
  const report=evaluateFlowLhbAblation({snapshots,asOf:'2026-11-04',minSignalDates:1});
  assert.equal(report.daily.at(-1).factorCoverage.fundingInputCoverage,0);
  assert.equal(report.daily.at(-1).topK.funding.top10.top[0].fundingScore,null);
});

test('an AVAILABLE LHB status without the required stock-signal map is not imputed as neutral',()=>{
  const snapshots=makeSnapshots();
  for(const snapshot of snapshots) {
    snapshot.market.lhb={dailyStatus:'AVAILABLE',seatStatus:'AVAILABLE'};
  }
  const report=evaluateFlowLhbAblation({snapshots,asOf:'2026-11-04',minSignalDates:1});
  assert.equal(report.daily.at(-1).factorCoverage.lhbDailyCoverage,0);
  assert.equal(report.daily.at(-1).topK.lhb.top10.top[0].lhbScore,null);
});

test('as-of cutoff excludes later sessions from signal and outcome history',()=>{
  const report=evaluateFlowLhbAblation({
    snapshots:makeSnapshots(),asOf:'2026-11-04',minSignalDates:1
  });
  assert.equal(report.uniqueTradeDates,3);
  assert.equal(report.daily.at(-1).tradeDate,'2026-11-04');
  assert.equal(report.daily.at(-1).topK.baseline.top10.horizons['T+1'].status,'IMMATURE');
});
