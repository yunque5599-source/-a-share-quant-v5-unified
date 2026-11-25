import { mergeV16Config } from './v16_config.js';
import {classifyVolumePricePhase} from './v16/volume_price_phase.js';
const finite=x=>typeof x==='number' && Number.isFinite(x);
const clamp=(x,a=0,b=100)=>Math.max(a,Math.min(b,x));
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const sum=a=>a.reduce((s,x)=>s+x,0);
const round=x=>Math.round(x*10000)/10000;
const time=x=>typeof x==='string' && /(?:Z|[+-]\d\d:\d\d)$/.test(x)?Date.parse(x):NaN;
const day=x=>new Date(time(x)+8*3600000).toISOString().slice(0,10);
const known=(x,asOf)=>!!x?.source && Number.isFinite(time(x.availableAt)) && time(x.availableAt)<=time(asOf);
const closeAt=d=>Date.parse(d+'T15:00:00+08:00');
const pct=(a,b)=>b>0?a/b-1:0;
export function stableStringify(x) {
  if(Array.isArray(x)) return '['+x.map(stableStringify).join(',')+']';
  if(x && typeof x==='object') return '{'+Object.keys(x).sort().filter(k=>x[k]!==undefined).map(k=>JSON.stringify(k)+':'+stableStringify(x[k])).join(',')+'}';
  return JSON.stringify(x);
}
// Deterministic content checksum, not a security signature. Raw snapshots must be archived independently.
export function fingerprint(x) {
  const s=stableStringify(x); let a=2166136261,b=5381;
  for(let i=0;i<s.length;i++){a=Math.imul(a^s.charCodeAt(i),16777619);b=Math.imul(b,33)^s.charCodeAt(i);}
  return (a>>>0).toString(16).padStart(8,'0')+(b>>>0).toString(16).padStart(8,'0');
}
function safeDaily(rows,asOf,sourceRequired=true) {
  const visible=(rows||[]).filter(b=>b && /^\d{4}-\d{2}-\d{2}$/.test(b.date||'') &&
    Number.isFinite(time(b.availableAt)) && time(b.availableAt)<=time(asOf) &&
    closeAt(b.date)<=time(asOf) && (!sourceRequired || b.source));
  const ordered=visible.slice().sort((a,b)=>a.date.localeCompare(b.date));
  const duplicate=new Set(ordered.map(b=>b.date)).size!==ordered.length;
  return {rows:ordered,duplicate,rejected:(rows||[]).length-visible.length};
}
export function earlyTrend(bars,c=mergeV16Config()) {
  if(bars.length<c.data.minBars) return {score:0,phase:'A',reasons:[],insufficient:true};
  const s=c.scoring,t=c.trend,last=bars.at(-1),prev=bars.at(-2),cl=bars.map(b=>b.close);
  const ma=(n,offset=0)=>mean(cl.slice(-n-offset,offset?-offset:undefined));
  const ma5=ma(5),ma10=ma(10),ma20=ma(20),ma60=ma(60);
  const prior20=bars.slice(-21,-1),prior60=bars.slice(-61,-1);
  const resistance20=Math.max(...prior20.map(b=>b.high)),resistance60=Math.max(...prior60.map(b=>b.high));
  const atrs=bars.map((b,i)=>Math.max(b.high-b.low,i?Math.abs(b.high-bars[i-1].close):0,i?Math.abs(b.low-bars[i-1].close):0));
  const atr=mean(atrs.slice(-14)),compression=mean(atrs.slice(-6,-1))<mean(atrs.slice(-21,-6))*t.compressionRatio;
  const expansion=atrs.at(-1)>mean(atrs.slice(-6,-1))*t.expansionRatio;
  const volumeRatio=last.volume/Math.max(1,mean(prior20.slice(-5).map(b=>b.volume)));
  const volumeRatio20=last.volume/Math.max(1,mean(prior20.map(b=>b.volume)));
  const amountRatio5=last.amount/Math.max(1,mean(prior20.slice(-5).map(b=>b.amount)));
  const turnoverRatio5=finite(last.turnover)&&prior20.slice(-5).every(b=>finite(b.turnover))?
    last.turnover/Math.max(0.000001,mean(prior20.slice(-5).map(b=>b.turnover))):null;
  const amountRatio20=last.amount/Math.max(1,mean(prior20.map(b=>b.amount)));
  const ret5=pct(last.close,cl.at(-6)),ret10=pct(last.close,cl.at(-11));
  const deviation20=pct(last.close,ma20),deviation60=pct(last.close,ma60);
  const baseWidth=pct(Math.max(...prior20.map(b=>b.high)),Math.min(...prior20.map(b=>b.low)));
  const breakout20=last.close>resistance20*(1+t.breakoutBuffer);
  const breakout60=last.close>resistance60*(1+t.breakoutBuffer);
  const firstBreakout=breakout20 && !bars.slice(-5,-1).some((b,j)=>{
    const index=bars.length-5+j,level=Math.max(...bars.slice(index-20,index).map(x=>x.high));
    return b.close>level*(1+t.breakoutBuffer);
  });
  const moderateVolume=volumeRatio>=t.moderateVolumeMin && volumeRatio<=t.moderateVolumeMax;
  const closeLocation=(last.close-last.low)/Math.max(last.high-last.low,0.000001);
  const upperWick=(last.high-Math.max(last.open,last.close))/Math.max(last.high-last.low,0.000001);
  const reclaim10=last.close>ma10 && prev.close<=ma(10,1);
  const reclaim20=last.close>ma20 && prev.close<=ma(20,1);
  const turning=ma5>ma(5,1) && ma10>ma(10,1) && ma20>=ma(20,1);
  const order=ma5>ma10 && ma10>ma20;
  const priorResistance=Math.max(...bars.slice(-22,-2).map(b=>b.high));
  const held=prev.close>priorResistance*(1+t.breakoutBuffer) && last.close>=priorResistance*(1-t.holdBuffer) && last.close>=prev.close*(1-t.holdBuffer);
  const failed=(last.high>resistance20 && last.close<resistance20*(1-t.failureBuffer)) ||
    (prev.close>priorResistance*(1+t.breakoutBuffer) && last.close<priorResistance*(1-t.failureBuffer));
  const reasons=[];
  if(turning) reasons.push('MA5/10/20拐头向上');
  if(reclaim10||reclaim20) reasons.push('重新站上MA10/20');
  if(firstBreakout) reasons.push('首次有效突破20日压力');
  if(breakout60) reasons.push('突破60日压力');
  if(compression&&expansion) reasons.push('ATR收缩后扩张');
  if(moderateVolume) reasons.push('温和放量');
  if(held) reasons.push('突破后价格维持强度');
  let score=s.base+(turning?s.maTurn:0)+(order?s.maOrder:0)+((reclaim10||reclaim20)?s.reclaim:0)+
    (firstBreakout?s.breakout20:0)+(breakout60?s.breakout60:0)+((compression&&expansion)?s.compression:0)+(held?s.hold:0);
  let phase='A';
  if((firstBreakout||reclaim20) && moderateVolume && closeLocation>=t.minCloseLocation && baseWidth<=t.maxBaseWidth) phase='B';
  if(held && moderateVolume && closeLocation>=t.minCloseLocation) phase='C';
  if(ret5>=t.acceleratedReturn5 || deviation20>t.maxEarlyDeviation20) phase='D';
  if(ret5>=t.overheatedReturn5 || deviation20>t.overheatedDeviation20) phase='E';
  if(phase==='D') score-=c.risk.accelerationPenalty;
  if(phase==='E') score-=c.risk.overheatPenalty;
  return {score:round(clamp(score)),phase,reasons,ma5,ma10,ma20,ma60,ret5,ret10,deviation20,deviation60,
    resistance20,resistance60,atrRatio:atr/last.close,volumeRatio,amountRatio20,moderateVolume,
    volumeRatio20,amountRatio5,turnoverRatio5,upperWick,closeLocation,firstBreakout,held,failed,compression,expansion,baseWidth,
    early:ret5<=t.maxEarlyReturn5 && deviation20<=t.maxEarlyDeviation20};
}
export function flowContinuity(raw,bars,asOf,c=mergeV16Config()) {
  const f=safeDaily(raw,asOf),dates=bars.slice(-5).map(b=>b.date),rows=f.rows.filter(r=>dates.includes(r.date));
  const complete=!f.duplicate && rows.length===5 && dates.every(d=>rows.some(r=>r.date===d)) &&
    rows.every(r=>finite(r.netMain)&&finite(r.amount)&&r.amount>0&&typeof r.estimated==='boolean');
  if(!complete) return {score:0,complete:false,positive:false,warnings:['资金3/5日历史不足，缺失值不视为流入'],sourceType:'NOT_MEASURABLE'};
  const values=rows.map(r=>r.netMain),net1=values.at(-1),net3=sum(values.slice(-3)),net5=sum(values);
  const ratio=net5/sum(rows.map(r=>r.amount)),positiveDays=values.filter(x=>x>0).length;
  let streak=0;for(let i=values.length-1;i>=0 && values[i]>0;i--)streak++;
  const positive=net1>0&&net3>0&&net5>0&&positiveDays>=c.flow.minPositiveDays&&ratio>=c.flow.minRatio;
  const reversal=values.slice(0,-1).some((x,i,a)=>x>mean(a.filter((_,j)=>i!==j).map(Math.abs))*c.flow.spikeMultiple) && net1<0;
  const score=clamp(c.scoring.flowBase+positiveDays/5*c.scoring.flowContinuity+
    ((net3>0&&net5>0)?c.scoring.flowPositiveWindows:0)+ratio*c.scoring.flowScale);
  return {score:round(score),complete:true,positive,net1,net3,net5,ratio,positiveDays,streak,reversal,
    persistentOutflow:net3<0&&net5<0,sourceType:rows.some(r=>r.estimated)?'THIRD_PARTY_ESTIMATE':'REPORTED_FLOW_NOT_HOLDINGS',
    warnings:['资金流是供应商口径，不能解释为真实机构持仓']};
}
export function marketRegime(m,asOf,c=mergeV16Config()) {
  const indexRows=Array.isArray(m?.indices)?m.indices:[];
  const uniqueIndexes=new Set(indexRows.map(i=>i?.code));
  const valid=known(m,asOf)&&m.scope==='full-market' && m.verified===true &&
    Math.abs(time(asOf)-time(m.availableAt))<=c.data.maxMarketSkewMinutes*60000 &&
    [m.up,m.down,m.flat,m.limitUp,m.limitDown,m.amount].every(finite) &&
    m.up+m.down+m.flat>0 && m.amount>0 && [m.up,m.down,m.flat,m.limitUp,m.limitDown].every(x=>x>=0) &&
    uniqueIndexes.size===c.market.indices.length &&
    c.market.indices.every(code=>indexRows.filter(i=>i?.code===code).length===1 &&
      indexRows.some(i=>i.code===code&&known(i,asOf)&&finite(i.return1)&&
        Math.abs(time(i.availableAt)-time(m.availableAt))<=c.data.maxMarketSkewMinutes*60000));
  if(!valid) return {regime:'UNKNOWN',pass:false,threshold:100,maxPosition:0,reasons:['缺少时间一致、可验证的全市场及四大指数数据'],missing:['overseas','macro','keyIndustries']};
  const total=m.up+m.down+m.flat,upRatio=m.up/total,r=mean(indexRows.filter(i=>c.market.indices.includes(i.code)).map(i=>i.return1));
  const external=(m.externalEvents||[]).filter(e=>known(e,asOf)&&e.verified===true);
  const overseas=known(m.overseas,asOf)&&m.overseas.verified===true?
    (m.overseas.indices||[]).filter(i=>known(i,asOf)&&i.verified===true&&finite(i.return1)):[];
  const overseasReturn=overseas.length?mean(overseas.map(i=>i.return1)):null;
  const macroSystemic=known(m.macro,asOf)&&m.macro.verified===true&&m.macro.systemicRisk===true;
  let regime='RANGE';
  if(r<=c.market.systemicReturn||upRatio<=c.market.systemicBreadth||m.limitDown/total>=c.market.systemicLimitDownShare||external.some(e=>e.systemicRisk===true)||macroSystemic) regime='SYSTEMIC';
  else if(r<=c.market.weakReturn||upRatio<c.market.weakBreadth||(overseasReturn!==null&&overseasReturn<=c.market.systemicReturn)) regime='WEAK';
  else if(r>=c.market.strongReturn&&upRatio>=c.market.strongBreadth) regime='STRONG';
  const missing=['overseas','macro','keyIndustries'].filter(k=>!known(m[k],asOf)||m[k].verified!==true);
  return {regime,pass:regime!=='SYSTEMIC',threshold:c.market.thresholds[regime],maxPosition:c.market.maxPosition[regime],
    return1:r,upRatio,overseasReturn,macroSystemic,keyIndustryContext:known(m.keyIndustries,asOf)?m.keyIndustries:null,source:m.source,availableAt:m.availableAt,missing,reasons:missing.length?['海外/宏观/重点行业证据存在缺项']:[]};
}
export function industryResonance(raw,asOf,c=mergeV16Config()) {
  const required=['return3','return5','return10','benchmarkReturn5','upShare','amountGrowth','positiveFlowShare','breakout20Share','leaderPersistence','medianReturn','advanceDeclineRatio'];
  const complete=known(raw,asOf)&&raw.scope==='industry'&&raw.verified===true &&
    time(asOf)-time(raw.availableAt)<=c.data.maxMarketSkewMinutes*60000 &&
    required.every(k=>finite(raw[k])) && raw.sampleCount>=c.data.minIndustrySamples &&
    raw.eligibleCount>=raw.sampleCount && raw.sampleCount/raw.eligibleCount>=c.data.minIndustryCoverage && raw.advanceDeclineRatio>=0 &&
    ['upShare','positiveFlowShare','breakout20Share','leaderPersistence'].every(k=>raw[k]>=0&&raw[k]<=1);
  if(!complete) return {score:0,complete:false,confidence:0,warning:'行业样本/来源/时间/指标不足，不计算完整行业广度'};
  const s=c.scoring;
  const score=s.industryBase+mean([raw.return3,raw.return5,raw.return10])*s.industryReturnScale+
    (raw.return5-raw.benchmarkReturn5)*s.industryRelativeScale+(raw.upShare-.5)*s.industryBreadthScale+
    (raw.positiveFlowShare-.5)*s.industryFlowScale+raw.breakout20Share*s.industryBreakoutScale+
    raw.amountGrowth*s.industryAmountScale+raw.leaderPersistence*s.industryLeaderScale+raw.medianReturn*s.industryReturnScale+((raw.advanceDeclineRatio-1)/(raw.advanceDeclineRatio+1))*s.industryAdvanceDeclineScale;
  return {...raw,score:round(clamp(score,0,99)),complete:true,confidence:Math.min(1,raw.sampleCount/raw.eligibleCount),weak:raw.return5<c.industry.weakReturn5};
}
export function exchangeLimits(metadata,asOf) {
  if(!known(metadata,asOf)||!metadata.exchange||!metadata.board||metadata.tradingDate!==day(asOf)||!metadata.ruleSource||
    !Number.isFinite(time(metadata.ruleEffectiveAt))||time(metadata.ruleEffectiveAt)>time(asOf))
    return {status:'NOT_MEASURABLE',reason:'缺少点时证券基础信息及交易所规则'};
  if(metadata.noPriceLimit===true) return {status:'VERIFIED_NO_LIMIT',up:null,down:null};
  if(!finite(metadata.limitUpPrice)||!finite(metadata.limitDownPrice)||metadata.limitUpPrice<=metadata.limitDownPrice||metadata.limitDownPrice<=0)
    return {status:'NOT_MEASURABLE',reason:'缺少当日有效涨跌停价格'};
  return {status:'VERIFIED',up:metadata.limitUpPrice,down:metadata.limitDownPrice,exchange:metadata.exchange,board:metadata.board,ruleSource:metadata.ruleSource};
}
function newsAndQuality(sec,asOf,c) {
  const coverage=sec.evidenceCoverage;
  const coverageFresh=known(coverage,asOf)&&time(asOf)-time(coverage.availableAt)<=c.data.maxSnapshotSkewMinutes*60000;
  const complete=coverageFresh&&coverage.newsComplete===true&&coverage.fundamentalsComplete===true;
  const visible=(sec.news||[]).filter(n=>n.source&&n.url&&Number.isFinite(time(n.publishedAt))&&time(n.publishedAt)<=time(asOf));
  const hard=[],penalties=[],warnings=[],categories=[];
  let score=c.scoring.newsBase;
  const positive=new Set(['earnings_up','contract','product_price','industry_policy','supply_demand','company_event']);
  const negative=new Set(['earnings_down','earnings_reversal','shareholder_sale','pledge','regulatory_penalty','litigation','operating_risk']);
  for(const n of visible) {
    categories.push({category:n.category,impact:n.impact,publishedAt:n.publishedAt,url:n.url});
    if(n.exchangeVerified===true && ['abnormal_volatility','major_risk','delisting'].includes(n.category)) hard.push('ANNOUNCEMENT_'+n.category);
    if(negative.has(n.category)&&['negative','mixed'].includes(n.impact)) penalties.push({code:'NEWS_'+n.category,points:c.risk.earningsPenalty});
    if(positive.has(n.category)&&n.impact==='positive'&&n.businessVerified===true&&n.businessRationale&&n.evidenceUrl) score+=c.scoring.catalystPoints;
    else if(positive.has(n.category)) warnings.push('催化业务关联未核验或影响混合，不加分');
  }
  const f=known(sec.fundamentals,asOf)?sec.fundamentals:null;
  if(f){
    if(finite(f.netProfitGrowth)&&f.netProfitGrowth<c.risk.earningsDecline) penalties.push({code:'EARNINGS_DECLINE',points:c.risk.earningsPenalty});
    if(finite(f.operatingCashFlow)&&f.operatingCashFlow<0 && finite(f.previousOperatingCashFlow)&&f.operatingCashFlow<f.previousOperatingCashFlow)
      penalties.push({code:'CASH_FLOW_DETERIORATION',points:c.risk.cashFlowPenalty});
    if(finite(f.pe)&&finite(f.industryMedianPE)&&f.industryMedianPE>0&&f.pe>f.industryMedianPE*c.risk.valuationRatio)
      penalties.push({code:'VALUATION_DEVIATION',points:c.risk.valuationPenalty});
    if(finite(f.pledgeRatio)&&f.pledgeRatio>c.risk.pledgeRatio) penalties.push({code:'PLEDGE_RISK',points:c.risk.pledgePenalty});
    if(f.auditGoingConcern===true||f.fraudVerified===true||f.severeDeteriorationVerified===true) hard.push('SEVERE_FUNDAMENTAL_RISK');
  }
  const financialComplete=!!f && ['netProfitGrowth','operatingCashFlow','previousOperatingCashFlow','pe','industryMedianPE'].every(k=>finite(f[k])) && /^\d{4}-\d{2}-\d{2}$/.test(f.reportPeriod||'') && f.reportPeriod<=day(asOf);
  if(!complete||!financialComplete) warnings.push('公告/财务点时覆盖未核验，不可进入买入计划评估');
  return {score:round(clamp(score,0,c.scoring.newsMax)),hard,penalties,warnings,categories,complete:complete&&financialComplete};
}
function scoreSecurity(sec,snapshot,market,c,prior) {
  const asOf=snapshot.asOf,asOfDay=day(asOf),d=safeDaily(sec.bars,asOf),bars=d.rows;
  const errors=[],warnings=[],hard=[],penalties=[],reasons=[];
  const add=(code,points)=>penalties.push({code,points});
  if(d.duplicate) errors.push('DUPLICATE_BARS');
  if(bars.some(b=>![b.open,b.high,b.low,b.close,b.volume,b.amount].every(finite)||b.low<=0||b.close<=0||b.volume<0||b.amount<0||b.high<Math.max(b.open,b.close)||b.low>Math.min(b.open,b.close))) errors.push('INVALID_OHLCV');
  if(bars.length<c.data.minBars) errors.push('INSUFFICIENT_HISTORY');
  if(!snapshot.expectedDailyDate||snapshot.expectedDailyDate>asOfDay||closeAt(snapshot.expectedDailyDate)>time(asOf)||bars.at(-1)?.date!==snapshot.expectedDailyDate) errors.push('STALE_OR_UNVERIFIED_DAILY_SESSION');
  const md=sec.metadata,limits=exchangeLimits(md,asOf);
  const metadataFresh=known(md,asOf)&&time(asOf)-time(md.availableAt)<=c.data.maxSnapshotSkewMinutes*60000;
  if(!metadataFresh||typeof md.isST!=='boolean'||typeof md.delistingRisk!=='boolean'||!md.tradingStatus)
    errors.push(metadataFresh?'SECURITY_METADATA_MISSING':'SECURITY_METADATA_STALE');
  else{
    if(md.isST||md.delistingRisk) hard.push('ST_OR_DELISTING');
    if(md.tradingStatus!=='TRADING') hard.push('NOT_TRADING');
  }
  if(limits.status==='NOT_MEASURABLE') errors.push('LIMIT_RULES_MISSING');
  const limitReferenceBar=bars.at(-1);
  const atLimitUp=limits.status==='VERIFIED'&&limitReferenceBar&&limitReferenceBar.close>=limits.up-0.005;
  const atLimitDown=limits.status==='VERIFIED'&&limitReferenceBar&&limitReferenceBar.close<=limits.down+0.005;
  if(atLimitUp) warnings.push('收盘触及涨停价，禁止按普通突破信号追买');
  if(atLimitDown) hard.push('LIMIT_DOWN_CLOSE_RISK');
  const t=errors.some(e=>['INVALID_OHLCV','INSUFFICIENT_HISTORY','DUPLICATE_BARS'].includes(e))?{score:0,phase:'A',reasons:[],insufficient:true}:earlyTrend(bars,c);
  const f=flowContinuity(sec.moneyFlow,bars,asOf,c);
  const volumePhase=classifyVolumePricePhase(bars,{asOf,breakoutLevel:t.resistance20});
  const industryRaw=(snapshot.industries||[]).find(i=>i.industry===sec.industry);
  const ind=industryResonance(industryRaw?.throughDate===snapshot.expectedDailyDate?industryRaw:null,asOf,c);
  const news=newsAndQuality(sec,asOf,c);
  hard.push(...news.hard);penalties.push(...news.penalties);warnings.push(...news.warnings,...f.warnings);
  if(!ind.complete) warnings.push(ind.warning);
  if(d.rejected) warnings.push('扫描后/未公开/无来源日线已排除: '+d.rejected);
  if(!f.complete) warnings.push('FLOW_NOT_MEASURABLE');
  if(t.phase==='E') add('OVERHEATED',c.risk.overheatPenalty);
  else if(t.phase==='D') add('ACCELERATED',c.risk.accelerationPenalty);
  if(t.failed) {add('FAILED_BREAKOUT',c.risk.failedBreakoutPenalty);hard.push('BREAKOUT_INVALIDATED');}
  if(f.persistentOutflow) add('PERSISTENT_OUTFLOW',c.flow.outflowPenalty);
  if(f.reversal) add('FLOW_SPIKE_REVERSAL',c.flow.spikePenalty);
  if(ind.weak) add('WEAK_INDUSTRY',c.industry.weakPenalty);
  const last=bars.at(-1),prev=bars.at(-2);
  if(t.upperWick>c.volume.upperWickRatio) add('LONG_UPPER_WICK',c.volume.riskPenalty);
  if(last?.turnover>c.volume.highTurnover) add('ABNORMAL_TURNOVER',c.volume.riskPenalty);
  if(t.volumeRatio>c.volume.extremeRatio && Math.abs(pct(last.close,prev.close))<c.volume.stagnantReturn) add('HIGH_VOLUME_STAGNATION',c.volume.riskPenalty);
  if(market.regime==='SYSTEMIC'&&t.atrRatio>c.market.volatilityThreshold) add('SYSTEMIC_VOLATILITY',c.market.systemicVolatilityPenalty);
  if(errors.length) hard.push('DATA_QUALITY');
  const benchRaw=snapshot.market?.benchmarkReturns;
  const bench=benchRaw?.throughDate===snapshot.expectedDailyDate&&known(benchRaw,asOf)&&
    time(asOf)-time(benchRaw.availableAt)<=c.data.maxSnapshotSkewMinutes*60000?benchRaw:null;
  const rs=known(bench,asOf)&&[bench.return5,bench.return10].every(finite)&&ind.complete&&!t.insufficient?
    clamp(c.scoring.rsBase+mean([t.ret5-bench.return5,t.ret10-bench.return10])*c.scoring.rsScale+(t.ret5-ind.return5)*c.scoring.rsIndustryScale):0;
  const constructive=!t.insufficient&&bars.slice(-5).filter((b,i,a)=>i&&b.close<a[i-1].close).every((b,i,a)=>b.volume<mean(bars.slice(-20,-5).map(x=>x.volume)));
  const vp=t.insufficient?0:clamp(c.scoring.volumeBase+(t.moderateVolume?c.scoring.moderateVolume:0)+(constructive?c.scoring.constructive:0)-(t.upperWick>c.volume.upperWickRatio?c.volume.riskPenalty:0));
  const scores={earlyTrend:t.score,relativeStrength:round(rs),volumePrice:round(vp),fundFlow:f.score,industry:ind.score,news:news.score,
    liquidity:last?round(clamp(last.amount/c.scoring.liquidityTargetAmount*100,0,c.scoring.liquidityMax)):0};
  let gross=sum(Object.entries(c.weights).map(([key,w])=>scores[key]*w/100));
  if(market.regime==='SYSTEMIC'&&['C','D','E'].includes(t.phase)) gross-=scores.earlyTrend*c.weights.earlyTrend/100*(1-c.market.systemicBreakoutMultiplier);
  const penalty=sum(penalties.map(p=>p.points)),score=round(clamp(gross-penalty));
  let state='WATCH';
  const priorActive=!!prior&&['TRIGGERED','CONFIRMED'].includes(prior.state);
  const flowReversalInvalidated=priorActive&&(f.persistentOutflow||f.reversal);
  const breakoutInvalidated=priorActive&&finite(prior.breakoutLevel)&&last?.close<prior.breakoutLevel*(1-c.trend.failureBuffer);
  if(flowReversalInvalidated) hard.push('FLOW_REVERSAL_INVALIDATED');
  if(breakoutInvalidated) hard.push('BREAKOUT_INVALIDATED');
  const invalidated=hard.length>0||flowReversalInvalidated||breakoutInvalidated;
  if(invalidated) state='INVALIDATED';
  else if(['B','C'].includes(t.phase)&&t.early) {
    state='TRIGGERED';
    if(t.phase==='C'&&f.positive&&ind.complete&&ind.score>=c.industry.minConfirmationScore&&!ind.weak&&
      news.complete&&market.pass&&known(bench,asOf)&&score>=market.threshold&&!atLimitUp) state='CONFIRMED';
  }
  const dataQuality={status:errors.length?'INSUFFICIENT':(!f.complete||!ind.complete||!news.complete?'PARTIAL':'VERIFIED'),
    errors,warnings,capabilities:{daily:!errors.length,volumePricePhase:volumePhase.status,intraday:'NOT_MEASURABLE',orderBook:'NOT_MEASURABLE',fundFlow:f.complete,industry:ind.complete,newsAndFundamentals:news.complete}};
  reasons.push(...t.reasons);
  if(f.positive) reasons.push('3/5日资金为正且连续性通过');
  if(volumePhase.status==='AVAILABLE') reasons.push('量价阶段：'+volumePhase.label+'（研究层，不改主评分）');
  if(ind.complete) reasons.push('独立行业样本广度核验通过');
  return {code:String(sec.code),name:sec.name||String(sec.code),industry:sec.industry||'未知',price:last?.close??null,
    pct:last&&prev?round(pct(last.close,prev.close)*100):null,score,grossScore:round(gross),scores,technicalScore:t.score,
    state,phase:t.phase,trend:t,flow:f,volumePricePhase:volumePhase,
    volumePhaseResearchScore:round(clamp(score+volumePhase.researchAdjustment)),
    industryEvidence:ind,newsEvidence:news,
    risk:{hardVeto:[...new Set(hard)].sort(),penalties,warnings,penalty},
    volumePriceStatus:t.moderateVolume?'温和放量':t.volumeRatio>c.volume.extremeRatio?'异常放量':'待观察',
    triggerReasons:reasons,invalidationConditions:['收盘跌破启动压力位 '+round((prior?.breakoutLevel??t.resistance20??0)*(1-c.trend.failureBuffer)),'3/5日资金反转','重大公告或数据质量风险'],
    breakoutLevel:prior?.breakoutLevel??t.resistance20??null,dataUpdatedAt:last?.availableAt??null,dataQuality,
    entryBlocked:!!atLimitUp,
    buyPlanEligible:state==='CONFIRMED'&&hard.length===0&&dataQuality.status==='VERIFIED'&&market.pass&&!atLimitUp,
    execution:'SHADOW_NO_ORDERS',firstSeenAt:prior?.firstSeenAt??null,
    firstTriggeredAt:prior?.firstTriggeredAt??(['TRIGGERED','CONFIRMED'].includes(state)?asOf:null),
    firstConfirmedAt:prior?.firstConfirmedAt??(state==='CONFIRMED'?asOf:null),
    invalidatedAt:prior?.invalidatedAt??(state==='INVALIDATED'?asOf:null)};
}
export function scanV16(snapshot,previous={},overrides={}) {
  const c=mergeV16Config(overrides);
  if(!Number.isFinite(time(snapshot?.asOf))) throw Error('Explicit timezone asOf required');
  if(!snapshot.id||!snapshot.universeId||!Array.isArray(snapshot.securities)) throw Error('snapshot id/universeId/securities required');
  const cfg=fingerprint(c),fp=fingerprint(snapshot),asOf=snapshot.asOf;
  const compatible=previous.modelVersion===c.modelVersion&&previous.configFingerprint===cfg&&previous.universeId===snapshot.universeId;
  if(compatible&&time(previous.lastAsOf)>time(asOf)) throw Error('Pool state cannot travel backwards in time');
  if(compatible&&previous.lastFingerprint===fp&&previous.lastResult) return JSON.parse(JSON.stringify({...previous.lastResult,poolState:previous}));
  const entries=compatible?previous.entries||{}:{};
  const market=marketRegime(snapshot.market,asOf,c);
  const stale=!snapshot.capturedAt||!Number.isFinite(time(snapshot.capturedAt))||
    time(snapshot.capturedAt)>time(asOf)||time(asOf)-time(snapshot.capturedAt)>c.data.maxSnapshotSkewMinutes*60000;
  if(stale){market.pass=false;market.maxPosition=0;market.reasons.push('快照过期或采集时间无效');}
  const calendar=snapshot.calendar;
  const sessions=Array.isArray(calendar?.tradingDates)?calendar.tradingDates:[];
  const lastCompleted=sessions.filter(d=>/^\d{4}-\d{2}-\d{2}$/.test(d)&&closeAt(d)<=time(asOf)).sort().at(-1);
  const calendarValid=known(calendar,asOf)&&time(asOf)-time(calendar.availableAt)<=c.data.maxSnapshotSkewMinutes*60000&&
    calendar.verified===true&&calendar.coverageThrough>=day(asOf)&&lastCompleted===snapshot.expectedDailyDate;
  if(!calendarValid){market.pass=false;market.maxPosition=0;market.reasons.push('交易日历或最近完整交易日未核验');}
  const universe=snapshot.universeCoverage;
  const calculatedCoverage=finite(universe?.expectedCount)&&universe.expectedCount>0?
    universe.observedCount/universe.expectedCount:NaN;
  const universeValid=known(universe,asOf)&&time(asOf)-time(universe.availableAt)<=c.data.maxSnapshotSkewMinutes*60000&&
    universe.verified===true&&universe.scope==='eligible-universe'&&universe.tradingDate===snapshot.expectedDailyDate&&
    Number.isInteger(universe.expectedCount)&&universe.expectedCount>0&&
    Number.isInteger(universe.observedCount)&&universe.observedCount===snapshot.securities.length&&
    finite(universe.coverage)&&universe.coverage>=0.99&&universe.coverage<=1.01&&
    Number.isFinite(calculatedCoverage)&&Math.abs(calculatedCoverage-universe.coverage)<=0.01;
  if(!universeValid){market.pass=false;market.maxPosition=0;market.reasons.push('选股证券池覆盖不足或未核验，禁止形成候选信号');}
  const sorted=snapshot.securities.slice().sort((a,b)=>String(a.code).localeCompare(String(b.code)));
  if(new Set(sorted.map(s=>String(s.code))).size!==sorted.length) throw Error('Duplicate security code');
  const all=sorted.map(sec=>scoreSecurity(sec,snapshot,market,c,entries[sec.code]));
  if(stale||!calendarValid||!universeValid) for(const row of all){
    row.risk.hardVeto.push(stale?'STALE_SNAPSHOT':!calendarValid?'TRADING_CALENDAR_MISSING':'UNIVERSE_COVERAGE_INSUFFICIENT');
    row.state='INVALIDATED';row.buyPlanEligible=false;row.dataQuality.status='INSUFFICIENT';row.invalidatedAt=row.invalidatedAt||asOf;
  }
  const eligible=all.filter(r=>r.state!=='INVALIDATED'&&!['D','E'].includes(r.phase));
  // A fixed incumbent bonus implements hysteresis without an inconsistent pairwise comparator.
  eligible.sort((a,b)=>(b.score+(entries[b.code]?.inPool?c.pool.retentionMargin:0))-
    (a.score+(entries[a.code]?.inPool?c.pool.retentionMargin:0))||b.score-a.score||a.code.localeCompare(b.code));
  const candidates=eligible.slice(0,c.pool.maxSize);
  const selected=new Set(candidates.map(r=>r.code)),nextEntries={...entries},removed=[];
  for(const row of all){
    const p=entries[row.code],rank=candidates.findIndex(r=>r.code===row.code)+1;
    if(selected.has(row.code)&&!row.firstSeenAt) row.firstSeenAt=asOf;
    row.rank=rank||null;row.previousRank=p?.rank??null;row.scoreChange=p?round(row.score-p.score):null;
    row.rankChangeReasons=!p?['首次进入扫描']:row.risk.hardVeto.length?row.risk.hardVeto:
      [row.state!==p.state?'趋势状态变化 '+p.state+' → '+row.state:'',
       row.score!==p.score?'因子/风险分变化 '+round(row.score-p.score):'',
       p.rank!==row.rank?'候选相对排名/保留门槛变化':''].filter(Boolean);
    if(p?.inPool&&!selected.has(row.code)) removed.push({code:row.code,at:asOf,reasons:row.risk.hardVeto.length?row.risk.hardVeto:['排名保留门槛未通过或趋势加速/过热']});
    nextEntries[row.code]={state:row.state,score:row.score,rank:row.rank,inPool:selected.has(row.code),breakoutLevel:row.breakoutLevel,
      firstSeenAt:row.firstSeenAt,firstTriggeredAt:row.firstTriggeredAt,firstConfirmedAt:row.firstConfirmedAt,invalidatedAt:row.invalidatedAt,lastSeenAt:asOf};
  }
  for(const [code,p] of Object.entries(entries)) if(p.inPool&&!sorted.some(s=>String(s.code)===code)){
    removed.push({code,at:asOf,reasons:['本次证券数据缺失，立即移出']});nextEntries[code]={...p,inPool:false,state:'INVALIDATED',invalidatedAt:asOf};
  }
  const result={metadata:{modelVersion:c.modelVersion,configVersion:c.configVersion,configFingerprint:cfg,snapshotId:snapshot.id,
      universeId:snapshot.universeId,asOf,dataFingerprint:fp,priorPoolFingerprint:compatible?fingerprint({lastAsOf:previous.lastAsOf,entries}):null,mode:'SHADOW',probabilityCalibration:'NOT_CALIBRATED'},
    decision:market.pass&&!stale&&calendarValid&&universeValid&&candidates.length?'OBSERVE':'WAIT',
    universeCoverage:{valid:universeValid,expectedCount:universe?.expectedCount??null,observedCount:universe?.observedCount??null,
      coverage:finite(universe?.coverage)?universe.coverage:null,source:universe?.source??null,availableAt:universe?.availableAt??null},
    market,candidates,top10:candidates.slice(0,10),
    top30:candidates.slice(0,30),top50:candidates.slice(0,50),evaluations:all,removed,
    buyPlanEvaluation:candidates.filter(r=>r.buyPlanEligible).map(r=>r.code),productionOverride:false};
  const poolState={modelVersion:c.modelVersion,configVersion:c.configVersion,configFingerprint:cfg,universeId:snapshot.universeId,
    lastAsOf:asOf,lastFingerprint:fp,entries:nextEntries,lastResult:JSON.parse(JSON.stringify(result))};
  return {...result,poolState};
}
