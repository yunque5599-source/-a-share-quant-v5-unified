import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { finiteNumber, round, asOfDate } from '../schema.js';
import { backtestAlpha } from './alpha_backtest.js';
import { classifyMarketRegime } from '../market_regime.js';

const strategies = ['composite', 'v12'];
const horizons = [1, 3, 5];
const topNs = [1, 5];
const list = value => Array.isArray(value) ? value : [];
const n = value => finiteNumber(value);
const mean = values => values.length ? values.reduce((a,b)=>a+b,0)/values.length : null;
const metric = value => value === null || !Number.isFinite(value) ? null : round(value);

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
    const periodReturn = mean(groups.get(date));
    if (periodReturn === null) continue;
    equity *= 1 + periodReturn / 100;
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
    sampleCount:valid.length,
    tradeCount:valid.length,
    unavailable:trades.length-valid.length,
    averageReturnPct:metric(mean(returns)),
    winRatePct:valid.length?metric(wins.length/valid.length*100):null,
    maxDrawdownPct:metric(maxDrawdown(valid,field)),
    payoffRatio:metric(payoff(returns)),
    buyNowSamples:buyNow.length,
    buyNowCorrect:correct,
    buyNowAccuracyPct:buyNow.length?metric(correct/buyNow.length*100):null
  };
}

function dateOf(snapshot) {
  return asOfDate(snapshot?.asOf ?? snapshot?.date ?? snapshot?.generatedAt);
}

function periods(input,snapshots) {
  const explicit=list(input?.periods)
    .map((p,i)=>({
      name:String(p?.name??'period-'+(i+1)),
      start:asOfDate(p?.start),
      end:asOfDate(p?.end)
    }))
    .filter(p=>p.start&&p.end);
  if(explicit.length) {
    return explicit.map(p=>({
      ...p,
      snapshots:snapshots.filter(s=>{
        const d=dateOf(s);
        return d&&d>=p.start&&d<=p.end;
      })
    }));
  }
  return [{
    name:'all',
    start:dateOf(snapshots[0]),
    end:dateOf(snapshots.at(-1)),
    snapshots
  }];
}

function store() {
  return Object.fromEntries(strategies.map(strategy=>[
    strategy,
    Object.fromEntries(
      ['overall','bull','bear','sideways','unknown'].map(regime=>[
        regime,
        Object.fromEntries(
          topNs.map(topN=>[
            'top'+topN,
            Object.fromEntries(horizons.map(h=>['T+'+h,[]]))
          ])
        )
      ])
    )
  ]));
}

function emptyDelta() {
  return {
    averageReturnPct:null,
    winRatePct:null,
    maxDrawdownPct:null,
    payoffRatio:null
  };
}

function delta(v12, composite) {
  const value = (a,b) => a === null || b === null ? null : metric(a-b);
  return {
    averageReturnPct:value(v12.averageReturnPct,composite.averageReturnPct),
    winRatePct:value(v12.winRatePct,composite.winRatePct),
    maxDrawdownPct:value(v12.maxDrawdownPct,composite.maxDrawdownPct),
    payoffRatio:value(v12.payoffRatio,composite.payoffRatio)
  };
}

function ranking(snapshot) {
  return list(snapshot?.ranking ?? snapshot?.candidates ?? snapshot?.stocks);
}

/**
 * Walk-forward V12 validation against the existing Composite baseline.
 *
 * The training window is chronological isolation metadata only because the
 * current Alpha/Timing/Psychology weights are fixed. No validation snapshot
 * is allowed to influence another validation fold. Both strategies use the
 * same replay engine and the same transaction-cost assumptions.
 */
