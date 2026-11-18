import {rankV15Stage1Candidates} from './selection_backtest.js';
import {scoreCandidateFundingEvidence} from './flow_lhb.js';

const finite=value=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value));
const num=value=>finite(value)?Number(value):null;
const clamp=(value,min=0,max=100)=>Math.max(min,Math.min(max,Number.isFinite(value)?value:min));
const mean=values=>{const valid=values.filter(Number.isFinite);return valid.length?valid.reduce((sum,value)=>sum+value,0)/valid.length:null;};
const dateOf=snapshot=>String(snapshot?.tradeDate??'').slice(0,10);
const available=status=>status==='AVAILABLE'||status==='AVAILABLE_EMPTY';

function expectedNextSession(previousDate,nextDate) {
  const a=new Date(previousDate+'T00:00:00Z'),b=new Date(nextDate+'T00:00:00Z');
  const diff=Math.round((b-a)/86400000),weekday=a.getUTCDay();
  return diff===(weekday===5?3:1);
}
function qualified(snapshot) {
  return snapshot?.quality?.qualifiedForReplay===true
    &&snapshot?.sourceScope==='full-market'
    &&Array.isArray(snapshot?.stockRows)
    &&snapshot.stockRows.length>=500;
}
function dedupeSnapshots(snapshots,asOf) {
  const cutoff=String(asOf??'').slice(0,10);
  const groups=new Map();
  for(const snapshot of Array.isArray(snapshots)?snapshots:[]) {
    const date=dateOf(snapshot);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||(cutoff&&date>cutoff))continue;
    if(!groups.has(date))groups.set(date,[]);
    groups.get(date).push(snapshot);
  }
  return [...groups.values()].map(group=>{
    const usable=group.filter(qualified);
    const candidates=usable.length?usable:group;
    return candidates.slice().sort((a,b)=>Date.parse(a.capturedAt??'')-Date.parse(b.capturedAt??''))[0];
  }).sort((a,b)=>dateOf(a).localeCompare(dateOf(b)));
}
function rowsByCode(snapshot) {
  return new Map((snapshot?.stockRows??[])
    .filter(row=>/^(00|60)\d{4}$/.test(String(row.code??''))
      &&row.specialTreatment!==true
      &&!/(?:\*?ST|退)/i.test(String(row.name??'')))
    .map(row=>[String(row.code),row]));
}
function percentile(values,value) {
  const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);
  if(!sorted.length||!Number.isFinite(value))return 50;
  let low=0,high=sorted.length;
  while(low<high){const mid=(low+high)>>>1;if(sorted[mid]<=value)low=mid+1;else high=mid;}
  return clamp(low/sorted.length*100);
}
function lhbEvidence(snapshot,code) {
  const lhb=snapshot?.market?.lhb??null;
  const dailyStatus=lhb?.dailyStatus??lhb?.status??'NOT_MEASURABLE';
  if(!available(dailyStatus))return {status:'NOT_MEASURABLE',score:null,hasDisclosure:false};
  if(!lhb?.stockSignalsByCode||typeof lhb.stockSignalsByCode!=='object') {
    return {status:'NOT_MEASURABLE',score:null,hasDisclosure:false};
  }
  const signals=lhb.stockSignalsByCode;
  const row=signals[String(code)]??null;
  if(!row)return {status:'AVAILABLE_NO_DISCLOSURE',score:50,hasDisclosure:false};
  const dailyValues=Object.values(signals).map(item=>num(item?.netBuyCny)).filter(Number.isFinite);
  const dailyScore=Number.isFinite(num(row.netBuyCny))?percentile(dailyValues,num(row.netBuyCny)):50;
  const seatStatus=lhb?.seatStatus??'NOT_MEASURABLE';
  let score=dailyScore;
  if(available(seatStatus)) {
    const institutionValues=Object.values(signals).map(item=>num(item?.institutionalNetBuyCny)).filter(Number.isFinite);
    const institutionNet=num(row.institutionalNetBuyCny);
    const institutionScore=institutionNet!==null?percentile(institutionValues,institutionNet):50;
    score=0.7*dailyScore+0.3*institutionScore;
  }
  return {
    status:'AVAILABLE',
    score:Number(clamp(score).toFixed(2)),
    hasDisclosure:true,
    dailyScore:Number(dailyScore.toFixed(2)),
    seatStatus
  };
}
function marketContext(snapshot) {
  const pools=snapshot?.market?.limitPools??{};
  const lhb=snapshot?.market?.lhb??{};
  const upStatus=pools.sourceStatus?.limitUp??(pools.status==='AVAILABLE'?'AVAILABLE':'NOT_MEASURABLE');
  const brokenStatus=pools.sourceStatus?.broken??(pools.status==='AVAILABLE'?'AVAILABLE':'NOT_MEASURABLE');
  const downStatus=pools.sourceStatus?.limitDown??(pools.status==='AVAILABLE'?'AVAILABLE':'NOT_MEASURABLE');
  return {
    limitUpCount:upStatus==='AVAILABLE'?num(pools.limitUpCount):null,
    brokenBoardCount:brokenStatus==='AVAILABLE'?num(pools.brokenBoardCount):null,
    limitDownCount:downStatus==='AVAILABLE'?num(pools.limitDownCount):null,
    brokenBoardRate:upStatus==='AVAILABLE'&&brokenStatus==='AVAILABLE'?num(pools.brokenBoardRate):null,
    highestBoard:upStatus==='AVAILABLE'?num(pools.highestBoard):null,
    lhbPositiveStockRatio:available(lhb.dailyStatus??lhb.status)?num(lhb.positiveStockRatio):null,
    lhbInstitutionalPositiveStockRatio:available(lhb.seatStatus)?num(lhb.institutionalPositiveStockRatio):null,
    limitUpStatus:upStatus,
    brokenBoardStatus:brokenStatus,
    limitDownStatus:downStatus,
    lhbDailyStatus:lhb.dailyStatus??lhb.status??'NOT_MEASURABLE',
    lhbSeatStatus:lhb.seatStatus??'NOT_MEASURABLE'
  };
}
function scoreCandidates(snapshot,history,index,ranking) {
  const fundingWindow=history.slice(Math.max(0,index-2),index+1);
  const fundingWindowQualified=fundingWindow.length===3
    &&fundingWindow.every(qualified)
    &&fundingWindow.slice(1).every((item,offset)=>expectedNextSession(dateOf(fundingWindow[offset]),dateOf(item)));
  const sessions=fundingWindowQualified?fundingWindow.map(item=>({
    tradeDate:dateOf(item),
    fundingRows:item.fundingRows??[],
    stockRows:item.stockRows??[],
    lhb:item.market?.lhb??null
  })):[];

  const candidates=ranking.candidates.map(candidate=>{
    const funding=scoreCandidateFundingEvidence({
      code:candidate.code,sessions,asOf:dateOf(snapshot),includeInstitutionalLhb:false
    });
    const lhb=lhbEvidence(snapshot,candidate.code);
    const base=num(candidate.stage1Score)??0;
    const fundingScore=num(funding.fundingScore);
    const fundingInputMeasured=funding.completeThreeSessionInputs===true;
    const fundingAblationScore=fundingScore!==null?fundingScore:fundingInputMeasured?0:null;
    const lhbScore=num(lhb.score);
    const fundingRankScore=fundingAblationScore===null?base:0.90*base+0.10*fundingAblationScore;
    const lhbRankScore=lhbScore===null?base:0.95*base+0.05*lhbScore;
    let combinedRankScore=base;
    if(fundingAblationScore!==null&&lhbScore!==null)combinedRankScore=0.85*base+0.10*fundingAblationScore+0.05*lhbScore;
    else if(fundingAblationScore!==null)combinedRankScore=fundingRankScore;
    else if(lhbScore!==null)combinedRankScore=lhbRankScore;
    return {
      ...candidate,
      fundingEvidence:funding,
      fundingAblationScore,
      fundingInputMeasured,
      lhbEvidence:lhb,
      scores:{
        baseline:Number(base.toFixed(4)),
        funding:Number(fundingRankScore.toFixed(4)),
        lhb:Number(lhbRankScore.toFixed(4)),
        combined:Number(combinedRankScore.toFixed(4))
      }
    };
  });
  const measuredFunding=candidates.filter(row=>row.fundingEvidence?.completeThreeSessionInputs===true).length;
  const positiveFunding=candidates.filter(row=>num(row.fundingEvidence?.fundingScore)!==null).length;
  const measuredLhb=candidates.filter(row=>row.lhbEvidence?.status!=='NOT_MEASURABLE').length;
  const lhbDisclosures=candidates.filter(row=>row.lhbEvidence?.hasDisclosure===true).length;
  return {
    candidates,
    diagnostics:{
      candidateCount:candidates.length,
      fundingInputCoverage:candidates.length?measuredFunding/candidates.length:0,
      fundingSignalCoverage:candidates.length?positiveFunding/candidates.length:0,
      lhbDailyCoverage:candidates.length?measuredLhb/candidates.length:0,
      lhbDisclosureRatio:candidates.length?lhbDisclosures/candidates.length:0,
      fundingInputCount:measuredFunding,
      fundingSignalCount:positiveFunding,
      lhbMeasuredCount:measuredLhb,
      lhbDisclosureCount:lhbDisclosures
    }
  };
}
function dailyReturn(selected,rowsFuture,horizon) {
  const entryRows=rowsFuture[0],exitRows=rowsFuture[horizon-1];
  const candidateResults=[];
  for(const candidate of selected) {
    const code=String(candidate.code);
    const path=rowsFuture.map(day=>day.get(code)??null);
    if(path.some(row=>!row))continue;
    const entryOpen=num(path[0]?.open),exitClose=num(path[horizon-1]?.price??path[horizon-1]?.close);
    const closes=path.map(row=>num(row?.price??row?.close));
    if(entryOpen===null||entryOpen<=0||exitClose===null||exitClose<=0
      ||closes.some(value=>value===null||value<=0))continue;
    let peak=1,maxDrawdown=0;
    for(const close of closes) {
      const wealth=close/entryOpen;
      peak=Math.max(peak,wealth);
      maxDrawdown=Math.min(maxDrawdown,(wealth/peak-1)*100);
    }
    const highs=path.map(row=>num(row?.high));
    const lows=path.map(row=>num(row?.low));
    candidateResults.push({
      code,
      returnPct:(exitClose/entryOpen-1)*100,
      maxDrawdownPct:maxDrawdown,
      maxFavorablePct:highs.every(Number.isFinite)?(Math.max(...highs)/entryOpen-1)*100:null,
      maxAdversePct:lows.every(Number.isFinite)?(Math.min(...lows)/entryOpen-1)*100:null
    });
  }
  const benchmarkReturns=[];
  for(const [code] of entryRows) {
    const path=rowsFuture.map(day=>day.get(code)??null);
    if(path.some(row=>!row))continue;
    const entryOpen=num(path[0]?.open),exit=num(path[horizon-1]?.price??path[horizon-1]?.close);
    const closes=path.map(row=>num(row?.price??row?.close));
    if(entryOpen===null||entryOpen<=0||exit===null||exit<=0
      ||closes.some(value=>value===null||value<=0))continue;
    benchmarkReturns.push((exit/entryOpen-1)*100);
  }
  return {candidateResults,benchmarkReturns};
}
function exactLimitUpEvents(future) {
  const events=new Set();
  for(const snapshot of future) {
    const pools=snapshot?.market?.limitPools;
    const status=pools?.sourceStatus?.limitUp??(pools?.status==='AVAILABLE'?'AVAILABLE':'NOT_MEASURABLE');
    if(status!=='AVAILABLE')return {status:'NOT_MEASURABLE',events:[]};
    for(const row of Array.isArray(pools?.limitUp)?pools.limitUp:[]) {
      const code=String(row.code??'');
      if(/^(00|60)\d{4}$/.test(code)&&!/(?:\*?ST|退)/i.test(String(row.name??'')))events.add(code);
    }
  }
  return {status:'AVAILABLE',events:[...events]};
}
function metricForSelection(selected,future,horizon) {
  if(!selected.length)return {status:'NOT_MEASURABLE',horizon,selectedCount:0,maturedCount:0};
  const result=dailyReturn(selected,future.map(rowsByCode),horizon);
  const returns=result.candidateResults.map(row=>row.returnPct);
  const benchmark=mean(result.benchmarkReturns);
  const exact=exactLimitUpEvents(future);
  const selectedCodes=new Set(selected.map(row=>String(row.code)));
  const captured=exact.status==='AVAILABLE'?exact.events.filter(code=>selectedCodes.has(code)).length:null;
  return {
    status:result.candidateResults.length===selected.length?'MEASURABLE':'PARTIAL',
    horizon,
    selectedCount:selected.length,
    maturedCount:result.candidateResults.length,
    coverage:selected.length?result.candidateResults.length/selected.length:0,
    meanReturnPct:mean(returns),
    medianReturnPct:median(returns),
    positiveRatio:returns.length?returns.filter(value=>value>0).length/returns.length:null,
    hit5PctRatio:returns.length?returns.filter(value=>value>=5).length/returns.length:null,
    benchmarkMeanPct:benchmark,
    excessMeanPct:mean(returns)===null||benchmark===null?null:mean(returns)-benchmark,
    meanMaxDrawdownPct:mean(result.candidateResults.map(row=>row.maxDrawdownPct)),
    meanMaxFavorablePct:mean(result.candidateResults.map(row=>row.maxFavorablePct).filter(Number.isFinite)),
    meanMaxAdversePct:mean(result.candidateResults.map(row=>row.maxAdversePct).filter(Number.isFinite)),
    exactLimitUpStatus:exact.status,
    exactLimitUpEventCount:exact.status==='AVAILABLE'?exact.events.length:null,
    exactLimitUpCapturedCount:captured,
    exactLimitUpCaptureRate:exact.status==='AVAILABLE'&&exact.events.length?captured/exact.events.length:null,
    exactLimitUpPrecision:exact.status==='AVAILABLE'?captured/selected.length:null,
    returnSumPct:returns.reduce((sum,value)=>sum+value,0),
    positiveCount:returns.filter(value=>value>0).length,
    hit5Count:returns.filter(value=>value>=5).length,
    executionFillability:'NOT_MEASURABLE_DAILY_OPEN_CLOSE_ONLY'
  };
}
function median(values) {
  const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);
  if(!sorted.length)return null;
  const mid=Math.floor(sorted.length/2);
  return sorted.length%2?sorted[mid]:(sorted[mid-1]+sorted[mid])/2;
}
function aggregateMetrics(metrics,minSignalDates) {
  const eligible=metrics.filter(row=>row.status==='MEASURABLE'||row.status==='PARTIAL');
  const values=field=>eligible.map(row=>row[field]).filter(Number.isFinite);
  const average=field=>mean(values(field));
  const totalMatured=eligible.reduce((sum,row)=>sum+(row.maturedCount??0),0);
  const totalSelected=eligible.reduce((sum,row)=>sum+(row.selectedCount??0),0);
  const exactRows=eligible.filter(row=>row.exactLimitUpStatus==='AVAILABLE');
  const exactEvents=exactRows.reduce((sum,row)=>sum+(row.exactLimitUpEventCount??0),0);
  const exactCaptured=exactRows.reduce((sum,row)=>sum+(row.exactLimitUpCapturedCount??0),0);
  const exactSelected=exactRows.reduce((sum,row)=>sum+(row.selectedCount??0),0);
  const totalReturn=eligible.reduce((sum,row)=>sum+(row.returnSumPct??0),0);
  const totalPositive=eligible.reduce((sum,row)=>sum+(row.positiveCount??0),0);
  const totalHit5=eligible.reduce((sum,row)=>sum+(row.hit5Count??0),0);
  return {
    signalDateCount:eligible.length,
    maturedCandidates:totalMatured,
    selectedCandidates:totalSelected,
    sampleCoverage:totalSelected?totalMatured/totalSelected:0,
    meanReturnPct:totalMatured?totalReturn/totalMatured:null,
    medianReturnPct:average('medianReturnPct'),
    positiveRatio:totalMatured?totalPositive/totalMatured:null,
    hit5PctRatio:totalMatured?totalHit5/totalMatured:null,
    meanBenchmarkPct:average('benchmarkMeanPct'),
    meanExcessPct:average('excessMeanPct'),
    meanMaxDrawdownPct:average('meanMaxDrawdownPct'),
    meanMaxFavorablePct:average('meanMaxFavorablePct'),
    meanMaxAdversePct:average('meanMaxAdversePct'),
    exactLimitUpSignalDateCount:exactRows.length,
    exactLimitUpEventCount:exactEvents,
    exactLimitUpCapturedCount:exactCaptured,
    exactLimitUpCaptureRate:exactEvents?exactCaptured/exactEvents:null,
    exactLimitUpPrecision:exactSelected?exactCaptured/exactSelected:null,
    status:eligible.length>=minSignalDates?'MEASURABLE':eligible.length?'PARTIAL':'NOT_MEASURABLE'
  };
}
function comparison(variant,baseline) {
  const delta=(field)=>Number.isFinite(variant[field])&&Number.isFinite(baseline[field])
    ?Number((variant[field]-baseline[field]).toFixed(4)):null;
  return {
    meanReturnDeltaPct:delta('meanReturnPct'),
    positiveRatioDelta:delta('positiveRatio'),
    excessReturnDeltaPct:delta('meanExcessPct'),
    drawdownDeltaPct:delta('meanMaxDrawdownPct'),
    exactLimitUpCaptureDelta:delta('exactLimitUpCaptureRate')
  };
}
export function evaluateFlowLhbAblation({
  snapshots=[],
  asOf=null,
  topKs=[10,30,50],
  horizons=[1,3,5],
  minSignalDates=20
}={}) {
  const history=dedupeSnapshots(snapshots,asOf);
  const signals=history.map((snapshot,index)=>({snapshot,index}))
    .filter(({snapshot})=>qualified(snapshot));
  const variants=['baseline','funding','lhb','combined'];
  const daily=[];
  const samples=new Map();
  for(const variant of variants) {
    samples.set(variant,new Map(topKs.map(topK=>[topK,new Map(horizons.map(horizon=>[horizon,[]]))])));
  }
  const coverage={signalDates:signals.length,limitPoolAvailableDates:0,lhbDailyAvailableDates:0,lhbSeatAvailableDates:0,fundingInputCoverage:[],fundingSignalCoverage:[],lhbDailyCoverage:[]};
  for(const {snapshot,index} of signals) {
    const ranking=rankV15Stage1Candidates(snapshot.stockRows,snapshot.market?.indices??[]);
    const scored=scoreCandidates(snapshot,history,index,ranking);
    const context=marketContext(snapshot);
    if(context.limitUpStatus==='AVAILABLE'&&context.brokenBoardStatus==='AVAILABLE'&&context.limitDownStatus==='AVAILABLE')coverage.limitPoolAvailableDates++;
    if(available(context.lhbDailyStatus))coverage.lhbDailyAvailableDates++;
    if(available(context.lhbSeatStatus))coverage.lhbSeatAvailableDates++;
    coverage.fundingInputCoverage.push(scored.diagnostics.fundingInputCoverage);
    coverage.fundingSignalCoverage.push(scored.diagnostics.fundingSignalCoverage);
    coverage.lhbDailyCoverage.push(scored.diagnostics.lhbDailyCoverage);
    const futureByHorizon={};
    for(const horizon of horizons) {
      const future=history.slice(index+1,index+horizon+1);
      let status='IMMATURE';
      if(future.length===horizon) {
        status='MEASURABLE';
        for(let day=0;day<future.length;day++) {
          if(!expectedNextSession(day===0?dateOf(snapshot):dateOf(future[day-1]),dateOf(future[day])))status='CALENDAR_GAP';
          if(!qualified(future[day]))status='DATA_GAP';
        }
      }
      futureByHorizon[horizon]={status,future};
    }
    const dailyVariants={};
    for(const variant of variants) {
      dailyVariants[variant]={};
      for(const topK of topKs) {
        const ranked=scored.candidates.slice().sort((a,b)=>
          (b.scores[variant]-a.scores[variant])||a.code.localeCompare(b.code));
        const selected=ranked.slice(0,topK);
        const horizonsOut={};
        for(const horizon of horizons) {
          const futureInfo=futureByHorizon[horizon];
          const metric=futureInfo.status==='MEASURABLE'
            ?metricForSelection(selected,futureInfo.future,horizon)
            :{status:futureInfo.status,horizon,selectedCount:selected.length,maturedCount:0};
          horizonsOut['T+'+horizon]=metric;
          if(metric.status==='MEASURABLE'||metric.status==='PARTIAL')samples.get(variant).get(topK).get(horizon).push(metric);
        }
        dailyVariants[variant]['top'+topK]={
          selectedCount:selected.length,
          top:selected.slice(0,Math.min(10,selected.length)).map(row=>({
            code:row.code,name:row.name,baselineScore:row.scores.baseline,
            fundingAblationScore:row.fundingAblationScore,fundingSignalScore:row.fundingEvidence.fundingScore,
            fundingInputMeasured:row.fundingInputMeasured,lhbScore:row.lhbEvidence.score,
            enhancedScore:row.scores[variant]
          })),
          horizons:horizonsOut
        };
      }
    }
    daily.push({
      tradeDate:dateOf(snapshot),
      capturedAt:snapshot.capturedAt,
      rankingStatus:ranking.status,
      candidateCount:ranking.candidateCount,
      factorCoverage:scored.diagnostics,
      marketContext:context,
      topK:dailyVariants
    });
  }
  const aggregate={};
  for(const variant of variants) {
    aggregate[variant]={};
    for(const topK of topKs) {
      aggregate[variant]['top'+topK]={};
      for(const horizon of horizons) {
        aggregate[variant]['top'+topK]['T+'+horizon]=aggregateMetrics(samples.get(variant).get(topK).get(horizon),minSignalDates);
      }
    }
  }
  const comparisonReport={};
  for(const variant of variants) {
    if(variant==='baseline')continue;
    comparisonReport[variant]={};
    for(const topK of topKs) {
      comparisonReport[variant]['top'+topK]={};
      for(const horizon of horizons) {
        const current=aggregate[variant]['top'+topK]['T+'+horizon];
        const base=aggregate.baseline['top'+topK]['T+'+horizon];
        comparisonReport[variant]['top'+topK]['T+'+horizon]=comparison(current,base);
      }
    }
  }
  const maturedCounts=variants.flatMap(variant=>topKs.flatMap(topK=>horizons.map(horizon=>
    aggregate[variant]['top'+topK]['T+'+horizon].signalDateCount)));
  const minimumMaturedSignalDates=maturedCounts.length?Math.min(...maturedCounts):0;
  const status=minimumMaturedSignalDates>=minSignalDates?'MEASURABLE':signals.length?'PARTIAL':'NOT_MEASURABLE';
  return {
    schema:'ashare-v16-flow-lhb-ablation-v1',
    asOf:String(asOf??history.at(-1)?.tradeDate??'').slice(0,10)||null,
    inputSnapshotCount:Array.isArray(snapshots)?snapshots.length:0,
    uniqueTradeDates:history.length,
    eligibleSignalDates:signals.length,
    rankingMethod:'V15_STAGE1_BASELINE_VS_POST_CLOSE_FUNDING_LHB_ABLATION',
    executionConvention:{
      signal:'Signal features are frozen after the post-close snapshot, including disclosed LHB data.',
      entry:'Earliest modeled entry is the next trading session open; no same-close fill is assumed.',
      exit:'T+1/T+3/T+5 close measured from the next-session open.',
      benchmark:'Equal-weighted main-board, non-ST cohort with complete entry-open and exit-close prices.',
      exactLimitUp:'Uses future Eastmoney limit-up event pools; vendor labels are not exchange-certified order-book proof.',
      execution:'No fees, slippage, auction queue, intraday fill, limit-lock or T+1 sellability simulation.'
    },
    variants:{
      baseline:'Reconstructed V15 Stage-1 ranking without new flow/LHB factors.',
      funding:'90% baseline + 10% main-force net-flow persistence score; institutional LHB is excluded so the funding and LHB ablations remain independent. Complete three-session inputs with no confirmed main-flow persistence score 0; incomplete inputs leave baseline unchanged.',
      lhb:'95% baseline score + 5% same-session disclosed LHB net-buy percentile; absent LHB disclosure is neutral, unavailable feed is missing.',
      combined:'85% baseline + 10% funding + 5% LHB when both measured; measured absence of funding persistence scores 0, incomplete feeds are not imputed.'
    },
    minimumSignalDatesForMetric:minSignalDates,
    status,
    promotionEligible:false,
    minimumMaturedSignalDates,
    coverage:{
      ...coverage,
      averageFundingInputCoverage:mean(coverage.fundingInputCoverage),
      averageFundingSignalCoverage:mean(coverage.fundingSignalCoverage),
      averageLhbDailyCoverage:mean(coverage.lhbDailyCoverage)
    },
    aggregate,
    comparison:comparisonReport,
    daily,
    limitations:[
      'This is a research ablation of the reconstructed V15 Stage-1 funnel, not the final V15 deep-score/news model or the production one-click selector.',
      'The funding ablation uses main-force net-flow persistence and higher lows only; institutional LHB is deliberately excluded to avoid double-counting the separately tested LHB factor.',
      'Funding features require three consecutive qualified prior/current full-market daily snapshots; absent rows or low/price/mainNet inputs remain NOT_MEASURABLE.',
      'LHB is a post-close abnormal-trading disclosure, not a full-market investor-flow feed; no disclosure is treated as neutral, not as zero net buying.',
      'Limit-up event labels come from the vendor pool. Exact intraday first-touch, reopen, seal duration and order-book events remain NOT_MEASURABLE.',
      'Signal-day LHB information cannot be filled at that same close; modeled entry starts at the next trading session open.',
      'A daily open/close replay is not a fill simulation. Fees, slippage, queue priority, limit locks and T+1 sellability remain unmodeled.',
      'At least 20 matured signal dates are required for each Top-K/horizon metric; passing this threshold is not production authorization.',
      'Snapshots must be point-in-time frozen. Mutating future outcomes must not change signal-date candidate rankings.'
    ]
  };
}
export const _internal={expectedNextSession,qualified,lhbEvidence,marketContext,metricForSelection};
