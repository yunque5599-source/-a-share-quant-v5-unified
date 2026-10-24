import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import marketHandler from '../../api/market.js';
import psychologyHandler from '../../api/psychology_universe.js';
import { boardForCode, isRestrictedListingName, scoreCandidate, rankCandidates } from './precursor_score.js';
import { computeEarlyOpportunity } from '../../research/v11-short-alpha/early_opportunity.js';
import { fetchUniverse } from './historical_replay.js';

const MODEL_VERSION = 'V13-live-psychology-catalyst-overlay-research-v2-wide-news';
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
export function isDailyBarCompleteAt(timestamp){
  const value=Date.parse(String(timestamp??''));
  if(!Number.isFinite(value))return false;
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value));
  const get=type=>Number(parts.find(part=>part.type===type)?.value);
  const minuteOfDay=get('hour')*60+get('minute');
  return minuteOfDay<570||minuteOfDay>=900;
}
export function mapUniverseRowsToRankCandidates(rows){
  const output=[];
  for(const stock of Array.isArray(rows)?rows:[]){
    const code=String(stock?.code??''),name=String(stock?.name??code);
    if(!/^(00|30|60|68|43|83|87|92)\d{4}$/.test(code)||isRestrictedListingName(name))continue;
    const price=n(stock.price),pct=n(stock.pct),amount=n(stock.amount),turnoverRate=n(stock.turnoverRate);
    const mainNet=n(stock.mainNet);
    const mainPct=n(stock.mainPct)??(amount>0&&mainNet!==null?mainNet/amount*100:null);
    if(price===null||price<=0||pct===null)continue;
    const momentumScore=clamp(50+pct*3);
    const capitalScore=mainPct===null?45:clamp(50+mainPct*5);
    output.push({f12:code,f14:name,f2:price,f3:pct,f6:amount,f8:turnoverRate,
      f62:mainNet,f184:mainPct,f100:String(stock.industry??''),
      rankScore:Number((0.60*momentumScore+0.40*capitalScore).toFixed(2)),
      rankHits:0,ranks:{fullUniverseSnapshot:0},board:stock.board??boardForCode(code),
      _source:'eastmoney-full-universe-live-quote-fallback'});
  }
  return output.sort((a,b)=>b.rankScore-a.rankScore||String(a.f12).localeCompare(String(b.f12)));
}
export function selectCandidateFunnel(rows, limit=120) {
  const valid=(Array.isArray(rows)?rows:[]).filter(r=>/^(00|30|60|68)\d{4}$/.test(String(r?.f12??''))&&!isRestrictedListingName(r?.f14));
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
export function deriveLiveIndustryContext(rows){
  const groups=new Map();
  for(const row of Array.isArray(rows)?rows:[]){
    const code=String(row?.f12??row?.code??'');
    const name=String(row?.f14??row?.name??'');
    const industry=String(row?.f100??row?.industry??row?.industryName??row?.sectorName??'').trim();
    const pct=n(row?.f3??row?.changePct);
    if(!code||!industry||pct===null||isRestrictedListingName(name))continue;
    const group=groups.get(industry)??[];
    group.push({code,name,pct,board:boardForCode(code)});
    groups.set(industry,group);
  }
  const context=new Map();
  for(const group of groups.values()){
    if(group.length<3)continue;
    const ordered=[...group].sort((a,b)=>a.pct-b.pct);
    const mid=Math.floor(ordered.length/2);
    const medianPct=ordered.length%2?ordered[mid].pct:(ordered[mid-1].pct+ordered[mid].pct)/2;
    const upRatio=group.filter(row=>row.pct>0).length/group.length;
    const limitUpCount=group.filter(row=>{
      const limit=row.board==='CHINEXT'||row.board==='STAR'?20:row.board==='BSE'?30:10;
      return row.pct>=limit*0.92;
    }).length;
    const themeHeat=clamp(0.45*upRatio*100+0.35*clamp(50+medianPct*5)+0.20*clamp(35+limitUpCount*12));
    for(const row of group){
      const below=ordered.filter(peer=>peer.pct<row.pct).length;
      const equal=ordered.filter(peer=>peer.pct===row.pct).length;
      context.set(row.code,{
        upRatio:Number(upRatio.toFixed(4)),limitUpCount,
        leaderScore:Number((100*(below+equal/2)/group.length).toFixed(1)),
        themeHeat:Number(themeHeat.toFixed(1)),
        contextSource:'ranked-universe-cross-sectional-proxy',
        industryMemberCount:group.length,
        industryMedianDailyPct:Number(medianPct.toFixed(2))
      });
    }
  }
  return context;
}

function breadth(t){const m=n(t?.memberCount),u=n(t?.upCount);return m>0&&u!==null?clamp(u/m*100):null;}
function leader(t){const s={leader:100,core:82,front:68,follower:42}[String(t?.leaderStatus??'')];const r=n(t?.candidateRank);return avg([s??NaN,r!==null?clamp(100-(r-1)*12):NaN]);}
function heat(t){const f=n(t?.mainNetPct),c=n(t?.changePct),b=breadth(t);return avg([f!==null?clamp(50+f*8):NaN,c!==null?clamp(50+c*5):NaN,b??NaN]);}
function newsTime(item){
  const v=item?.publishedAt??item?.publishTime??item?.date??item?.time??item?.datetime??item?.pubDate;
  if(typeof v==='number'){const ms=v<1e12?v*1000:v;return Number.isFinite(ms)?new Date(ms).toISOString():null;}
  const raw=String(v??'').trim();
  // Public A-share news feeds often omit a timezone; interpret these as China Standard Time,
  // not the GitHub runner's local timezone (usually UTC).
  const dateOnly=raw.match(/^(\d{4}-\d{2}-\d{2})$/);
  const naive=raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)$/);
  const normalized=dateOnly?dateOnly[1]+'T00:00:00+08:00':naive?naive[1]+'T'+naive[2]+'+08:00':raw;
  const ms=Date.parse(normalized);return Number.isFinite(ms)?new Date(ms).toISOString():null;
}