export function benchmarkV12OutOfSample(input={}, options={}) {
  const raw=list(input?.predictions)
    .map((snapshot,index)=>({snapshot,index,date:dateOf(snapshot)}))
    .filter(x=>x.date)
    .sort((a,b)=>a.date.localeCompare(b.date)||a.index-b.index)
    .map(x=>x.snapshot);

  const trainSize=Math.max(1,Math.floor(n(options.trainSize)??2));
  const testSize=Math.max(1,Math.floor(n(options.testSize)??2));
  const step=Math.max(1,Math.floor(n(options.step)??testSize));
  const costs=options.costs??{commissionBps:3,stampTaxBps:5,slippageBps:5};
  const regimeNames=['bull','bear','sideways','unknown'];
  const aggregateStore=store();
  const folds=[];

  for(let start=trainSize;start<raw.length;start+=step){
    const train=raw.slice(Math.max(0,start-trainSize),start);
    const validation=raw.slice(start,start+testSize);
    if(validation.length<testSize && options.includePartial!==true) continue;

    const regimeByDate=new Map(
      validation.map(snapshot=>[dateOf(snapshot),classifyMarketRegime(snapshot).regime])
    );
    const selections = Object.fromEntries(strategies.map(strategy => {
      const ordered = orderedRanking(
        ranking(validation[0]),
        strategy === 'composite' ? 'composite' : 'v12'
      );
      return [strategy, ordered[0]?.symbol ?? ordered[0]?.code ?? null];
    }));
    const fold={
      fold:folds.length+1,
      training:{
        start:dateOf(train[0]),
        end:dateOf(train.at(-1)),
        count:train.length
      },
      selection:selections,
      selectionChanged:selections.composite !== selections.v12,
      validation:{
        start:dateOf(validation[0]),
        end:dateOf(validation.at(-1)),
        count:validation.length
      },
      regimes:Object.fromEntries(
        regimeNames.map(regime=>[
          regime,
          validation.filter(s=>classifyMarketRegime(s).regime===regime).length
        ])
      ),
      strategies:{}
    };

    for(const strategy of strategies){
      const selectionScore=strategy==='composite'?'composite':'v12';
      fold.strategies[strategy]={};
      for(const topN of topNs){
        const replay=backtestAlpha(
          {predictions:validation,histories:input?.histories??input?.historyBySymbol??{}},
          {topN,selectionScore,horizons,costs}
        );
        const key='top'+topN;
        fold.strategies[strategy][key]={};
        for(const h of horizons){
          const hKey='T+'+h;
          const trades=replay.results[hKey]?.trades??[];
          fold.strategies[strategy][key][hKey]=summary(trades,'returnPct');
          aggregateStore[strategy].overall[key][hKey].push(...trades);
          for(const regime of regimeNames){
            aggregateStore[strategy][regime][key][hKey].push(
              ...trades.filter(t=>regimeByDate.get(t.entryDate)===regime)
            );
          }
        }
      }
    }
    folds.push(fold);
  }

  const aggregate={};
  for(const strategy of strategies){
    aggregate[strategy]={};
    for(const regime of ['overall',...regimeNames.filter(x=>x!=='overall')]){
      aggregate[strategy][regime]={};
      for(const topN of topNs){
        const key='top'+topN;
        aggregate[strategy][regime][key]={};
        for(const h of horizons){
          const trades=aggregateStore[strategy][regime][key]['T+'+h];
          aggregate[strategy][regime][key]['T+'+h]={
            net:summary(trades,'returnPct'),
            gross:summary(trades,'grossReturnPct')
          };
        }
      }
    }
  }

  const deltaVsComposite={};
  for(const regime of ['overall',...regimeNames]){
    deltaVsComposite[regime]={};
    for(const topN of topNs){
      const key='top'+topN;
      deltaVsComposite[regime][key]={};
      for(const h of horizons){
        const v12=aggregate.v12?.[regime]?.[key]?.['T+'+h]?.net ?? null;
        const composite=aggregate.composite?.[regime]?.[key]?.['T+'+h]?.net ?? null;
        deltaVsComposite[regime][key]['T+'+h]=
          v12 && composite ? delta(v12,composite) : emptyDelta();
      }
    }
  }

  return {
    schema:'v12-trade-oos-v2',
    version:'V12 TradeScore Out-of-Sample Validation vs Composite',
    config:{
      strategies,
      trainSize,testSize,step,horizons,topNs,
      costs,
      selectionScores:{
        composite:'Alpha*0.70 + Timing*0.30',
        v12:'Alpha*0.60 + Timing*0.25 + Psychology*0.15'
      },
      regimes:regimeNames
    },
    folds,
    aggregate,
    deltaVsComposite,
    diagnostics:{
      snapshotCount:raw.length,
      foldCount:folds.length,
      validationSnapshotCount:folds.reduce((sum,f)=>sum+(f.validation.count??0),0),
      top1SelectionComparisons:folds.length,
      top1SelectionChangedCount:folds.filter(f=>f.selectionChanged).length,
      top1SelectionOverlapPct:folds.length
        ? metric(folds.filter(f=>!f.selectionChanged).length / folds.length * 100) : null
    }
  };
}

export const runV12OutOfSample=benchmarkV12OutOfSample;

async function main(args){
  const i=args.indexOf('--input');
  if(i<0||!args[i+1]) {
    throw new Error('Usage: node research/v11-short-alpha/backtest/v12_oos.js --input FILE');
  }
  const input=JSON.parse(await readFile(resolve(args[i+1]),'utf8'));
  console.log(JSON.stringify(benchmarkV12OutOfSample(input),null,2));
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(e=>{
    console.error('V12 OOS: '+e.message);
    process.exitCode=1;
  });
}
