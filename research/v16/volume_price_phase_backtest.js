const num=value=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value))?Number(value):null;
const mean=values=>{const valid=values.filter(Number.isFinite);return valid.length?valid.reduce((sum,value)=>sum+value,0)/valid.length:null;};
const dateOf=snapshot=>String(snapshot?.tradeDate??'').slice(0,10);
const available=status=>status==='AVAILABLE'||status==='AVAILABLE_EMPTY';
const CORE_GROUPS=['EARLY_BREAKOUT','CONSTRUCTIVE_PULLBACK','REACCELERATION','DISTRIBUTION_RISK'];
const GROUPS=[...CORE_GROUPS,'TIGHT_CONSOLIDATION','ACCELERATION_RISK','NEUTRAL'];
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
export function evaluateVolumePricePhaseBacktest({snapshots=[],asOf=null,minSignalDates=20,minSampleCoverage=0.95}={}) {
  const cutoff=String(asOf??'').slice(0,10);
  const history=(Array.isArray(snapshots)?snapshots:[])
    .filter(snapshot=>/^\d{4}-\d{2}-\d{2}$/.test(dateOf(snapshot))&&(!cutoff||dateOf(snapshot)<=cutoff))
    .sort((a,b)=>dateOf(a).localeCompare(dateOf(b)));
  const unique=new Map();
  for(const snapshot of history)if(!unique.has(dateOf(snapshot)))unique.set(dateOf(snapshot),snapshot);
  const sessions=[...unique.values()];
  const buckets=Object.fromEntries(GROUPS.map(group=>[group,[]]));
  const eligibleSignalDates=[];
  for(let index=0;index<sessions.length-1;index++) {
    const signal=sessions[index],next=sessions[index+1];
    if(!qualified(signal)||!qualified(next)||!expectedNextSession(dateOf(signal),dateOf(next)))continue;
    const diagnostics=signal.volumePhaseDiagnostics??{};
    if(!available(diagnostics.status)||num(diagnostics.coverage)===null||num(diagnostics.coverage)<minSampleCoverage)continue;
    eligibleSignalDates.push(dateOf(signal));
    const nextRows=byCode(next);
    for(const row of Array.isArray(signal.volumePhaseRows)?signal.volumePhaseRows:[]) {
      const group=row?.phase?.classification;
      if(!GROUPS.includes(group)||row?.phase?.status!=='AVAILABLE')continue;
      const future=nextRows.get(String(row.code));
      const close=num(row.close??row.phase?.metrics?.close);
      const open=num(future?.open),exit=num(future?.price??future?.close);
      const high=num(future?.high),low=num(future?.low);
      if(close===null||close<=0||!future||open===null||open<=0||exit===null||exit<=0) {
        buckets[group].push({signalDate:dateOf(signal),code:String(row.code),classification:group,outcome:null});
        continue;
      }
      buckets[group].push({
        signalDate:dateOf(signal),nextDate:dateOf(next),code:String(row.code),classification:group,
        outcome:true,gapPct:(open/close-1)*100,openToClosePct:(exit/open-1)*100,
        closeToClosePct:(exit/close-1)*100,
        maxFavorablePct:high!==null?(high/open-1)*100:null,
        maxAdversePct:low!==null?(low/open-1)*100:null,
        sourceRank:num(row.sourceRank)
      });
    }
  }
  const aggregate={};
  for(const group of GROUPS)aggregate[group]=summarize(buckets[group],minSignalDates,minSampleCoverage);
  const allRows=GROUPS.flatMap(group=>buckets[group]);
  const overallCoverage=allRows.length?allRows.filter(row=>row.outcome).length/allRows.length:0;
  const coreReady=CORE_GROUPS.every(group=>aggregate[group].status==='MEASURABLE');
  const status=eligibleSignalDates.length===0?'NOT_MEASURABLE':
    coreReady&&overallCoverage>=minSampleCoverage?'MEASURABLE':'PARTIAL';
  return {
    schema:'ashare-v16-volume-price-phase-backtest-v1',
    asOf:cutoff||dateOf(sessions.at(-1))||null,status,promotionEligible:false,
    calibration:'NOT_CALIBRATED',candidateUniverse:'V15_STAGE1_TOP50',
    eligibleSignalDates:eligibleSignalDates.length,minimumSignalDates:minSignalDates,
    minimumSampleCoverage:minSampleCoverage,overallSampleCoverage:Number(overallCoverage.toFixed(4)),aggregate,
    executionConvention:{
      signal:'Signal-date post-close V15 Stage1 Top50 cohort and daily unadjusted OHLCV phase labels.',
      outcome:'Next trading session open-to-close; close-to-close is measured from signal close to next-session close.',
      noLookAhead:'Future next-session OHLC is outcome-only and never enters signal-date phase classification.',
      limitations:'Descriptive cohort comparison only; excludes fees, slippage, intraday fills, limit-lock queue and corporate-action adjustment.'
    },
    limitations:[
      'The candidate universe is the V15 reconstructed Stage1 Top50, not the full market or final V16 scan pool.',
      'Only snapshots with full-market qualification and at least 95% daily-bar coverage in the phase candidate set are replayed.',
      'At least 20 matured signal dates and 95% matched next-session outcomes are required per phase group before MEASURABLE.',
      'Daily bars use unadjusted prices to avoid future-adjustment leakage; ex-rights/ex-dividend discontinuities can distort short windows.',
      'Phase labels are heuristic, uncalibrated and cannot change production weights or authorize orders.'
    ]
  };
}
