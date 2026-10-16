import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectionScoreOf } from './v12_selection_score.js';


const HORIZONS = Object.freeze([1,2,3,4,5]);
const list = value => Array.isArray(value) ? value : [];
const n = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const metric = value => value === null || !Number.isFinite(value) ? null :
  Math.round(value * 10000) / 10000;
const mean = values => values.length ? values.reduce((a,b)=>a+b,0)/values.length : null;

function pearson(a,b) {
  if (a.length < 3 || a.length !== b.length) return null;
  const ma=mean(a), mb=mean(b);
  const numerator=a.reduce((s,v,i)=>s+(v-ma)*(b[i]-mb),0);
  const da=Math.sqrt(a.reduce((s,v)=>s+(v-ma)**2,0));
  const db=Math.sqrt(b.reduce((s,v)=>s+(v-mb)**2,0));
  return da && db ? numerator/(da*db) : null;
}

function ranks(values) {
  const indexed=values.map((value,index)=>({value,index}))
    .sort((a,b)=>a.value-b.value||a.index-b.index);
  const out=Array(values.length);
  for(let i=0;i<indexed.length;){
    let j=i+1;while(j<indexed.length&&indexed[j].value===indexed[i].value)j++;
    const rank=(i+j-1)/2+1;
    for(let k=i;k<j;k++)out[indexed[k].index]=rank;
    i=j;
  }
  return out;
}

function signalsOf(snapshot) {
  if(Array.isArray(snapshot?.signals)) return snapshot.signals;
  if(Array.isArray(snapshot?.evaluated)) return snapshot.evaluated;
  return Array.isArray(snapshot?.decision?.datasetCandidates)
    ? snapshot.decision.datasetCandidates : [];
}

function horizonOf(row,h) {
  return row?.horizons?.['t'+h] ?? null;
}

function layerValue(snapshot, layer) {
  if(layer==='marketRegime') {
    return snapshot?.marketRegime ?? snapshot?.market?.regime ?? snapshot?.regime ?? 'unknown';
  }
  if(layer==='emotion') {
    const label=String(snapshot?.marketEmotion?.label ?? snapshot?.market?.emotion?.label ??
      snapshot?.emotion?.label ?? '').toUpperCase();
    if(['FEVER','RISING'].includes(label))return 'high';
    if(label==='NEUTRAL')return 'normal';
    if(['FADING','PANIC'].includes(label))return 'low';
    return 'unknown';
  }
  if(layer==='timeBucket') {
    const asOf=snapshot?.asOf ?? snapshot?.sourceSnapshot?.asOf;
    if(!asOf)return 'unknown';
    const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(asOf));
    const h=parts.find(x=>x.type==='hour')?.value, m=parts.find(x=>x.type==='minute')?.value;
    const time=h&&m? h+':'+m:null;
    return time==='11:15'?'morning_1115':time==='13:30'?'afternoon_1330':
      time==='14:45'?'close_1445':'unknown';
  }
  return 'unknown';
}

function topRows(rows,fraction,direction='top') {
  const valid=rows.filter(row=>Number.isFinite(selectionScoreOf(row)));
  if(!valid.length)return [];
  const count=Math.max(1,Math.ceil(valid.length*fraction));
  return [...valid].sort((a,b)=>(direction==='top'?-1:1) *
    (selectionScoreOf(a)-selectionScoreOf(b))).slice(0,count);
}

function metricBlock(rows,horizon) {
  const outcomes=rows.map(row=>horizonOf(row,horizon)).filter(Boolean);
  const field=key=>outcomes.map(item=>n(item[key])).filter(value=>value!==null);
  const returns=field('returnPct'), market=field('marketExcessReturnPct'),
    sector=field('sectorExcessReturnPct'), mfe=field('mfePct'), mae=field('maePct');
  return {
    sampleCount:outcomes.length,
    averageReturnPct:metric(mean(returns)),
    averageMarketExcessReturnPct:metric(mean(market)),
    averageSectorExcessReturnPct:metric(mean(sector)),
    winRatePct:returns.length?metric(returns.filter(x=>x>0).length/returns.length*100):null,
    mfeAvgPct:metric(mean(mfe)), maeAvgPct:metric(mean(mae)),
    unavailableMarketExcess:outcomes.filter(x=>x.marketExcessReturnPct===null).length,
    unavailableSectorExcess:outcomes.filter(x=>x.sectorExcessReturnPct===null).length
  };
}