const POSITIVE_HEADLINE_RULES=[
  {category:'contract_or_order',weight:28,pattern:/中标|中选|重大合同|新签合同|订单(?:金额|增长|落地|交付)?|供货协议|客户定点|进入供应链/},
  {category:'earnings_improvement',weight:28,pattern:/业绩预增|净利润预增|扭亏为盈|业绩大增|利润(?:同比)?增长|营收(?:同比)?增长|亏损(?:幅度)?收窄/},
  {category:'approval_or_registration',weight:26,pattern:/获批|批准上市|注册获批|取得.*批件|临床试验获批|纳入.*医保目录|通过.*认证/},
  {category:'capital_return',weight:20,pattern:/股份回购|股票回购|股东增持|高管增持|股权激励/},
  {category:'strategic_deal',weight:22,pattern:/战略合作|签署.*协议|合作协议|并购|收购.*股权|资产重组|控制权变更/},
  {category:'product_or_capacity',weight:18,pattern:/新品发布|新产品发布|产品上线|正式上线|推出|实现量产|投产|产能释放|技术突破|产品落地|AI赋能|业务落地|(?:AI|人工智能|智能化|数字化).{0,8}(?:发布|上线|落地|转型|升级)|发布.{0,8}(?:平台|产品|系统|服务)|新业务.{0,8}(?:落地|增长|上线)/},
  {category:'policy_or_industry',weight:17,pattern:/政策支持|专项资金|政府补贴|纳入试点|入选试点|行业标准|产业扶持|重大项目获批/}
];
const NEGATIVE_HEADLINE_RULES=[
  {category:'regulatory_or_integrity_risk',weight:32,pattern:/立案调查|被立案|行政处罚|监管警示|财务造假|审计.*非标|退市风险|终止上市/},
  {category:'earnings_deterioration',weight:28,pattern:/业绩预亏|净利润下滑|净利润下降|亏损扩大|大幅亏损|商誉减值|业绩下修/},
  {category:'shareholder_or_debt_risk',weight:23,pattern:/股东减持|减持计划|债务逾期|债务违约|高比例质押|被执行人|重大诉讼|重大仲裁/},
  {category:'operation_or_contract_risk',weight:24,pattern:/停产|重大事故|产品召回|项目终止|取消订单|终止合作|生产经营中断/}
];
export function classifyHeadlineCatalyst(title){
  const text=String(title??'').slice(0,500);
  const positive=POSITIVE_HEADLINE_RULES.filter(rule=>rule.pattern.test(text));
  const negative=NEGATIVE_HEADLINE_RULES.filter(rule=>rule.pattern.test(text));
  if(!positive.length&&!negative.length)return {direction:'unclassified',score:null,positiveCategories:[],negativeCategories:[],matchedTerms:[]};
  const pos=positive.reduce((best,rule)=>Math.max(best,rule.weight),0);
  const neg=negative.reduce((best,rule)=>Math.max(best,rule.weight),0);
  const score=clamp(50+pos-neg,0,100);
  const direction=score>=60?'positive':score<=40?'negative':'mixed';
  return {direction,score,positiveCategories:positive.map(x=>x.category),negativeCategories:negative.map(x=>x.category),
    matchedTerms:[...positive.map(x=>x.category),...negative.map(x=>x.category)]};
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
  const classified=usable.map(item=>({...item,catalyst:classifyHeadlineCatalyst(item.title)}));
  const positive=classified.filter(item=>item.catalyst.direction==='positive');
  const negative=classified.filter(item=>item.catalyst.direction==='negative');
  const mixed=classified.filter(item=>item.catalyst.direction==='mixed');
  const scores=classified.map(item=>item.catalyst.score).filter(Number.isFinite);
  const headlineCatalystScore=scores.length?Number(avg(scores).toFixed(1)):null;
  const days=usable.map(item=>(Date.parse(capturedAt)-Date.parse(item.publishedAt))/86400000).filter(x=>x>=0);
  const recencyScore=avg(days.map(d=>d<=1?85:d<=3?72:d<=7?58:42));
  const catalystEvidence=classified.filter(item=>item.catalyst.score!==null).slice(0,8).map(item=>({
    title:item.title,publishedAt:item.publishedAt,direction:item.catalyst.direction,
    score:item.catalyst.score,matchedTerms:item.catalyst.matchedTerms,url:item.url,source:item.source
  }));
  return {sector:{},
    overlay:{available:usable.length>0,source:'timestamped-stock-news-fallback',primaryTheme:null,
      catalystScore:null,headlineCatalystScore,headlineCatalystDirection:headlineCatalystScore===null?'unclassified':headlineCatalystScore>=60?'positive':headlineCatalystScore<=40?'negative':'mixed',
      classifiedHeadlineCount:scores.length,positiveHeadlineCount:positive.length,negativeHeadlineCount:negative.length,mixedHeadlineCount:mixed.length,
      newsRecencyScore:recencyScore,datedNewsCount:usable.length,datedNews:classified,catalystEvidence,
      warnings:usable.length?['rule-based headline classification is experimental; it is a separate observation lane and is not proof of sentiment or trade profitability']:['no-time-verified-stock-news']}};
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
export function interleaveCatalystCodes(primary, catalyst, limit, catalystSlots = 6) {
  const main = [...new Set((primary ?? []).map(String))];
  const event = [...new Set((catalyst ?? []).map(String))];
  const maxSlots = Math.max(0, Math.min(Number(catalystSlots) || 0, Number(limit) || 0));
  const eventSet = new Set(event);
  const selected = [];
  const selectedSet = new Set();
  let mainIndex = 0;
  let eventIndex = 0;
  let insertedEventCount = 0;
  const targetLength = Math.min(Math.max(0, Number(limit) || 0), new Set([...main, ...event]).size);
  const eventSpacing = Math.max(2, Math.floor(targetLength / Math.max(1, maxSlots)));
  for (let slot = 0; slot < targetLength; slot++) {
    const shouldUseEvent = maxSlots > 0 && eventIndex < event.length &&
      insertedEventCount < maxSlots && (slot + 1) % eventSpacing === 0;
    let code = null;
    if (shouldUseEvent) {
      while (eventIndex < event.length && selectedSet.has(event[eventIndex])) eventIndex++;
      if (eventIndex < event.length) { code = event[eventIndex++]; insertedEventCount++; }
    }
    if (code === null) {
      while (mainIndex < main.length && selectedSet.has(main[mainIndex])) mainIndex++;
      if (mainIndex < main.length) code = main[mainIndex++];
    }
    if (code === null) {
      while (eventIndex < event.length && selectedSet.has(event[eventIndex])) eventIndex++;
      if (eventIndex < event.length) code = event[eventIndex++];
    }
    if (code !== null && !selectedSet.has(code)) { selectedSet.add(code); selected.push(code); }
  }
  for (const code of [...main, ...event]) {
    if (selected.length >= targetLength) break;
    if (!selectedSet.has(code)) { selectedSet.add(code); selected.push(code); }
  }
  return selected;
}

export function scoreCatalystConfirmed(record = {}) {
  const overlay = record.psychology?.stockNewsFallback ?? record.psychology ?? {};
  const headline = n(record.headlineCatalystScore ?? overlay.headlineCatalystScore);
  const direction = record.headlineCatalystDirection ?? overlay.headlineCatalystDirection;
  const base = record.base ?? record.score ?? null;
  if (record.timestampVerified !== true || direction !== 'positive' || !Number.isFinite(headline) || !base ||
      !Number.isFinite(Number(base.score)) || !record.preLimitUpEligible) return null;
  const components = base.components ?? {};
  const features = base.features ?? {};
  const pct = n(record.quote?.pct ?? base.currentPct);
  const priceReaction = pct === null ? 50 : clamp(45 + pct * 7, 0, 100);
  const shortMomentum = avg([
    n(features.r3Pct) !== null ? clamp(50 + Number(features.r3Pct) * 4, 0, 100) : NaN,
    n(features.r5Pct) !== null ? clamp(50 + Number(features.r5Pct) * 2, 0, 100) : NaN
  ]) ?? 50;
  const headlineScore = clamp(headline);
  const trend = clamp(n(components.trend) ?? 45);
  const volumePrice = clamp(n(components.volumePrice) ?? 45);
  const flow = clamp(n(components.flow) ?? 45);
  const sector = clamp(n(components.sector) ?? 45);
  const score = clamp(
    0.35 * headlineScore + 0.15 * trend + 0.15 * volumePrice +
    0.10 * flow + 0.15 * sector + 0.07 * priceReaction + 0.03 * shortMomentum
  );
  return {
    code: String(record.code ?? base.code ?? ''),
    name: String(record.name ?? base.name ?? record.code ?? ''),
    board: record.board ?? base.board ?? 'UNKNOWN',
    score: Number(score.toFixed(2)),
    headlineCatalystScore: Number(headlineScore.toFixed(1)),
    headlineCatalystDirection: direction,
    components: {
      headline: Number(headlineScore.toFixed(1)), trend: Number(trend.toFixed(1)),
      volumePrice: Number(volumePrice.toFixed(1)), flow: Number(flow.toFixed(1)),
      sector: Number(sector.toFixed(1)), priceReaction: Number(priceReaction.toFixed(1)),
      shortMomentum: Number(shortMomentum.toFixed(1))
    },
    baseScore: Number(Number(base.score).toFixed(1)),
    currentPct: pct,
    evidence: record.catalystEvidence ?? overlay.catalystEvidence ?? [],
    warning: 'Timestamped positive headline plus price/flow confirmation; research observation only, not a calibrated buy probability.'
  };
}

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
  const q=s.quality??{};
  const deepCoverage=Number(q.deepSuccessPct),barCoverage=Number(q.barHistoryCoveragePct);
  const flowSignalCoverage=Number(q.flowSignalCoveragePct);
  const psychologyCoverage=Number(q.psychologyCoveragePct),newsCoverage=Number(q.datedNewsCoveragePct);
  if(!Number.isFinite(deepCoverage))reasons.push('deep-source-coverage-metric-missing');
  if(!Number.isFinite(barCoverage)||barCoverage<90)reasons.push('bar-history-coverage-below-90-percent');
  if(!Number.isFinite(flowSignalCoverage)||flowSignalCoverage<90)reasons.push('flow-signal-coverage-below-90-percent');
  if((!Number.isFinite(psychologyCoverage)||psychologyCoverage<70)&&(!Number.isFinite(newsCoverage)||newsCoverage<70))reasons.push('theme-psychology-and-dated-news-coverage-below-70-percent');
  if(q.rankedSourceDegraded||q.rankedSourceStale)reasons.push('ranked-source-degraded-or-stale');
  const valid=!reasons.length;
  const flowFallback=Number.isFinite(deepCoverage)&&deepCoverage<90;
  const newsFallback=(!Number.isFinite(psychologyCoverage)||psychologyCoverage<70)&&Number.isFinite(newsCoverage)&&newsCoverage>=70;
  const status=!valid?'SOURCE_UNAVAILABLE':flowFallback&&newsFallback?'CAPTURED_WITH_FLOW_AND_NEWS_FALLBACK':flowFallback?'CAPTURED_WITH_FLOW_FALLBACK':newsFallback?'CAPTURED_WITH_NEWS_FALLBACK':'CAPTURED';
  const warnings=[];
  if(flowFallback)warnings.push('historical Eastmoney K-line-plus-flow coverage is below 90%; missing flow history uses a weak quote-time snapshot signal and reduced flow-score reliability');
  if(newsFallback)warnings.push('theme psychology coverage is below 70%; only timestamp-verified headline news is available as fallback');
  return {valid,status,reasons,...(warnings.length?{warnings}:{})};
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

export function buildWideNewsCandidate(stock, rawNews, capturedAt) {
  if(!stock||isRestrictedListingName(stock.name))return null;
  const newsItems=flattenNewsPayload(rawNews);
  const overlay=buildStockNewsFallback(String(stock.code),String(stock.name??stock.code),newsItems,capturedAt).overlay;
  if(overlay.headlineCatalystDirection!=='positive'||
      !Number.isFinite(Number(overlay.headlineCatalystScore))||!overlay.datedNewsCount)return null;
  return {
    code:String(stock.code),name:String(stock.name??stock.code),board:stock.board??boardForCode(stock.code),
    headlineCatalystScore:Number(overlay.headlineCatalystScore),
    positiveHeadlineCount:Number(overlay.positiveHeadlineCount)||0,
    datedNewsCount:Number(overlay.datedNewsCount)||0,
    newsRecencyScore:Number(overlay.newsRecencyScore)||0,
    catalystEvidence:overlay.catalystEvidence??[],newsItems
  };
}

export function selectWideNewsScanUniverse(universeRows, maxSymbols=320) {
  const all=(Array.isArray(universeRows)?universeRows:[]).filter(row=>{
    const code=String(row?.code??'');
    const name=String(row?.name??'');
    return /^\d{6}$/.test(code)&&!/ST|退|PT/i.test(name)&&Number.isFinite(Number(row?.amount))&&Number(row.amount)>0;
  });
  const lanes=[
    ['liquidity', [...all].sort((a,b)=>(Number(b.amount)||0)-(Number(a.amount)||0))],
    ['capital-inflow', all.filter(x=>Number(x.mainNet)>0).sort((a,b)=>(Number(b.mainNet)||0)-(Number(a.mainNet)||0))],
    ['flow-ratio', all.filter(x=>Number(x.mainPct)>0).sort((a,b)=>(Number(b.mainPct)||0)-(Number(a.mainPct)||0))],
    ['swing-momentum', all.filter(x=>x.pct60!==null&&x.pct60!==undefined&&Number.isFinite(Number(x.pct60))).sort((a,b)=>(Number(b.pct60)||0)-(Number(a.pct60)||0))],
    ['early-daily-move', all.filter(x=>x.pct!==null&&x.pct!==undefined&&Number.isFinite(Number(x.pct))&&Number(x.pct)>=0&&Number(x.pct)<=8)
      .sort((a,b)=>(Number(b.amount)||0)-(Number(a.amount)||0))],
    ['active-turnover', all.filter(x=>Number.isFinite(Number(x.turnoverRate))&&Number(x.turnoverRate)>=2&&Number(x.turnoverRate)<=20)
      .sort((a,b)=>(Number(b.amount)||0)-(Number(a.amount)||0))]
  ];
  const cap=Math.max(1,Math.min(800,Number(maxSymbols)||320));
  const chosen=new Map(),counts={};
  while(chosen.size<cap&&lanes.some(([,rows])=>rows.some(row=>!chosen.has(String(row.code))))){
    let progressed=false;
    for(const [lane,rows] of lanes){
      let index=counts[lane+'_cursor']||0;
      while(index<rows.length&&chosen.has(String(rows[index].code)))index++;
      counts[lane+'_cursor']=index;
      if(index>=rows.length)continue;
      const row=rows[index];
      counts[lane+'_cursor']=index+1;
      const code=String(row.code);
      if(!chosen.has(code)){chosen.set(code,{...row,wideNewsPrescreenLanes:[]});progressed=true;}
      const entry=chosen.get(code);
      if(entry&&!entry.wideNewsPrescreenLanes.includes(lane))entry.wideNewsPrescreenLanes.push(lane);
      if(chosen.size>=cap)break;
    }
    if(!progressed)break;
  }
  if(chosen.size<cap){
    for(const row of [...all].sort((a,b)=>(Number(b.amount)||0)-(Number(a.amount)||0))){
      if(chosen.size>=cap)break;
      const code=String(row.code);
      if(!chosen.has(code))chosen.set(code,{...row,wideNewsPrescreenLanes:['liquidity-fill']});
    }
  }
  return {rows:[...chosen.values()],universeCount:all.length,selectedCount:chosen.size,laneCounts:Object.fromEntries(
    lanes.map(([lane])=>[lane,[...chosen.values()].filter(row=>row.wideNewsPrescreenLanes.includes(lane)).length])
  )};
}

export async function scanUniverseCatalystNews(universeRows, capturedAt, {limit=60, concurrency=4, batchSize=8, maxScanSymbols=320}={}) {
  const allStocks=Array.isArray(universeRows)?universeRows:[];
  const prescreen=selectWideNewsScanUniverse(allStocks,maxScanSymbols);
  const stocks=prescreen.rows;
  const stockByCode=new Map(stocks.map(row=>[String(row.code),row]));
  const groups=chunks(stocks,Math.max(1,Math.min(8,batchSize)));
  const failures=[];
  let successfulSymbolCount=0;
  const candidates=[];
  const batches=await mapLimit(groups,Math.max(1,Math.min(4,concurrency)),async group=>{
    const codes=group.map(row=>String(row.code)).filter(code=>/^\d{6}$/.test(code));
    if(!codes.length)return {items:[]};
    const payload=parseResult('wide_news_batch',await invoke(marketHandler,'/api/market?action=news_batch&codes='+codes.join(',')));
    return {items:payload?.items??payload?.data?.items??[]};
  });
  for(let i=0;i<batches.length;i++){
    const batch=batches[i];
    if(batch?.error){failures.push({batch:i,error:batch.error});continue;}
    for(const item of batch.items??[]){
      const code=String(item?.code??''),stock=stockByCode.get(code);
      if(!stock||item?.error||!item?.news)continue;
      successfulSymbolCount++;
      const candidate=buildWideNewsCandidate(stock,item.news,capturedAt);
      if(candidate)candidates.push(candidate);
    }
  }
  candidates.sort((a,b)=>{
    const sa=.75*a.headlineCatalystScore+.20*a.newsRecencyScore+2*Math.min(3,a.positiveHeadlineCount);
    const sb=.75*b.headlineCatalystScore+.20*b.newsRecencyScore+2*Math.min(3,b.positiveHeadlineCount);
    return sb-sa||b.datedNewsCount-a.datedNewsCount;
  });
  return {candidates:candidates.slice(0,Math.max(1,Math.min(100,limit))),
    diagnostics:{enabled:true,universeCount:allStocks.length,scannedSymbolCount:stocks.length,prescreenLaneCounts:prescreen.laneCounts,batchCount:groups.length,successfulSymbolCount,
      positiveCatalystCount:candidates.length,selectedCount:Math.min(candidates.length,Math.max(1,Math.min(100,limit))),
      failedBatchCount:failures.length,failures:failures.slice(0,20),
      policy:'Only timestamp-verified positive headlines at or before capturedAt; headline classifier is experimental.'}};
}

async function fetchCurrentQuoteForNewsCandidate(stock) {
  try {
    const payload=parseResult('news_candidate_quote',await invoke(marketHandler,'/api/market?action=quote&code='+encodeURIComponent(stock.code)));
    const q=payload?.data?.data??payload?.data??{};
    const pct=n(q.f170),price=n(q.f43);
    if(price===null||price<=0||pct===null)return null;
    const board=stock.board??boardForCode(stock.code);
    const limitPct=board==='CHINEXT'||board==='STAR'?20:board==='BSE'?30:10;
    if(pct>=limitPct*.75)return null;
    return {f12:stock.code,f14:stock.name,f2:price,f3:pct,f6:n(q.f48),f8:n(q.f168),
      f62:n(q.f62),f184:n(q.f184),f100:stock.industry??q.f100??'',rankScore:0,rankHits:0,ranks:{},
      board,funnelLanes:['wide-news-catalyst']};
  } catch { return null; }
}

export async function captureV13LiveSnapshot({out=null,candidateLimit=120,asOf=null,wideNewsScan=false}={}){
  const capturedAt=new Date().toISOString(),requestedAsOf=asOf||capturedAt;
  const dailyBarComplete=isDailyBarCompleteAt(capturedAt);
  const ranked=parseResult('ranked_candidates',await invoke(marketHandler,'/api/market?action=ranked_candidates'));
  let raw=ranked?.data?.candidates??[];
  const fullUniverseFallback={attempted:false,used:false,error:null,universeCount:0,providerTotal:null,pageCount:null,segmentTotals:null};
  let fullUniverseSnapshot=null;
  if(ranked?.data?.degraded===true||ranked?.data?.serverStale===true||raw.length<300){
    fullUniverseFallback.attempted=true;
    try{
      fullUniverseSnapshot=await fetchUniverse({concurrency:4,pageSize:100});
      const fullRows=mapUniverseRowsToRankCandidates(fullUniverseSnapshot.rows);
      if(fullRows.length<3000)throw new Error('full-universe quote fallback returned only '+fullRows.length+' usable rows');
      raw=fullRows;
      fullUniverseFallback.used=true;
      fullUniverseFallback.universeCount=fullRows.length;
      fullUniverseFallback.providerTotal=fullUniverseSnapshot.providerTotal;
      fullUniverseFallback.pageCount=fullUniverseSnapshot.pageCount;
      fullUniverseFallback.segmentTotals=fullUniverseSnapshot.segmentTotals??null;
    }catch(error){
      fullUniverseFallback.error=String(error?.message??error);
      fullUniverseSnapshot=null;
    }
  }
  const rankingSourceDegraded=!fullUniverseFallback.used&&ranked?.data?.degraded===true;
  const rankingSourceStale=!fullUniverseFallback.used&&ranked?.data?.serverStale===true;
  const rankingSourceMethod=fullUniverseFallback.used?'eastmoney-full-universe-live-quote-fallback':ranked?.data?.method??null;
  let funnel=selectCandidateFunnel(raw,candidateLimit);
  const seededNewsByCode=new Map();
  let wideNewsDiagnostics={enabled:false,reason:'not-requested'};
  if(wideNewsScan){
    try{
      const universe=fullUniverseSnapshot??await fetchUniverse({concurrency:4,pageSize:100});
      const scan=await scanUniverseCatalystNews(universe.rows,capturedAt,{limit:60,concurrency:4,batchSize:8,maxScanSymbols:320});
      wideNewsDiagnostics={...scan.diagnostics,providerTotal:universe.providerTotal,pageCount:universe.pageCount};
      const existing=new Set(funnel.map(row=>String(row.f12)));
      const candidates=scan.candidates.filter(row=>!existing.has(row.code)).slice(0,60);
      const quotes=await mapLimit(candidates,4,fetchCurrentQuoteForNewsCandidate);
      const additions=quotes.filter(Boolean).slice(0,20);
      for(const stock of additions){
        const source=candidates.find(row=>row.code===stock.f12);
        if(source)seededNewsByCode.set(stock.f12,source.newsItems??[]);
      }
      funnel=[...funnel,...additions];
      wideNewsDiagnostics={...wideNewsDiagnostics,quoteCheckedCount:candidates.length,
        quoteEligibleCount:quotes.filter(Boolean).length,addedToFunnelCount:additions.length};
    }catch(error){
      wideNewsDiagnostics={enabled:true,failed:true,error:String(error?.message??error),
        policy:'Wide scan failure does not invalidate the normal funnel; no unverified news candidates are added.'};
    }
  }
  const industryContextByCode=deriveLiveIndustryContext([...raw,...funnel]);
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
  if(fullUniverseFallback.error)sourceErrors.push('full-universe-quote-fallback: '+fullUniverseFallback.error);
  for(const batch of batches){
    if(batch.deep) for(const item of batch.deep.items??[]) deepByCode.set(String(item.code??''),item);
    else sourceErrors.push('deep_batch: '+batch.deepError);
    if(batch.psych){
      for(const code of batch.codes) psychSuccessCodes.add(code);
      for(const [code,themes] of Object.entries(batch.psych.data?.themeBySymbol??{})) psychByCode.set(code,Array.isArray(themes)?themes:[]);
    } else sourceErrors.push('psychology_universe: '+batch.psychError);
  }
  let retryAttemptCount=0,retryRecoveredKlineCount=0,retryRecoveredFlowCount=0;
  const retryTargets=funnel.filter(row=>{
    const item=deepByCode.get(String(row.f12)),q=item?.dataQuality??{};
    return item&&((q.klineSource&&q.klineSource!=='eastmoney')||(q.flowSource&&q.flowSource!=='eastmoney'));
  });
  await mapLimit(retryTargets,4,async row=>{
    const code=String(row.f12),item=deepByCode.get(code);
    if(!item||item.error)return;
    item.dataQuality=item.dataQuality??{};
    if(item.dataQuality.klineSource!=='eastmoney'){
      retryAttemptCount++;
      try{
        const payload=parseResult('kline retry',await invoke(marketHandler,'/api/market?action=kline&code='+encodeURIComponent(code)));
        if(Array.isArray(payload?.data?.klines)&&payload.data.klines.length>=25&&payload.source!=='tencent-kline-fallback'){
          item.kline=payload;item.dataQuality.klineSource='eastmoney';retryRecoveredKlineCount++;
        }
      }catch{}
    }
    if(item.dataQuality.flowSource!=='eastmoney'){
      retryAttemptCount++;
      try{
        const payload=parseResult('flow retry',await invoke(marketHandler,'/api/market?action=flow&code='+encodeURIComponent(code)));
        if(Array.isArray(payload?.data?.klines)&&payload.data.klines.length>=3&&payload.source!=='neutral-flow-fallback'&&payload.degraded!==true){
          item.flow=payload;item.dataQuality.flowSource='eastmoney';retryRecoveredFlowCount++;
        }
      }catch{}
    }
  });
  const newsByCode=new Map(seededNewsByCode),newsSuccessCodes=new Set(seededNewsByCode.keys());
  const alreadyScanned=new Set(seededNewsByCode.keys());
  const newsBatches=await mapLimit(chunks(funnel.filter(row=>!alreadyScanned.has(String(row.f12))),8),2,async group=>{
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
    const quoteMainNet=n(row.f62),quoteMainPct=n(row.f184);
    const currentFlowSnapshot=flows.length===0&&(quoteMainNet!==null||quoteMainPct!==null)
      ?{date:String(requestedAsOf).slice(0,10),mainNet:quoteMainNet,mainPct:quoteMainPct,amount:n(row.f6)??bars.at(-1)?.amount??0,source:'quote-snapshot'}:null;
    const themePsychology=buildPsychologySector(psychByCode.get(code)??[],capturedAt);
    const newsFallback=buildStockNewsFallback(code,String(row.f14??code),newsByCode.get(code)??[],capturedAt);
    const psychology={sector:{...themePsychology.sector,...(themePsychology.sector.catalystScore==null&&newsFallback.sector.catalystScore!=null?{catalystScore:newsFallback.sector.catalystScore}:{})},
      overlay:themePsychology.overlay.available?{...themePsychology.overlay,stockNewsFallback:newsFallback.overlay}:newsFallback.overlay};
    const candidate={code,name:String(row.f14??code),asOf:requestedAsOf,isST:/(^|\*)ST(?=[\u4e00-\u9fff\d\s]|$)|^退/i.test(String(row.f14??'')),bars,flows,currentFlowSnapshot,
      sector:{...(industryContextByCode.get(code)??{}),...psychology.sector},
      amount:bars.at(-1)?.amount??n(row.f6),turnoverRate:bars.at(-1)?.turnoverRate??n(row.f8)};
    modelInputsByCode.set(code,candidate);
    const score=scoreCandidate(candidate,{asOf:requestedAsOf}),dq=deep?.dataQuality??{};
    records.push({code,name:candidate.name,board:boardForCode(code),funnelLanes:row.funnelLanes??[],
      quote:{price:n(row.f2),pct:n(row.f3),mainNetCny:n(row.f62),mainNetPct:n(row.f184),turnoverRate:n(row.f8),amount:n(row.f6),volumeRatio:n(row.f10),rankScore:n(row.rankScore),rankHits:n(row.rankHits),ranks:row.ranks??{}},
      score,psychology:psychology.overlay,source:{quoteTimestamp:n(row.f124),rankedGeneratedAt:ranked?.data?.generatedAt??null,
      klineSource:dq.klineSource??null,flowSource:flows.length>0&&flowUsable?'eastmoney':currentFlowSnapshot?'quote-snapshot':dq.flowSource??null,currentFlowSnapshotUsed:Boolean(currentFlowSnapshot),historicalFlowCount:flows.length,deepError:deep?.error??null,barCount:bars.length,flowCount:flows.length}});
  }
  const validRecords=records.filter(r=>r.score),recordByCode=new Map(validRecords.map(r=>[r.code,r]));
  const modelInputs=validRecords.map(r=>modelInputsByCode.get(r.code)).filter(Boolean);
  const rankedScores=rankCandidates(modelInputs,{asOf:requestedAsOf,modelVariant:'v13-core-only'})
    .map((s,i)=>{const record=recordByCode.get(s.code);return {...s,rank:i+1,quote:record?.quote??{},psychology:record?.psychology??{},source:record?.source??{}};});
  const scoreByCode=new Map(rankedScores.map(r=>[r.code,r]));
  const earlyRows=modelInputs.map(candidate=>{
    const base=scoreByCode.get(candidate.code);
    const opportunity=computeEarlyOpportunity({bars:candidate.bars,asOf:requestedAsOf,barComplete:dailyBarComplete,features:{sector:{score:base?.components?.sector},capital:{score:base?.components?.flow}}});
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
  const catalystRows=records.map(record=>{
    const overlay=record.psychology?.stockNewsFallback??record.psychology??{};
    const value=overlay.headlineCatalystScore;
    if(value===null||value===undefined||!Number.isFinite(Number(value)))return null;
    const base=scoreByCode.get(record.code);
    const early=earlyByCode.get(record.code);
    return {code:record.code,name:record.name,board:record.board,headlineCatalystScore:Number(value),
      headlineCatalystDirection:overlay.headlineCatalystDirection??'unclassified',
      classifiedHeadlineCount:overlay.classifiedHeadlineCount??0,
      positiveHeadlineCount:overlay.positiveHeadlineCount??0,negativeHeadlineCount:overlay.negativeHeadlineCount??0,
      catalystEvidence:overlay.catalystEvidence??[],timestampVerified:true,baseScore:base?.score??null,
      preLimitUpEligible:base?isPreLimitUpCandidate(base,early):false};
  }).filter(Boolean);
  const catalystConfirmed=catalystRows.map(row=>scoreCatalystConfirmed({
    ...row, base:scoreByCode.get(row.code), psychology:recordByCode.get(row.code)?.psychology,
    quote:recordByCode.get(row.code)?.quote, catalystEvidence:row.catalystEvidence
  })).filter(Boolean).sort((a,b)=>b.score-a.score||b.headlineCatalystScore-a.headlineCatalystScore).slice(0,20);
  const catalystWatch=catalystRows.filter(row=>row.preLimitUpEligible&&row.headlineCatalystDirection==='positive')
    .sort((a,b)=>b.headlineCatalystScore-a.headlineCatalystScore||(Number(b.baseScore)||0)-(Number(a.baseScore)||0)).slice(0,20);
  const negativeCatalystRisk=catalystRows.filter(row=>row.headlineCatalystDirection==='negative')
    .sort((a,b)=>a.headlineCatalystScore-b.headlineCatalystScore).slice(0,20);
  const overallCodes=interleaveCatalystCodes(balancedBlend.map(row=>row.code),catalystConfirmed.map(row=>row.code),30,6);
  const balancedByCode=new Map(balancedBlend.map(row=>[row.code,row]));
  const catalystByCode=new Map(catalystConfirmed.map(row=>[row.code,row]));
  const overall=overallCodes.map((code,index)=>{
    const main=balancedByCode.get(code), catalyst=catalystByCode.get(code);
    if(catalyst&&!main)return {...(scoreByCode.get(code)??{}),...catalyst,rank:index+1,
      modelVariant:'v13-live-catalyst-confirmed-blend',scorePath:'timestamped-catalyst-confirmed',
      catalystRankScore:catalyst.score,catalystComponents:catalyst.components};
    if(main&&catalyst)return {...main,rank:index+1,scorePath:'balanced-plus-catalyst-confirmed',
      catalystRankScore:catalyst.score,catalystComponents:catalyst.components};
    return {...main,rank:index+1};
  }).filter(row=>row.code);
  const deepGood=records.filter(r=>r.source.klineSource==='eastmoney'&&r.source.flowSource==='eastmoney').length;
  const barsGood=records.filter(r=>r.source.barCount>=25).length;
  const flowSignalGood=records.filter(r=>r.source.flowCount>0||r.source.currentFlowSnapshotUsed).length;
  const historicalFlowGood=records.filter(r=>r.source.flowSource==='eastmoney'&&r.source.historicalFlowCount>=3).length;
  const psychGood=records.filter(r=>r.psychology.available&&r.psychology.source!=='timestamped-stock-news-fallback').length;
  const quality={rankedSourceDegraded:rankingSourceDegraded,rankedSourceStale:rankingSourceStale,rankedSourceMethod:rankingSourceMethod,
    originalRankedSourceDegraded:ranked?.data?.degraded===true,originalRankedSourceMethod:ranked?.data?.method??null,
    rankedCandidateCount:raw.length,funnelCandidateCount:funnel.length,deepSuccessCount:deepGood,deepSuccessPct:+(deepGood/Math.max(1,funnel.length)*100).toFixed(2),
    industryContextCandidateCount:funnel.filter(row=>industryContextByCode.has(String(row.f12))).length,
    industryContextCoveragePct:+(funnel.filter(row=>industryContextByCode.has(String(row.f12))).length/Math.max(1,funnel.length)*100).toFixed(2),
    retryAttemptCount,retryRecoveredKlineCount,retryRecoveredFlowCount,
    flowSignalCount:flowSignalGood,flowSignalCoveragePct:+(flowSignalGood/Math.max(1,funnel.length)*100).toFixed(2),
    historicalFlowCount:historicalFlowGood,historicalFlowCoveragePct:+(historicalFlowGood/Math.max(1,funnel.length)*100).toFixed(2),
    quoteFlowFallbackCount:records.filter(r=>r.source.currentFlowSnapshotUsed).length,
    barHistoryCount:barsGood,barHistoryCoveragePct:+(barsGood/Math.max(1,funnel.length)*100).toFixed(2),
    psychologyResponseCount:psychSuccessCodes.size,psychologyCoveragePct:+(psychSuccessCodes.size/Math.max(1,funnel.length)*100).toFixed(2),
    psychologyThemeCount:psychGood,psychologyThemeCoveragePct:+(psychGood/Math.max(1,funnel.length)*100).toFixed(2),
    newsResponseCount:newsSuccessCodes.size,newsResponseCoveragePct:+(newsSuccessCodes.size/Math.max(1,funnel.length)*100).toFixed(2),
    datedNewsCandidateCount:records.filter(r=>Math.max(r.psychology.datedNewsCount??0,r.psychology.stockNewsFallback?.datedNewsCount??0)>0).length,
    datedNewsCoveragePct:+(records.filter(r=>Math.max(r.psychology.datedNewsCount??0,r.psychology.stockNewsFallback?.datedNewsCount??0)>0).length/Math.max(1,funnel.length)*100).toFixed(2),sourceErrors};
  const diagnosticRankings={overall:balancedBlend,catalystConfirmed,combinedOverall:overall,trendTransition:rankedScores.slice(0,20),
    emotionRepair:rankedScores.filter(r=>Number(r.components?.emotionRepair)>=65).sort((a,b)=>Number(b.components.emotionRepair)-Number(a.components.emotionRepair)).slice(0,20),
    oversold:rankedScores.filter(r=>Number(r.components?.oversoldReversal)>=65).sort((a,b)=>Number(b.components.oversoldReversal)-Number(a.components.oversoldReversal)).slice(0,20),
    coreRanking:rankedScores.slice(0,30),earlyOpportunity:earlyRows.slice(0,30),catalystWatch,negativeCatalystRisk};
  const snapshot={schema:'v13-live-psychology-catalyst-snapshot-v1',modelVersion:MODEL_VERSION,
    snapshotId:'v13-'+capturedAt.replace(/[-:.TZ]/g,''),capturedAt,asOf:requestedAsOf,
    sourcePolicy:{provider:'Eastmoney public quote/history and psychology/theme/news endpoint',pointInTime:'captured-at-source',
      futureDatedBarsExcluded:true,catalystOnlyUsedWhenNewsTimestampVerified:true,dailyBarCompleteAtCapture:dailyBarComplete,
      rankedUniverseFallback:fullUniverseFallback.used?'eastmoney-full-universe-live-quote-fallback':null,
      brokerConnected:false,automaticOrderPlacement:false},
    quality:{},coverage:{rawRankedCandidates:raw.length,funnelCandidates:funnel.length,scoredCandidates:rankedScores.length,
      preLimitUpEligibleCount:preLimitUpScores.length,earlyOpportunityCandidates:earlyRows.length,balancedBlendCount:balancedBlend.length,
      fullUniverseFallback,wideNewsScan:wideNewsDiagnostics},
    candidates:auditRecords,rankings:{
      overall,
      catalystConfirmed,
      trendTransition:preLimitUpScores.slice(0,20),
      emotionRepair:diagnosticRankings.emotionRepair,
      oversold:diagnosticRankings.oversold,
      coreRanking:preLimitUpScores.slice(0,30),
      earlyOpportunity:earlyRows.filter(row=>eligibleCodes.has(row.code)).slice(0,30),
      catalystWatch,
      negativeCatalystRisk
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
  const a=process.argv.slice(2);let out=null,candidateLimit=120,asOf=null,wideNewsScan=false;
  for(let i=0;i<a.length;i++){if(a[i]==='--out'&&a[i+1])out=a[++i];else if(a[i]==='--limit'&&a[i+1])candidateLimit=Math.max(50,Math.min(180,Number(a[++i])||120));else if(a[i]==='--as-of'&&a[i+1])asOf=a[++i];else if(a[i]==='--wide-news-scan')wideNewsScan=true;}
  await captureV13LiveSnapshot({out,candidateLimit,asOf,wideNewsScan});
}
