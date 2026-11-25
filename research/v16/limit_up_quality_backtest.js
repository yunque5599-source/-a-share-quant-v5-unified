import {evaluateLimitUpQuality} from './limit_up_quality.js';

const finite=value=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value));
const num=value=>finite(value)?Number(value):null;
const mean=values=>{const valid=values.filter(Number.isFinite);return valid.length?valid.reduce((sum,value)=>sum+value,0)/valid.length:null;};
const dateOf=snapshot=>String(snapshot?.tradeDate??'').slice(0,10);
const available=status=>status==='AVAILABLE'||status==='AVAILABLE_EMPTY';

function expectedNextSession(previousDate,nextDate) {
  const a=new Date(previousDate+'T00:00:00Z'),b=new Date(nextDate+'T00:00:00Z');
  const diff=Math.round((b-a)/86400000),weekday=a.getUTCDay();
  return diff===(weekday===5?3:1);
}
function qualified(snapshot) {
  return snapshot?.quality?.qualifiedForReplay===true&&snapshot?.sourceScope==='full-market'&&
    Array.isArray(snapshot?.stockRows)&&snapshot.stockRows.length>=500;
}
function byCode(snapshot) {
  return new Map((snapshot?.stockRows??[]).filter(row=>/^\d{6}$/.test(String(row.code??'')))
    .map(row=>[String(row.code),row]));
}
function poolStatus(pools) {
  return String(pools?.sourceStatus?.limitUp??(pools?.status==='AVAILABLE'?'AVAILABLE':'NOT_MEASURABLE'));
}
function summarize(rows,minSignalDates,minCoverage) {
  const matched=rows.filter(row=>row.outcome);
  const signalDates=new Set(rows.map(row=>row.signalDate));
  const maturedDates=new Set(matched.map(row=>row.signalDate));
  const coverage=rows.length?matched.length/rows.length:0;
  const metrics={
    candidateCount:rows.length,matchedCount:matched.length,
    signalDateCount:signalDates.size,maturedSignalDateCount:maturedDates.size,
    sampleCoverage:Number(coverage.toFixed(4)),
    meanGapPct:mean(matched.map(row=>row.gapPct)),
    meanOpenToClosePct:mean(matched.map(row=>row.openToClosePct)),
    meanCloseToClosePct:mean(matched.map(row=>row.closeToClosePct)),
    positiveRatio:matched.length?matched.filter(row=>row.closeToClosePct>0).length/matched.length:null,
    meanMfePct:mean(matched.map(row=>row.maxFavorablePct)),
    meanMaePct:mean(matched.map(row=>row.maxAdversePct))
  };
  metrics.status=metrics.maturedSignalDateCount>=minSignalDates&&coverage>=minCoverage?'MEASURABLE':rows.length?'PARTIAL':'NOT_MEASURABLE';
  return metrics;
}

