import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import marketHandler from '../../api/market.js';
import psychologyHandler from '../../api/psychology_universe.js';
import { boardForCode, scoreCandidate, rankCandidates } from './precursor_score.js';
import { computeEarlyOpportunity } from '../../research/v11-short-alpha/early_opportunity.js';

const MODEL_VERSION = 'V13-live-psychology-catalyst-overlay-research-v1';
const n = v => v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
const clamp = (v, lo=0, hi=100) => Math.max(lo, Math.min(hi, v));
const avg = xs => { const a=xs.filter(Number.isFinite); return a.length ? a.reduce((x,y)=>x+y,0)/a.length : null; };

export function parseRows(rows, kind, asOf) {
  const cutoff = String(asOf ?? '').slice(0,10), out = new Map();
  for (const raw of Array.isArray(rows) ? rows : []) {
    const a = typeof raw === 'string' ? raw.split(',') : raw;
    const get = (i,k) => Array.isArray(a) ? a[i] : a?.[k];
    const date = String(get(0,'date') ?? '').slice(0,10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || (cutoff && date > cutoff)) continue;
    if (kind === 'bar') {
      const open=n(get(1,'open')), close=n(get(2,'close')), high=n(get(3,'high')), low=n(get(4,'low'));
      if (!(close>0) || !(high>0) || !(low>0) || high<low) continue;
      out.set(date,{date,open:open>0?open:close,close,high,low,volume:n(get(5,'volume'))??0,
        amount:n(get(6,'amount'))??0,...(n(get(10,'turnoverRate'))!==null?{turnoverRate:n(get(10,'turnoverRate'))}:{})});
    } else {
      const mainNet=n(get(1,'mainNet')), mainPct=n(get(6,'mainPct'));
      if (mainNet===null && mainPct===null) continue;
      out.set(date,{date,mainNet:mainNet??0,mainPct:mainPct??0,amount:n(get(11,'amount'))??0});
    }
  }
  return [...out.values()].sort((a,b)=>a.date.localeCompare(b.date));
}
export function selectCandidateFunnel(rows, limit=120) {
  const valid=(Array.isArray(rows)?rows:[]).filter(r=>/^(00|30|60|68)\d{4}$/.test(String(r?.f12??''))&&!/(^|\*)ST(?=[\u4e00-\u9fff\d\s]|$)|^退/i.test(String(r?.f14??'')));
  const chosen=new Map();
  const add=(arr,count,lane)=>{let added=0;for(const r of arr){const code=String(r.f12);if(chosen.has(code)){chosen.get(code).funnelLanes.push(lane);continue;}chosen.set(code,{...r,funnelLanes:[lane]});if(++added>=count)break;}};
  const val=(r,k)=>n(r?.[k])??-Infinity;
  add([...valid].sort((a,b)=>val(b,'rankScore')-val(a,'rankScore')),Math.ceil(limit*.42),'consensus-rank');
  add([...valid].sort((a,b)=>val(b,'f3')-val(a,'f3')),Math.ceil(limit*.20),'price-momentum');
  add([...valid].sort((a,b)=>val(b,'f62')-val(a,'f62')),Math.ceil(limit*.18),'capital-inflow');
  add([...valid].sort((a,b)=>val(b,'rankHits')-val(a,'rankHits')),Math.ceil(limit*.10),'cross-rank-consensus');
  add(valid,limit,'ranked-funnel-fill');
  return [...chosen.values()].slice(0,limit).map(r=>({...r,funnelLanes:[...new Set(r.funnelLanes)],board:boardForCode(r.f12)}));
}
function breadth(t){const m=n(t?.memberCount),u=n(t?.upCount);return m>0&&u!==null?clamp(u/m*100):null;}
function leader(t){const s={leader:100,core:82,front:68,follower:42}[String(t?.leaderStatus??'')];const r=n(t?.candidateRank);return avg([s??NaN,r!==null?clamp(100-(r-1)*12):NaN]);}
function heat(t){const f=n(t?.mainNetPct),c=n(t?.changePct),b=breadth(t);return avg([f!==null?clamp(50+f*8):NaN,c!==null?clamp(50+c*5):NaN,b??NaN]);}
function newsTime(item){
  const v=item?.publishedAt??item?.publishTime??item?.date??item?.time??item?.datetime??item?.pubDate;
  if(typeof v==='number'){const ms=v<1e12?v*1000:v;return Number.isFinite(ms)?new Date(ms).toISOString():null;}
  const ms=Date.parse(String(v??''));return Number.isFinite(ms)?new Date(ms).toISOString():null;
}
export function normalizeDatedNews(themes,capturedAt){
  const cutoff=Date.parse(capturedAt),out=[];
  for(const t of Array.isArray(themes)?themes:[])for(const x of Array.isArray(t?.news)?t.news:[]){
    const publishedAt=newsTime(x),verified=publishedAt!==null&&Number.isFinite(cutoff)&&Date.parse(publishedAt)<=cutoff;
    out.push({themeCode:t.code??null,themeName:t.name??null,title:String(x?.title??x?.name??x?.headline??'').slice(0,300),
      source:x?.source??x?.media??null,url:x?.url??x?.link??null,publishedAt,timestampVerified:verified,usableAsPointInTimeCatalyst:verified});
  }
  return out.filter(x=>x.title||x.url);
}
export function flattenNewsPayload(payload){
  const found=[],seen=new Set();
  function walk(node,depth=0){
    if(depth>8||node==null)return;
    if(Array.isArray(node)){for(const item of node)walk(item,depth+1);return;}
    if(typeof node!=='object')return;
    const title=node.title??node.name??node.headline??node.artTitle;
    if(title){
      const item={title:String(title),publishedAt:node.publishedAt??node.publishTime??node.date??node.time??node.datetime??node.pubDate??node.showTime??node.artDate,
        source:node.source??node.media??node.mediaName??node.sourceName??null,url:node.url??node.link??node.articleUrl??node.artUrl??null};
      const key=[item.title,item.publishedAt,item.url].join('|');
      if(!seen.has(key)){seen.add(key);found.push(item);}
    }
    for(const [key,value] of Object.entries(node))if(!['title','name','headline','artTitle'].includes(key))walk(value,depth+1);
  }
  walk(payload);
  return found.slice(0,20);
}
export function buildStockNewsFallback(code,name,items,capturedAt){
  const datedNews=normalizeDatedNews([{code,name,news:Array.isArray(items)?items:[]}],capturedAt);
  const usable=datedNews.filter(item=>item.usableAsPointInTimeCatalyst);
  const days=usable.map(item=>(Date.parse(capturedAt)-Date.parse(item.publishedAt))/86400000).filter(x=>x>=0);
  const recency=avg(days.map(d=>d<=1?85:d<=3?72:d<=7?58:42));
  const countBoost=Math.min(12,Math.max(0,usable.length-1)*3);
  const newsCatalystProxy=recency===null?null:clamp(recency+countBoost);
  return {sector:newsCatalystProxy===null?{}:{catalystScore:newsCatalystProxy},
    overlay:{available:usable.length>0,source:'timestamped-stock-news-fallback',primaryTheme:null,
      catalystScore:newsCatalystProxy,datedNewsCount:usable.length,datedNews:usable,
      warnings:usable.length?['news recency/count proxy only; no validated sentiment or theme-imagination score']:['no-time-verified-stock-news']}};
}
export function buildPsychologySector(themes,capturedAt){
  const usable=(Array.isArray(themes)?themes:[]).filter(t=>!t?.asOf||!Number.isFinite(Date.parse(t.asOf))||Date.parse(t.asOf)<=Date.parse(capturedAt));
  if(!usable.length)return {sector:{},overlay:{available:false,reason:'psychology-theme-missing',datedNewsCount:0}};
  const ordered=[...usable].sort((a,b)=>(avg([n(b.narrativeScore),n(b.imaginationScore),heat(b)])??-Infinity)-(avg([n(a.narrativeScore),n(a.imaginationScore),heat(a)])??-Infinity));
  const t=ordered[0], datedNews=normalizeDatedNews([t],capturedAt).filter(x=>x.usableAsPointInTimeCatalyst);
  const narrative=n(t.narrativeScore), imagination=n(t.imaginationScore);
  const catalystScore=datedNews.length?avg([narrative??NaN,imagination??NaN]):null;
  const b=breadth(t),l=leader(t),h=heat(t),r3=n(t.changePct),r5=n(t.change5dPct),lu=n(t.limitUpCount);
  const sector={...(n(t.change3dPct)!==null?{return3Pct:n(t.change3dPct)}:{}),...(r5!==null?{return5Pct:r5}:{}),...(b!==null?{upRatio:b/100}:{}),
    ...(lu!==null?{limitUpCount:lu}:{}),...(l!==null?{leaderScore:l}:{}),...(catalystScore!==null?{catalystScore}:{}),...(h!==null?{themeHeat:h}:{})};
  return {sector,overlay:{available:true,primaryTheme:t.name??null,themeCode:t.code??null,leaderStatus:t.leaderStatus??null,
    candidateRank:n(t.candidateRank),emotionHeat:h,narrativeScore:narrative,imaginationScore:imagination,catalystScore,
    datedNewsCount:datedNews.length,datedNews,narrativeEvidence:(t.narrativeEvidence??[]).slice(0,8),
    imaginationEvidence:(t.imaginationEvidence??[]).slice(0,8),warnings:datedNews.length?[]:['no-time-verified-news-catalyst; catalyst score not applied']}};
}
function invoke(handler,url){return new Promise((resolvePromise,reject)=>{let body='';const req={method:'GET',url};const res={statusCode:200,setHeader(){},status(c){this.statusCode=c;return this;},json(v){body=JSON.stringify(v);resolvePromise({statusCode:this.statusCode,body});},send(v){body=typeof v==='string'?v:JSON.stringify(v);resolvePromise({statusCode:this.statusCode,body});},end(v=''){body=typeof v==='string'?v:JSON.stringify(v);resolvePromise({statusCode:this.statusCode,body});}};Promise.resolve(handler(req,res)).catch(reject);});}
function parseResult(name,r){if(r.statusCode<200||r.statusCode>=300)throw Error(name+' HTTP '+r.statusCode+': '+r.body.slice(0,250));const x=JSON.parse(r.body);if(x?.error)throw Error(name+': '+x.error);return x;}
function chunks(rows,size=30){const out=[];for(let i=0;i<rows.length;i+=size)out.push(rows.slice(i,i+size));return out;}
async function mapLimit(items,limit,fn){const out=new Array(items.length);let next=0;async function worker(){while(true){const i=next++;if(i>=items.length)return;try{out[i]=await fn(items[i],i);}catch(e){out[i]={error:String(e?.message??e)};}}}await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));return out;}
export function interleaveCodes(primary,secondary,limit){
  const out=[],seen=new Set();let p=0,s=0,takePrimary=true;
  while(out.length<limit&&(p<primary.length||s<secondary.length)){
    const list=takePrimary?primary:secondary;
    if(takePrimary){
      while(p<primary.length&&seen.has(String(primary[p])))p++;
      if(p>=primary.length){takePrimary=false;continue;}
      const code=String(primary[p++]);seen.add(code);out.push(code);takePrimary=false;
    }else{
      while(s<secondary.length&&seen.has(String(secondary[s])))s++;
      if(s>=secondary.length){takePrimary=true;continue;}
      const code=String(secondary[s++]);seen.add(code);out.push(code);takePrimary=true;
    }
  }
  return out;
}
export function validateLiveSnapshot(s={}){
  const reasons=[];if(s.schema!=='v13-live-psychology-catalyst-snapshot-v1')reasons.push('schema-invalid');
  if(!s.snapshotId)reasons.push('snapshot-id-missing');if(!s.capturedAt||!Number.isFinite(Date.parse(s.capturedAt)))reasons.push('captured-at-invalid');
  if(!s.asOf||!Number.isFinite(Date.parse(s.asOf)))reasons.push('asof-invalid');if(!Array.isArray(s.candidates)||s.candidates.length<50)reasons.push('candidate-count-insufficient');
  const q=s.quality??{};if(q.deepSuccessPct<90)reasons.push('deep-source-coverage-below-90-percent');
  if(q.barHistoryCoveragePct<90)reasons.push('bar-history-coverage-below-90-percent');
  if((Number(q.psychologyCoveragePct)||0)<70&&(Number(q.datedNewsCoveragePct)||0)<70)reasons.push('theme-psychology-and-dated-news-coverage-below-70-percent');
  if(q.rankedSourceDegraded||q.rankedSourceStale)reasons.push('ranked-source-degraded-or-stale');
  const valid=!reasons.length;
  const status=!valid?'SOURCE_UNAVAILABLE':q.psychologyCoveragePct>=70?'CAPTURED':'CAPTURED_WITH_NEWS_FALLBACK';
  return {valid,status,reasons, ...(status==='CAPTURED_WITH_NEWS_FALLBACK'?{warnings:['theme psychology unavailable; only timestamp-verified stock-news recency proxy was available']}:{})};
}
export function isPreLimitUpCandidate(row={},early=null){
  const code=String(row.code??'');
  const board=boardForCode(code);
  const dailyPct=Number(row.quote?.pct??row.currentPct);
  const r5=Number(row.features?.r5Pct);
  const distHigh20=Number(row.features?.distHigh20Pct);
  const limitPct=board==='CHINEXT'||board==='STAR'?20:board==='BSE'?30:10;
  if(Number.isFinite(dailyPct)&&dailyPct>=limitPct*0.75)return false;
  if(early?.stage==='extended')return false;
  if(Number.isFinite(r5)&&r5>25)return false;
  if(Number.isFinite(distHigh20)&&distHigh20>18)return false;
  return true;
}
export function applySnapshotQualityGate(snapshot={}){
  const validation=validateLiveSnapshot(snapshot);
  const rankings=snapshot.rankings&&typeof snapshot.rankings==='object'?snapshot.rankings:{};
  const output={...snapshot,quality:{...(snapshot.quality??{}),...validation}};
  if(!validation.valid){
    output.diagnosticRankings=output.diagnosticRankings??rankings;
    output.rankings=Object.fromEntries(Object.keys(rankings).map(key=>[key,[]]));
    output.recommendationsAvailable=false;
    output.recommendationStatus='SOURCE_UNAVAILABLE';
  }else{
    output.recommendationsAvailable=true;
    output.recommendationStatus=validation.status;
  }
  return output;
}