function rankMetrics(rows,horizon) {
  const pairs=rows.map(row=>({row,outcome:horizonOf(row,horizon),score:selectionScoreOf(row)}))
    .filter(item=>item.outcome&&item.score!==null&&n(item.outcome.returnPct)!==null);
  const scores=pairs.map(x=>x.score), outcomes=pairs.map(x=>n(x.outcome.returnPct));
  const scoreRanks=ranks(scores), outcomeRanks=ranks(outcomes);
  const top=key=>metricBlock(topRows(rows,key),horizon);
  const top5=top(.05), top10=top(.10), top20=top(.20), bottom20=metricBlock(topRows(rows,.20,'bottom'),horizon);
  return {
    pairCount:pairs.length,
    rankIC:metric(pearson(scores,outcomes)),
    spearman:metric(pearson(scoreRanks,outcomeRanks)),
    top5,top10,top20,bottom20,
    topBottomSpreadPct:metric(top20.averageReturnPct===null||bottom20.averageReturnPct===null?null:top20.averageReturnPct-bottom20.averageReturnPct),
    t1: horizon===1 ? top20 : undefined,
    t3: horizon===3 ? top20 : undefined,
    t5: horizon===5 ? top20 : undefined
  };
}

function analyzeRows(rows) {
  return Object.fromEntries(HORIZONS.map(h=>['t'+h,rankMetrics(rows,h)]));
}

export function analyzeV12Selection(input={}) {
  const snapshots=Array.isArray(input)?input:list(input?.snapshots ?? input?.predictions ?? [input]);
  const diagnostics={snapshotCount:snapshots.length,emotionFallbackSnapshots:0};
  const overallRows=[];
  const layers={marketRegime:{},emotion:{},timeBucket:{}};
  for(const snapshot of snapshots){
    const rows=signalsOf(snapshot);
    const emotion=layerValue(snapshot,'emotion');
    if(emotion==='unknown')diagnostics.emotionFallbackSnapshots++;
    const meta={marketRegime:layerValue(snapshot,'marketRegime'),emotion,timeBucket:layerValue(snapshot,'timeBucket')};
    for(const row of rows)overallRows.push({...row,__meta:meta});
    for(const layer of Object.keys(layers)){
      const value=meta[layer];layers[layer][value]??=[];
      layers[layer][value].push(...rows);
    }
  }
  return {
    schema:'v12-selection-analysis-v1',
    version:'V12 Short-Horizon Cross-Sectional Selection Validation',
    selectionScoreDefinition:'V12SelectionScore = frozen Alpha60 + Timing25 + Psychology15; no future outcome fields',
    horizons:HORIZONS,
    diagnostics,
    overall:analyzeRows(overallRows),
    byMarketRegime:Object.fromEntries(Object.entries(layers.marketRegime).map(([k,v])=>[k,analyzeRows(v)])),
    byEmotion:Object.fromEntries(Object.entries(layers.emotion).map(([k,v])=>[k,analyzeRows(v)])),
    byTimeBucket:Object.fromEntries(Object.entries(layers.timeBucket).map(([k,v])=>[k,analyzeRows(v)]))
  };
}

export const runV12SelectionAnalysis=analyzeV12Selection;
async function main(args){
  const i=args.indexOf('--input');if(i<0||!args[i+1])throw new Error('usage: node analyze_v12_selection.js --input FILE');
  const input=JSON.parse(await readFile(resolve(args[i+1]),'utf8'));
  console.log(JSON.stringify(analyzeV12Selection(input),null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main(process.argv.slice(2));
