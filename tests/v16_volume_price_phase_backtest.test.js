import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateVolumePricePhaseBacktest} from '../research/v16/volume_price_phase_backtest.js';
const GROUPS=['EARLY_BREAKOUT','CONSTRUCTIVE_PULLBACK','REACCELERATION','DISTRIBUTION_RISK'];
function nextWeekday(date){const cursor=new Date(date+'T00:00:00Z');do{cursor.setUTCDate(cursor.getUTCDate()+1);}while(cursor.getUTCDay()===0||cursor.getUTCDay()===6);return cursor.toISOString().slice(0,10);}
function makeSnapshot(date,index){
  const stockRows=Array.from({length:500},(_,i)=>({code:String(100000+i).padStart(6,'0'),price:10,open:10,high:10.2,low:9.8}));
  const volumePhaseRows=GROUPS.map((classification,groupIndex)=>{
    const code=String(600001+groupIndex),close=10+index*0.01;
    stockRows[groupIndex]={code,price:close,open:close,high:close*1.02,low:close*0.98};
    return {code,name:classification,sourceRank:groupIndex+1,close,phase:{status:'AVAILABLE',classification,metrics:{close}}};
  });
  return {schema:'ashare-v16-daily-snapshot-v1',tradeDate:date,sourceScope:'full-market',
    quality:{qualifiedForReplay:true,status:'QUALIFIED'},stockRows,
    volumePhaseDiagnostics:{status:'AVAILABLE',requestedCount:50,availableCount:50,measurableCount:50,coverage:1},
    volumePhaseRows};
}
function history(count=22){const dates=['2026-01-05'];while(dates.length<count)dates.push(nextWeekday(dates.at(-1)));return dates.map((date,index)=>makeSnapshot(date,index));}
test('phase cohort replay compares next-session outcomes without future leakage',()=>{
  const snapshots=history(),returns={EARLY_BREAKOUT:0.02,CONSTRUCTIVE_PULLBACK:0.04,REACCELERATION:0.05,DISTRIBUTION_RISK:-0.05};
  for(let index=1;index<snapshots.length;index++){
    const previous=snapshots[index-1],current=snapshots[index];
    for(let groupIndex=0;groupIndex<GROUPS.length;groupIndex++){
      const code=String(600001+groupIndex),signal=previous.volumePhaseRows[groupIndex];
      const future=current.stockRows.find(row=>row.code===code),r=returns[signal.phase.classification];
      future.open=signal.close*1.01;future.price=future.open*(1+r);future.high=future.price*1.01;future.low=future.open*0.99;
    }
  }
  const report=evaluateVolumePricePhaseBacktest({snapshots,asOf:snapshots.at(-1).tradeDate,minSignalDates:20,minSampleCoverage:0.95});
  assert.equal(report.eligibleSignalDates,21);
  assert.equal(report.aggregate.CONSTRUCTIVE_PULLBACK.status,'MEASURABLE');
  assert.equal(report.aggregate.DISTRIBUTION_RISK.status,'MEASURABLE');
  assert.ok(report.aggregate.CONSTRUCTIVE_PULLBACK.meanCloseToClosePct>report.aggregate.DISTRIBUTION_RISK.meanCloseToClosePct);
  assert.equal(report.promotionEligible,false);
});
test('future snapshots and partial phase-coverage dates are excluded',()=>{
  const snapshots=history(23),cutoff=snapshots[21].tradeDate;
  snapshots[10].volumePhaseDiagnostics.coverage=0.5;snapshots[10].volumePhaseDiagnostics.status='PARTIAL';
  const report=evaluateVolumePricePhaseBacktest({snapshots,asOf:cutoff,minSignalDates:1,minSampleCoverage:0.95});
  assert.equal(report.asOf,cutoff);assert.equal(report.eligibleSignalDates,20);
});
test('unqualified full-market snapshots do not contribute to phase replay',()=>{
  const snapshots=history(3);snapshots[0].quality.qualifiedForReplay=false;
  const report=evaluateVolumePricePhaseBacktest({snapshots,minSignalDates:1});
  assert.equal(report.eligibleSignalDates,1);
});