export async function captureV13LiveSnapshot({out=null,candidateLimit=120,asOf=null}={}){
  const capturedAt=new Date().toISOString(),requestedAsOf=asOf||capturedAt;
  const ranked=parseResult('ranked_candidates',await invoke(marketHandler,'/api/market?action=ranked_candidates'));
  const raw=ranked?.data?.candidates??[],funnel=selectCandidateFunnel(raw,candidateLimit);
  if(funnel.length<50)throw Error('ranked candidate funnel returned fewer than 50 symbols');
  const batches=await mapLimit(chunks(funnel,30),1,async group=>{
    const codes=group.map(r=>String(r.f12)),query=encodeURIComponent(codes.join(','));
    const [deepR,psychR]=await Promise.allSettled([
      invoke(marketHandler,'/api/market?action=deep_batch&codes='+query),
      invoke(psychologyHandler,'/api/psychology_universe?codes='+query+'&asOf='+encodeURIComponent(requestedAsOf))
    ]);
    let deep=null,psych=null,deepError=null,psychError=null;
    try { if(deepR.status==='fulfilled') deep=parseResult('deep_batch',deepR.value); else deepError=String(deepR.reason?.message??deepR.reason); }
    catch(e) { deepError=String(e?.message??e); }
    try { if(psychR.status==='fulfilled') psych=parseResult('psychology_universe',psychR.value); else psychError=String(psychR.reason?.message??psychR.reason); }
    catch(e) { psychError=String(e?.message??e); }
    return {codes,deep,psych,deepError,psychError};
  });
  const deepByCode=new Map(),psychByCode=new Map(),psychSuccessCodes=new Set(),sourceErrors=[];
  for(const batch of batches){
    if(batch.deep) for(const item of batch.deep.items??[]) deepByCode.set(String(item.code??''),item);
    else sourceErrors.push('deep_batch: '+batch.deepError);
    if(batch.psych){
      for(const code of batch.codes) psychSuccessCodes.add(code);
      for(const [code,themes] of Object.entries(batch.psych.data?.themeBySymbol??{})) psychByCode.set(code,Array.isArray(themes)?themes:[]);
    } else sourceErrors.push('psychology_universe: '+batch.psychError);
  }
  const newsByCode=new Map(),newsSuccessCodes=new Set();
  const newsBatches=await mapLimit(chunks(funnel,8),2,async group=>{
    const codes=group.map(r=>String(r.f12)),query=encodeURIComponent(codes.join(','));
    try{
      const payload=parseResult('news_batch',await invoke(marketHandler,'/api/market?action=news_batch&codes='+query));
      return {codes,payload};
    }catch(error){return {codes,error:String(error?.message??error)};}
  });
  for(const batch of newsBatches){
    if(batch.error){sourceErrors.push('news_batch: '+batch.error);continue;}
    for(const item of batch.payload?.items??[]){
      const code=String(item?.code??'');
      if(!code)continue;
      newsSuccessCodes.add(code);
      newsByCode.set(code,flattenNewsPayload(item.news));
    }
  }
  const records=[],modelInputsByCode=new Map();
  for(const row of funnel){
    const code=String(row.f12),deep=deepByCode.get(code),bars=parseRows(deep?.kline?.data?.klines??[],'bar',requestedAsOf);
    const flowUsable=deep?.dataQuality?.flowSource==='eastmoney';
    const flows=flowUsable?parseRows(deep?.flow?.data?.klines??[],'flow',requestedAsOf).map(f=>({...f,amount:bars.find(b=>b.date===f.date)?.amount??0})):[];
    const themePsychology=buildPsychologySector(psychByCode.get(code)??[],capturedAt);
    const newsFallback=buildStockNewsFallback(code,String(row.f14??code),newsByCode.get(code)??[],capturedAt);
    const psychology={sector:{...themePsychology.sector,...(themePsychology.sector.catalystScore==null&&newsFallback.sector.catalystScore!=null?{catalystScore:newsFallback.sector.catalystScore}:{})},
      overlay:themePsychology.overlay.available?{...themePsychology.overlay,stockNewsFallback:newsFallback.overlay}:newsFallback.overlay};
    const candidate={code,name:String(row.f14??code),asOf:requestedAsOf,isST:/(^|\*)ST(?=[\u4e00-\u9fff\d\s]|$)|^退/i.test(String(row.f14??'')),bars,flows,sector:psychology.sector,
      amount:bars.at(-1)?.amount??n(row.f6),turnoverRate:bars.at(-1)?.turnoverRate??n(row.f8)};
    modelInputsByCode.set(code,candidate);
    const score=scoreCandidate(candidate,{asOf:requestedAsOf}),dq=deep?.dataQuality??{};
    records.push({code,name:candidate.name,board:boardForCode(code),funnelLanes:row.funnelLanes??[],
      quote:{price:n(row.f2),pct:n(row.f3),mainNetCny:n(row.f62),mainNetPct:n(row.f184),turnoverRate:n(row.f8),amount:n(row.f6),volumeRatio:n(row.f10),rankScore:n(row.rankScore),rankHits:n(row.rankHits),ranks:row.ranks??{}},
      score,psychology:psychology.overlay,source:{quoteTimestamp:n(row.f124),rankedGeneratedAt:ranked?.data?.generatedAt??null,
      klineSource:dq.klineSource??null,flowSource:dq.flowSource??null,deepError:deep?.error??null,barCount:bars.length,flowCount:flows.length}});
  }
  const validRecords=records.filter(r=>r.score),recordByCode=new Map(validRecords.map(r=>[r.code,r]));
  const modelInputs=validRecords.map(r=>modelInputsByCode.get(r.code)).filter(Boolean);
  const rankedScores=rankCandidates(modelInputs,{asOf:requestedAsOf,modelVariant:'v13-core-only'})
    .map((s,i)=>{const record=recordByCode.get(s.code);return {...s,rank:i+1,quote:record?.quote??{},psychology:record?.psychology??{},source:record?.source??{}};});
  const scoreByCode=new Map(rankedScores.map(r=>[r.code,r]));
  const earlyRows=modelInputs.map(candidate=>{
    const base=scoreByCode.get(candidate.code);
    const opportunity=computeEarlyOpportunity({bars:candidate.bars,asOf:requestedAsOf,barComplete:true,features:{sector:{score:base?.components?.sector},capital:{score:base?.components?.flow}}});
    if(!Number.isFinite(Number(opportunity.score)))return null;
    return {code:candidate.code,score:Number(opportunity.score),confidence:Number((opportunity.confidence*100).toFixed(1)),stage:opportunity.stage,
      components:opportunity.components,metrics:opportunity.metrics,reasons:opportunity.reasons};
  }).filter(Boolean).sort((a,b)=>b.score-a.score||b.confidence-a.confidence);
  const earlyByCode=new Map(earlyRows.map(r=>[r.code,r]));
  const preLimitUpScores=rankedScores.filter(row=>isPreLimitUpCandidate(row,earlyByCode.get(row.code)));
  const eligibleCodes=new Set(preLimitUpScores.map(row=>row.code));
  const momentumCodes=[...preLimitUpScores].sort((a,b)=>(Number.isFinite(b.features?.r5Pct)?b.features.r5Pct:-Infinity)-(Number.isFinite(a.features?.r5Pct)?a.features.r5Pct:-Infinity)||b.score-a.score).map(r=>r.code);
  const earlyCodes=earlyRows.filter(row=>eligibleCodes.has(row.code)).map(r=>r.code);
  const balancedCodes=interleaveCodes(momentumCodes,earlyCodes,Math.min(30,new Set([...momentumCodes,...earlyCodes]).size));
  const balancedBlend=balancedCodes.map((code,i)=>{
    const base=scoreByCode.get(code),early=earlyByCode.get(code);if(!base)return null;
    const sourceLane=momentumCodes.includes(code)&&earlyCodes.includes(code)?'both':momentumCodes.includes(code)?'momentum':'early-opportunity';
    return {...base,rank:i+1,modelVariant:'v13-live-balanced-blend',scorePath:'balanced-blend',setup:early?.stage??base.setup,
      balancedSource:sourceLane,components:{...base.components,earlyOpportunity:early?.score??null},earlyOpportunity:early??null};
  }).filter(Boolean);
  const auditRecords=records.map(r=>({...r,score:scoreByCode.get(r.code)??r.score,
    observationScores:{emotionRepair:r.score?.components?.emotionRepair??null,oversoldReversal:r.score?.components?.oversoldReversal??null}}));
  const deepGood=records.filter(r=>r.source.klineSource==='eastmoney'&&r.source.flowSource==='eastmoney').length;
  const barsGood=records.filter(r=>r.source.barCount>=25).length,psychGood=records.filter(r=>r.psychology.available&&r.psychology.source!=='timestamped-stock-news-fallback').length;
  const quality={rankedSourceDegraded:ranked?.data?.degraded===true,rankedSourceStale:ranked?.data?.serverStale===true,rankedSourceMethod:ranked?.data?.method??null,
    rankedCandidateCount:raw.length,funnelCandidateCount:funnel.length,deepSuccessCount:deepGood,deepSuccessPct:+(deepGood/Math.max(1,funnel.length)*100).toFixed(2),
    barHistoryCount:barsGood,barHistoryCoveragePct:+(barsGood/Math.max(1,funnel.length)*100).toFixed(2),
    psychologyResponseCount:psychSuccessCodes.size,psychologyCoveragePct:+(psychSuccessCodes.size/Math.max(1,funnel.length)*100).toFixed(2),
    psychologyThemeCount:psychGood,psychologyThemeCoveragePct:+(psychGood/Math.max(1,funnel.length)*100).toFixed(2),
    newsResponseCount:newsSuccessCodes.size,newsResponseCoveragePct:+(newsSuccessCodes.size/Math.max(1,funnel.length)*100).toFixed(2),
    datedNewsCandidateCount:records.filter(r=>Math.max(r.psychology.datedNewsCount??0,r.psychology.stockNewsFallback?.datedNewsCount??0)>0).length,
    datedNewsCoveragePct:+(records.filter(r=>Math.max(r.psychology.datedNewsCount??0,r.psychology.stockNewsFallback?.datedNewsCount??0)>0).length/Math.max(1,funnel.length)*100).toFixed(2),sourceErrors};
  const diagnosticRankings={overall:balancedBlend,trendTransition:rankedScores.slice(0,20),
    emotionRepair:rankedScores.filter(r=>Number(r.components?.emotionRepair)>=65).sort((a,b)=>Number(b.components.emotionRepair)-Number(a.components.emotionRepair)).slice(0,20),
    oversold:rankedScores.filter(r=>Number(r.components?.oversoldReversal)>=65).sort((a,b)=>Number(b.components.oversoldReversal)-Number(a.components.oversoldReversal)).slice(0,20),
    coreRanking:rankedScores.slice(0,30),earlyOpportunity:earlyRows.slice(0,30)};
  const snapshot={schema:'v13-live-psychology-catalyst-snapshot-v1',modelVersion:MODEL_VERSION,
    snapshotId:'v13-'+capturedAt.replace(/[-:.TZ]/g,''),capturedAt,asOf:requestedAsOf,
    sourcePolicy:{provider:'Eastmoney public quote/history and psychology/theme/news endpoint',pointInTime:'captured-at-source',
      futureDatedBarsExcluded:true,catalystOnlyUsedWhenNewsTimestampVerified:true,brokerConnected:false,automaticOrderPlacement:false},
    quality:{},coverage:{rawRankedCandidates:raw.length,funnelCandidates:funnel.length,scoredCandidates:rankedScores.length,
      preLimitUpEligibleCount:preLimitUpScores.length,earlyOpportunityCandidates:earlyRows.length,balancedBlendCount:balancedBlend.length},
    candidates:auditRecords,rankings:{
      overall:balancedBlend,
      trendTransition:preLimitUpScores.slice(0,20),
      emotionRepair:diagnosticRankings.emotionRepair,
      oversold:diagnosticRankings.oversold,
      coreRanking:preLimitUpScores.slice(0,30),
      earlyOpportunity:earlyRows.filter(row=>eligibleCodes.has(row.code)).slice(0,30)
    },diagnosticRankings};
  snapshot.quality=quality;
  const finalSnapshot=applySnapshotQualityGate(snapshot);
  const output=resolve(out||'output/v13-live-snapshots/'+snapshot.snapshotId+'.json');await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(finalSnapshot,null,2));
  console.log(JSON.stringify({snapshotId:finalSnapshot.snapshotId,capturedAt,asOf:requestedAsOf,
    recommendationStatus:finalSnapshot.recommendationStatus,recommendationsAvailable:finalSnapshot.recommendationsAvailable,
    quality:finalSnapshot.quality,
    top10:finalSnapshot.rankings.overall.slice(0,10).map(r=>({rank:r.rank,code:r.code,name:r.name,score:r.score,setup:r.setup,primaryTheme:r.psychology?.primaryTheme??null}))},null,2));
  return finalSnapshot;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const a=process.argv.slice(2);let out=null,candidateLimit=120,asOf=null;
  for(let i=0;i<a.length;i++){if(a[i]==='--out'&&a[i+1])out=a[++i];else if(a[i]==='--limit'&&a[i+1])candidateLimit=Math.max(50,Math.min(180,Number(a[++i])||120));else if(a[i]==='--as-of'&&a[i+1])asOf=a[++i];}
  await captureV13LiveSnapshot({out,candidateLimit,asOf});
}
