import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { finiteNumber, round, asOfDate } from '../schema.js';
import { backtestAlpha } from './alpha_backtest.js';
import { classifyMarketRegime } from '../market_regime.js';

const horizons = [1, 3, 5];
const topNs = [1, 5];
const n = value => finiteNumber(value);
const mean = values => values.length ? values.reduce((a,b)=>a+b,0)/values.length : null;
const metric = value => value === null || !Number.isFinite(value) ? null : round(value);
const list = value => Array.isArray(value) ? value : [];

function maxDrawdown(trades, field) {
  if (!trades.length) return null;
  const groups = new Map();
  for (const trade of trades) {
    const values = groups.get(trade.entryDate) ?? [];
    values.push(trade[field]);
    groups.set(trade.entryDate, values);
  }
  let equity=1, peak=1, drawdown=0;
  for (const date of [...groups.keys()].sort()) {
    equity *= 1 + mean(groups.get(date)) / 100;
    peak=Math.max(peak,equity);
    drawdown=Math.max(drawdown,(peak-equity)/peak*100);
  }
  return drawdown;
}
function payoff(returns) {
  const wins=returns.filter(x=>x>0), losses=returns.filter(x=>x<0);
  if(!losses.length) return null;
  if(!wins.length) return 0;
  return mean(wins)/Math.abs(mean(losses));
}
function summary(trades, field) {
  const valid=trades.filter(t=>t.status==='ok' && Number.isFinite(t[field]));
  const returns=valid.map(t=>t[field]);
  const wins=returns.filter(x=>x>0);
  const buyNow=valid.filter(t=>t.timingSignal==='BUY_NOW');
  const correct=buyNow.filter(t=>t[field]>0).length;
  return {
    sampleCount:valid.length, tradeCount:valid.length, unavailable:trades.length-valid.length,
    averageReturnPct:metric(mean(returns)),
    winRatePct:valid.length?metric(wins.length/valid.length*100):null,
    maxDrawdownPct:metric(maxDrawdown(valid,field)),
    payoffRatio:metric(payoff(returns)),
    buyNowSamples:buyNow.length, buyNowCorrect:correct,
    buyNowAccuracyPct:buyNow.length?metric(correct/buyNow.length*100):null
  };
}
function dates(snapshot) { return asOfDate(snapshot?.asOf ?? snapshot?.date ?? snapshot?.generatedAt); }
function periods(input,snapshots) {
  const explicit=list(input?.periods).map((p,i)=>({name:String(p?.name??'period-'+(i+1)),start:asOfDate(p?.start),end:asOfDate(p?.end)})).filter(p=>p.start&&p.end);
  if(explicit.length) return explicit.map(p=>({...p,snapshots:snapshots.filter(s=>{const d=dates(s);return d&&d>=p.start&&d<=p.end;})}));
  return [{name:'all',start:dates(snapshots[0]),end:dates(snapshots.at(-1)),snapshots}];
}
function aggregateStore(regimes) {
  return Object.fromEntries(['overall',...regimes].map(regime=>[regime,Object.fromEntries(topNs.map(topN=>['top'+topN,Object.fromEntries(horizons.map(h=>['T+'+h,[]]))]))]));
}

/** Walk-forward V12 validation. Training windows are chronological metadata only;
 * V12 scores and market labels are read from each as-of snapshot, never future bars. */
export function benchmarkV12OutOfSample(input={}, options={}) {
  const raw=list(input?.predictions).map((snapshot,index)=>({snapshot,index,date:dates(snapshot)}))
    .filter(x=>x.date).sort((a,b)=>a.date.localeCompare(b.date)||a.index-b.index).map(x=>x.snapshot);
  const trainSize=Math.max(1,Math.floor(n(options.trainSize)??2));
  const testSize=Math.max(1,Math.floor(n(options.testSize)??2));
  const step=Math.max(1,Math.floor(n(options.step)??testSize));
  const costs=options.costs??{commissionBps:3,stampTaxBps:5,slippageBps:5};
  const regimeNames=['bull','bear','sideways','unknown'];
  const store=aggregateStore(regimeNames);
  const folds=[];
  for(let start=trainSize;start<raw.length;start+=step){
    const train=raw.slice(Math.max(0,start-trainSize),start);
    const validation=raw.slice(start,start+testSize);
    if(validation.length<testSize && options.includePartial!==true) continue;
    const regimeByDate=new Map(validation.map(snapshot=>[dates(snapshot),classifyMarketRegime(snapshot).regime]));
    const fold={fold:folds.length+1,training:{start:dates(train[0]),end:dates(train.at(-1)),count:train.length},validation:{start:dates(validation[0]),end:dates(validation.at(-1)),count:validation.length},regimes:{}};
    const predictions=validation.map(snapshot=>({...snapshot,ranking:list(snapshot.ranking??snapshot.candidates??snapshot.stocks)}));
    for(const topN of topNs){
      const replay=backtestAlpha({predictions,histories:input?.histories??input?.historyBySymbol??{}},{topN,selectionScore:'v12',horizons,costs});
      for(const h of horizons){
        const trades=replay.results['T+'+h]?.trades??[];
        store.overall['top'+topN]['T+'+h].push(...trades);
        for(const regime of regimeNames){
          store[regime]['top'+topN]['T+'+h].push(...trades.filter(t=>regimeByDate.get(t.entryDate)===regime));
        }
      }
    }
    for(const regime of ['bull','bear','sideways','unknown']) fold.regimes[regime]=validation.filter(s=>classifyMarketRegime(s).regime===regime).length;
    folds.push(fold);
  }
  const aggregate={};
  for(const regime of ['overall','bull','bear','sideways','unknown']){
    aggregate[regime]={};
    for(const topN of topNs){
      aggregate[regime]['top'+topN]={};
      for(const h of horizons){
        const trades=store[regime]['top'+topN]['T+'+h];
        aggregate[regime]['top'+topN]['T+'+h]={gross:summary(trades,'grossReturnPct'),net:summary(trades,'returnPct')};
      }
    }
  }
  return {schema:'v12-trade-oos-v1',version:'V12 TradeScore Out-of-Sample Validation',
    config:{trainSize,testSize,step,horizons,topNs,selectionScore:'v12',costs,regimes:['bull','bear','sideways','unknown']},
    folds,aggregate,diagnostics:{snapshotCount:raw.length,foldCount:folds.length}};
}
export const runV12OutOfSample=benchmarkV12OutOfSample;
async function main(args){
 const i=args.indexOf('--input'); if(i<0||!args[i+1]) throw new Error('Usage: node research/v11-short-alpha/backtest/v12_oos.js --input FILE');
 const input=JSON.parse(await readFile(resolve(args[i+1]),'utf8'));
 console.log(JSON.stringify(benchmarkV12OutOfSample(input),null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
 main(process.argv.slice(2)).catch(e=>{console.error('V12 OOS: '+e.message);process.exitCode=1;});