export function evaluateLimitUpQualityBacktest({snapshots=[],asOf=null,minSignalDates=20,minSampleCoverage=0.95}={}) {
  const cutoff=String(asOf??'').slice(0,10);
  const history=(Array.isArray(snapshots)?snapshots:[])
    .filter(snapshot=>/^\d{4}-\d{2}-\d{2}$/.test(dateOf(snapshot))&&(!cutoff||dateOf(snapshot)<=cutoff))
    .sort((a,b)=>dateOf(a).localeCompare(dateOf(b)));
  const unique=new Map();
  for(const snapshot of history)if(!unique.has(dateOf(snapshot)))unique.set(dateOf(snapshot),snapshot);
  const sessions=[...unique.values()];
  const buckets={
    ALL_LIMIT_UP:[],PROXY_STABLE:[],PROXY_MIXED:[],PROXY_RISKY:[],UNCLASSIFIED:[],BROKEN_POOL:[]
  };
  const eligibleSignalDates=[],poolCompleteDates=[];
  for(let index=0;index<sessions.length-1;index++) {
    const signal=sessions[index],next=sessions[index+1];
    if(!qualified(signal)||!qualified(next)||!expectedNextSession(dateOf(signal),dateOf(next)))continue;
    const pools=signal.market?.limitPools??{};
    if(!available(poolStatus(pools)))continue;
    eligibleSignalDates.push(dateOf(signal));
    const pool=evaluateLimitUpQuality({
      limitPools:pools,marketBreadth:signal.market?.breadth??null,tradeDate:dateOf(signal)
    });
    if(pool.status==='AVAILABLE')poolCompleteDates.push(dateOf(signal));
    const signalRows=byCode(signal),nextRows=byCode(next);
    const recordOutcome=(row,bucket)=>{
      const current=signalRows.get(String(row.code));
      const future=nextRows.get(String(row.code));
      const close=num(current?.price??current?.close??row.price);
      if(!future||close===null||close<=0)return {signalDate:dateOf(signal),code:String(row.code),classification:bucket,outcome:null};
      const open=num(future.open),exit=num(future.price??future.close);
      const high=num(future.high),low=num(future.low);
      if(open===null||open<=0||exit===null||exit<=0)return {signalDate:dateOf(signal),code:String(row.code),classification:bucket,outcome:null};
      return {
        signalDate:dateOf(signal),nextDate:dateOf(next),code:String(row.code),classification:bucket,
        outcome:true,gapPct:(open/close-1)*100,openToClosePct:(exit/open-1)*100,
        closeToClosePct:(exit/close-1)*100,
        maxFavorablePct:high!==null?(high/open-1)*100:null,
        maxAdversePct:low!==null?(low/open-1)*100:null
      };
    };
    for(const row of pool.rows) {
      const bucket=['PROXY_STABLE','PROXY_MIXED','PROXY_RISKY'].includes(row.classification)?row.classification:'UNCLASSIFIED';
      const record=recordOutcome(row,bucket);
      buckets.ALL_LIMIT_UP.push(record);
      buckets[bucket].push(record);
    }
    for(const row of pool.brokenRows) buckets.BROKEN_POOL.push(recordOutcome(row,'BROKEN_POOL'));
  }
  const aggregate={};
  for(const [key,rows] of Object.entries(buckets))aggregate[key]=summarize(rows,minSignalDates,minSampleCoverage);
  const completePoolCoverage=eligibleSignalDates.length?poolCompleteDates.length/eligibleSignalDates.length:0;
  const measuredGroups=Object.values(aggregate).filter(metric=>metric.candidateCount>0);
  const status=eligibleSignalDates.length===0?'NOT_MEASURABLE':
    measuredGroups.length&&measuredGroups.every(metric=>metric.status==='MEASURABLE')&&completePoolCoverage>=minSampleCoverage
      ?'MEASURABLE':'PARTIAL';
  return {
    schema:'ashare-v16-limit-up-quality-backtest-v1',
    asOf:cutoff||dateOf(sessions.at(-1))||null,
    status,promotionEligible:false,calibration:'NOT_CALIBRATED',
    inputSnapshotCount:sessions.length,eligibleSignalDates:eligibleSignalDates.length,
    minimumSignalDates:minSignalDates,minimumSampleCoverage:minSampleCoverage,
    limitPoolCoverage:Number(completePoolCoverage.toFixed(4)),
    aggregate,
    executionConvention:{
      signal:'Signal-date close and same-day post-close Eastmoney limit-up/broken-board pool only.',
      outcome:'Next trading session open to next-session close; gap is measured from signal close to next open.',
      noLookAhead:'Future next-session prices are outcome labels only and never enter signal-date proxy classification.',
      benchmark:'This is a descriptive cohort comparison, not a trained or calibrated prediction model.',
      limitations:'No fees, slippage, auction queue, intraday fill, limit-lock or T+1 sellability simulation.'
    },
    limitations:[
      'Only full-market, replay-qualified snapshots and adjacent weekday trading sessions are included; missing archive dates reduce coverage.',
      'Daily proxy categories use vendor first-seal time and reported reopen count; no tick-level sequence or cancellation evidence is inferred.',
      'At least 20 matured signal dates and 95% outcome coverage are required per cohort before its metrics are labelled MEASURABLE.',
      'This report is research-only and cannot authorize production weights or live orders.'
    ]
  };
}
