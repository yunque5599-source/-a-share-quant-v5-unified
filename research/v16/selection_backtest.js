const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const num = value => finite(value) ? Number(value) : null;
const clamp = (value,min=0,max=100) => Math.max(min,Math.min(max,Number.isFinite(value)?value:min));
function median(values) {
  const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);
  if(!sorted.length)return null;
  const mid=Math.floor(sorted.length/2);
  return sorted.length%2?sorted[mid]:(sorted[mid-1]+sorted[mid])/2;
}
function upperPercentile(values,value) {
  const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);
  if(!sorted.length||!Number.isFinite(value))return 50;
  let lo=0,hi=sorted.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(sorted[mid]<=value)lo=mid+1;else hi=mid;}
  return lo/sorted.length*100;
}
function normalizeRow(row) {
  const code=String(row?.code??'').trim(),name=String(row?.name??'');
  return {
    code,name,
    price:num(row?.price),pct:num(row?.pct),amount:num(row?.amount),
    turn:num(row?.turn??row?.turnoverPct),mcap:num(row?.mcap??row?.marketCap),
    pct60:num(row?.pct60),mainNet:num(row?.mainNet),mainPct:num(row?.mainPct),
    industry:String(row?.industry??'未知'),
    specialTreatment:row?.specialTreatment===true||/(?:\*?ST|退)/i.test(name),
    mainBoard:/^(00|60)\d{4}$/.test(code)
  };
}
const RANK_FACTORS=[
  {key:'mainNet',weight:1.00,field:'mainNet'},
  {key:'mainPct',weight:0.90,field:'mainPct'},
  {key:'amount',weight:0.60,field:'amount'},
  {key:'turnover',weight:0.45,field:'turn'},
  {key:'dayMomentum',weight:0.35,field:'pct'},
  {key:'swingMomentum',weight:0.45,field:'pct60'}
];
function attachRankScores(rows,{maxFactorRows=300,maxCandidates=900}={}) {
  const byCode=new Map(rows.map(row=>[row.code,{...row,rankPoints:0,rankHits:0,factorRanks:{}}]));
  for(const factor of RANK_FACTORS){
    const sorted=rows.filter(row=>row.code&&row[factor.field]!==null)
      .slice().sort((a,b)=>(b[factor.field]-a[factor.field])||a.code.localeCompare(b.code));
    const observed=Math.min(sorted.length,maxFactorRows);
    for(let i=0;i<observed;i++){
      const target=byCode.get(sorted[i].code);
      if(!target)continue;
      target.rankPoints+=factor.weight*Math.max(0,1-i/Math.max(1,observed));
      target.rankHits++;
      target.factorRanks[factor.key]=i+1;
    }
  }
  return [...byCode.values()]
    .filter(row=>row.rankHits>0)
    .map(row=>({...row,rankScore:Math.min(100,row.rankPoints/1.55*100)}))
    .sort((a,b)=>(b.rankScore-a.rankScore)||(b.rankHits-a.rankHits)||a.code.localeCompare(b.code))
    .slice(0,maxCandidates);
}
function hardFilter(rows,{capital=80000,minPrice=2,minAmount=8e7,minTurn=0.7,maxTurn=25,minMcap=2e9,minPct=-4,maxPct=12}={}) {
  const maxPrice=capital*0.35/100;
  return rows.filter(row=>row.mainBoard&&!row.specialTreatment
    &&row.price!==null&&row.price>=minPrice&&row.price<=maxPrice
    &&row.amount!==null&&row.amount>=minAmount
    &&row.turn!==null&&row.turn>=minTurn&&row.turn<=maxTurn
    &&(row.mcap===null||row.mcap>=minMcap)
    &&row.pct!==null&&row.pct>=minPct&&row.pct<=maxPct);
}
function sectorStats(rows) {
  const groups=new Map();
  for(const row of rows){
    const key=row.industry||'未知';
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(row);
  }
  const result=new Map();
  for(const [key,members] of groups){
    const returns=members.map(row=>row.pct).filter(Number.isFinite);
    result.set(key,{
      medPct:(median(returns)??0)/100,
      posFlow:members.filter(row=>row.mainNet!==null&&row.mainNet>0).length/Math.max(1,members.length),
      count:members.length
    });
  }
  return result;
}
function marketRegime(rows,indices=[]) {
  let values=(Array.isArray(indices)?indices:[])
    .map(row=>num(row?.pct??row?.changePct))
    .filter(Number.isFinite).map(value=>value/100);
  let basis='index-proxy';
  if(values.length<2){values=rows.map(row=>row.pct/100).filter(Number.isFinite);basis='candidate-pool-proxy';}
  const up=values.filter(value=>value>0).length/Math.max(1,values.length);
  const med=median(values)??0;
  const strong=med>0.004&&up>=0.75;
  const weak=med< -0.006||up<=0.25;
  return {label:strong?'强势':weak?'弱势':'中性',up,med,basis};
}
export function rankV15Stage1Candidates(stockRows,indices=[],options={}) {
  const normalized=(Array.isArray(stockRows)?stockRows:[]).map(normalizeRow).filter(row=>row.code);
  const ranked=attachRankScores(normalized,options);
  const filtered=hardFilter(ranked,options);
  const sectors=sectorStats(filtered);
  const mainP=filtered.map(row=>row.mainPct),mainN=filtered.map(row=>row.mainNet);
  const amounts=filtered.map(row=>Math.log10(Math.max(1,row.amount??1)));
  const pct60=filtered.map(row=>row.pct60),pcts=filtered.map(row=>row.pct);
  const scored=filtered.map(row=>{
    const sector=sectors.get(row.industry)||{medPct:0,posFlow:0.5};
    const flow=0.55*upperPercentile(mainP,row.mainPct)+0.45*upperPercentile(mainN,row.mainNet);
    const liquidity=upperPercentile(amounts,Math.log10(Math.max(1,row.amount??1)));
    const relativeStrength60=upperPercentile(pct60,row.pct60);
    const momentum=upperPercentile(pcts,row.pct);
    const turnoverOptimal=100-Math.min(100,Math.abs((row.turn||5)-6)*8);
    const sector=clamp(50+sector.medPct*1700+(sector.posFlow-0.5)*45,0,100);
    const rank=clamp(row.rankScore||50,0,100);
    const heatPenalty=(row.pct>8?18:0)+(row.turn>18?10:0);
    const score=0.30*flow+0.14*liquidity+0.10*relativeStrength60+0.08*momentum
      +0.08*turnoverOptimal+0.10*sector+0.20*rank-heatPenalty;
    return {
      ...row,stage1Score:Number(score.toFixed(4)),flowScore:Number(flow.toFixed(2)),
      liquidityScore:Number(liquidity.toFixed(2)),relativeStrength60Score:Number(relativeStrength60.toFixed(2)),
      momentumScore:Number(momentum.toFixed(2)),turnoverOptimalScore:Number(turnoverOptimal.toFixed(2)),
      sectorScore:Number(sector.toFixed(2)),heatPenalty:Number(heatPenalty.toFixed(2))
    };
  }).sort((a,b)=>(b.stage1Score-a.stage1Score)||a.code.localeCompare(b.code));
  return {
    schema:'ashare-v15-stage1-reconstruction-v1',
    status:scored.length>=50?'AVAILABLE':scored.length?'PARTIAL':'NOT_MEASURABLE',
    rankingMethod:'reconstructed-six-factor-top-300-rank-score-plus-v15-stage1',
    marketRegime:marketRegime(scored,indices),
    sourceRows:normalized.length,
    rankedPoolCount:ranked.length,
    hardFilteredCount:filtered.length,
    candidateCount:scored.length,
    candidates:scored
  };
}
function isMainBoardTradable(row) {
  return /^(00|60)\d{4}$/.test(String(row?.code??''))
    &&!row?.specialTreatment&&!/(?:\*?ST|退)/i.test(String(row?.name??''));
}
function snapshotRows(snapshot) {
  return new Map((Array.isArray(snapshot?.stockRows)?snapshot.stockRows:[])
    .filter(isMainBoardTradable)
    .map(row=>[String(row.code),row]));
}
function compoundReturn(rows,code,horizon) {
  let wealth=1,peak=1,maxDrawdown=0,maxFavorable=0,maxAdverse=0;
  for(let i=1;i<=horizon;i++){
    const row=rows[i]?.get(code),daily=num(row?.pct);
    if(daily===null)return null;
    wealth*=1+daily/100;
    peak=Math.max(peak,wealth);
    maxDrawdown=Math.min(maxDrawdown,(wealth/peak-1)*100);
    maxFavorable=Math.max(maxFavorable,(wealth-1)*100);
    maxAdverse=Math.min(maxAdverse,(wealth-1)*100);
  }
  return {returnPct:(wealth-1)*100,maxDrawdownPct:maxDrawdown,maxFavorablePct:maxFavorable,maxAdversePct:maxAdverse};
}
function expectedNextSession(previousDate,nextDate) {
  const a=new Date(previousDate+'T00:00:00Z'),b=new Date(nextDate+'T00:00:00Z');
  const diff=Math.round((b-a)/86400000);
  const weekday=a.getUTCDay();
  return diff===(weekday===5?3:1);
}
function summarize(values) {
  const valid=values.filter(Number.isFinite);
  return {
    sampleCount:valid.length,
    meanPct:valid.length?Number((valid.reduce((a,b)=>a+b,0)/valid.length).toFixed(3)):null,
    medianPct:median(valid)===null?null:Number(median(valid).toFixed(3)),
    positiveRatio:valid.length?Number((valid.filter(value=>value>0).length/valid.length).toFixed(4)):null,
    hit5PctRatio:valid.length?Number((valid.filter(value=>value>=5).length/valid.length).toFixed(4)):null
  };
}
function buildCohortMetric(signal,history,signalIndex,selected,horizon) {
  const future=history.slice(signalIndex,signalIndex+horizon+1);
  if(future.length!==horizon+1)return {status:'IMMATURE',horizon,selectedCount:selected.length,maturedCount:0};
  for(let i=1;i<future.length;i++){
    if(!expectedNextSession(future[i-1].tradeDate,future[i].tradeDate))
      return {status:'CALENDAR_GAP',horizon,selectedCount:selected.length,maturedCount:0};
  }
  if(future.some(snapshot=>snapshot.quality?.qualifiedForReplay!==true||snapshot.sourceScope!=='full-market'))
    return {status:'DATA_GAP',horizon,selectedCount:selected.length,maturedCount:0};
  const maps=future.map(snapshotRows);
  const candidateResults=selected.map(candidate=>{
    const result=compoundReturn(maps,candidate.code,horizon);
    return result?{code:candidate.code,...result}:null;
  }).filter(Boolean);
  const benchmarkResults=[];
  const allCodes=[...maps[0].keys()];
  for(const code of allCodes){
    const result=compoundReturn(maps,code,horizon);
    if(result)benchmarkResults.push(result.returnPct);
  }
  const eventCodes=new Set();
  for(let day=1;day<=horizon;day++){
    for(const [code,row] of maps[day]){
      const pct=num(row?.pct);
      if(pct!==null&&pct>=9.5)eventCodes.add(code);
    }
  }
  const selectedCodes=new Set(selected.map(row=>row.code));
  const captured=[...eventCodes].filter(code=>selectedCodes.has(code)).length;
  const returns=candidateResults.map(row=>row.returnPct);
  const averageReturn=returns.length?returns.reduce((a,b)=>a+b,0)/returns.length:null;
  const benchmark=benchmarkResults.length?benchmarkResults.reduce((a,b)=>a+b,0)/benchmarkResults.length:null;
  return {
    status:candidateResults.length===selected.length?'MEASURABLE':'PARTIAL',
    horizon,selectedCount:selected.length,maturedCount:candidateResults.length,
    coverage:selected.length?Number((candidateResults.length/selected.length).toFixed(4)):0,
    ...summarize(returns),
    benchmarkMeanPct:benchmark===null?null:Number(benchmark.toFixed(3)),
    excessMeanPct:averageReturn===null||benchmark===null?null:Number((averageReturn-benchmark).toFixed(3)),
    meanMaxDrawdownPct:candidateResults.length?Number((candidateResults.reduce((sum,row)=>sum+row.maxDrawdownPct,0)/candidateResults.length).toFixed(3)):null,
    meanMaxFavorablePct:candidateResults.length?Number((candidateResults.reduce((sum,row)=>sum+row.maxFavorablePct,0)/candidateResults.length).toFixed(3)):null,
    meanMaxAdversePct:candidateResults.length?Number((candidateResults.reduce((sum,row)=>sum+row.maxAdversePct,0)/candidateResults.length).toFixed(3)):null,
    nearLimitUpProxyEventCount:eventCodes.size,
    nearLimitUpProxyCapturedCount:captured,
    nearLimitUpProxyCaptureRate:eventCodes.size?Number((captured/eventCodes.size).toFixed(4)):null,
    nearLimitUpProxyPrecision:selected.length?Number((captured/selected.length).toFixed(4)):null,
    limitLabelQuality:'APPROXIMATE_PROXY',
    executionFillability:'NOT_MEASURABLE_DAILY_DATA_ONLY'
  };
}
export function evaluateV15TopKForwardReturns({snapshots=[],asOf=null,topKs=[10,30,50],horizons=[1,3,5],minSignalDates=20}={}) {
  const cutoff=String(asOf??'').slice(0,10);
  const ordered=(Array.isArray(snapshots)?snapshots:[])
    .filter(snapshot=>snapshot&&/^\d{4}-\d{2}-\d{2}$/.test(String(snapshot.tradeDate??''))
      &&(!cutoff||snapshot.tradeDate<=cutoff))
    .sort((a,b)=>a.tradeDate.localeCompare(b.tradeDate));
  const uniqueByDate=new Map();
  for(const snapshot of ordered){
    const existing=uniqueByDate.get(snapshot.tradeDate);
    if(!existing||Date.parse(snapshot.capturedAt??'')<Date.parse(existing.capturedAt??''))uniqueByDate.set(snapshot.tradeDate,snapshot);
  }
  const history=[...uniqueByDate.values()];
  const eligibleSignals=history.map((snapshot,index)=>({snapshot,index}))
    .filter(({snapshot})=>snapshot.quality?.qualifiedForReplay===true&&snapshot.sourceScope==='full-market'
      &&Array.isArray(snapshot.stockRows)&&snapshot.stockRows.length>=500);
  const daily=[];
  const samples=new Map();
  for(const topK of topKs){
    samples.set(topK,new Map(horizons.map(h=>[h,[]])));
  }
  for(const {snapshot,index} of eligibleSignals){
    const ranking=rankV15Stage1Candidates(snapshot.stockRows,snapshot.market?.indices??[]);
    const dailyTopK={};
    for(const topK of topKs){
      const selected=ranking.candidates.slice(0,topK);
      const result={selectedCount:selected.length,top:selected.slice(0,Math.min(5,selected.length)).map(row=>({code:row.code,name:row.name,score:row.stage1Score})) ,horizons:{}};
      for(const horizon of horizons){
        const metric=buildCohortMetric(snapshot,history,index,selected,horizon);
        result.horizons['T+'+horizon]=metric;
        if(metric.status==='MEASURABLE'||metric.status==='PARTIAL'){
          samples.get(topK).get(horizon).push(metric);
        }
      }
      dailyTopK['top'+topK]=result;
    }
    daily.push({tradeDate:snapshot.tradeDate,capturedAt:snapshot.capturedAt,rankingStatus:ranking.status,rankedPoolCount:ranking.rankedPoolCount,hardFilteredCount:ranking.hardFilteredCount,marketRegime:ranking.marketRegime,topK:dailyTopK});
  }
  const aggregate={};
  for(const topK of topKs){
    aggregate['top'+topK]={};
    for(const horizon of horizons){
      const metrics=samples.get(topK).get(horizon),candidateCount=metrics.reduce((sum,row)=>sum+row.maturedCount,0);
      const totalSelected=metrics.reduce((sum,row)=>sum+row.selectedCount,0);
      const meanOf=field=>{const values=metrics.map(row=>row[field]).filter(Number.isFinite);return values.length?Number((values.reduce((a,b)=>a+b,0)/values.length).toFixed(4)):null;};
      aggregate['top'+topK]['T+'+horizon]={
        signalDateCount:metrics.length,
        maturedCandidates:candidateCount,
        selectedCandidates:totalSelected,
        sampleCoverage:totalSelected?Number((candidateCount/totalSelected).toFixed(4)):0,
        meanReturnPct:meanOf('meanPct'),
        medianReturnPct:meanOf('medianPct'),
        positiveRatio:meanOf('positiveRatio'),
        hit5PctRatio:meanOf('hit5PctRatio'),
        meanBenchmarkPct:meanOf('benchmarkMeanPct'),
        meanExcessPct:meanOf('excessMeanPct'),
        meanMaxDrawdownPct:meanOf('meanMaxDrawdownPct'),
        meanMaxFavorablePct:meanOf('meanMaxFavorablePct'),
        meanMaxAdversePct:meanOf('meanMaxAdversePct'),
        nearLimitUpProxyCaptureRate:meanOf('nearLimitUpProxyCaptureRate'),
        nearLimitUpProxyPrecision:meanOf('nearLimitUpProxyPrecision'),
        status:metrics.length>=minSignalDates?'MEASURABLE':metrics.length?'PARTIAL':'NOT_MEASURABLE'
      };
    }
  }
  return {
    schema:'ashare-v16-v15-topk-forward-backtest-v1',
    asOf:cutoff||history.at(-1)?.tradeDate||null,
    inputSnapshotCount:Array.isArray(snapshots)?snapshots.length:0,
    uniqueTradeDates:history.length,
    eligibleSignalDates:eligibleSignals.length,
    rankingMethod:'V15_STAGE1_RECONSTRUCTION_FROM_FULL_MARKET_SNAPSHOT',
    metricsConvention:{
      return:'Compounded daily close-to-close percentage returns from signal close; T+1/T+3/T+5 trading sessions.',
      benchmark:'Equal-weighted eligible main-board constituent cohort with complete horizon observations.',
      nearLimitUpProxy:'A constituent is counted when any future daily return in the horizon is >=9.5%; not an exchange-confirmed limit-up label.',
      feesAndSlippage:'Not deducted; configure a separate execution study with actual commission, stamp duty and slippage.',
      execution:'No order-book, auction, intraday fill, limit-lock or T+1 sellability simulation.'
    },
    minimumSignalDatesForMetric:minSignalDates,
    promotionEligible:false,
    status:eligibleSignals.length>=minSignalDates?'PARTIAL':'NOT_MEASURABLE',
    aggregate,
    daily,
    limitations:[
      'This backtest evaluates the V15 stage-one preselection funnel reconstructed from the six full-market ranking factors; it is not the final V15 deep-score/news ranking.',
      'A full-market snapshot must pass its point-in-time quality gate before it can be used as a signal or outcome session.',
      'A missing weekday snapshot is treated as a calendar gap; long exchange holidays are conservatively excluded unless an exchange calendar is supplied.',
      'Forward returns are labels only and never enter the signal-date ranking.',
      'Near-limit-up events use a 9.5% proxy and are not exact board/ST/new-listing-aware labels.',
      'Daily data cannot establish actual entry fills, limit-lock execution, intraday maximum adverse excursion, or realized net P&L.',
      'At least 20 qualified signal dates are required before a metric is labelled MEASURABLE; this does not imply production readiness.'
    ]
  };
}
export const _internal={upperPercentile,normalizeRow,attachRankScores,hardFilter,compoundReturn,expectedNextSession,buildCohortMetric};
