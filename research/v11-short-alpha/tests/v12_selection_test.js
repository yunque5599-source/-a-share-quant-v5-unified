import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDailyBars, evaluateOne } from '../evaluate_v12_snapshot.js';
import { analyzeV12Selection } from '../analyze_v12_selection.js';

function bars(start='2026-10-19') {
  return parseDailyBars([
    start+',10,11,12,9,100,1000',
    '2026-10-20,11,14,15,10,100,1000',
    '2026-10-21,14,13,14,11,100,1000',
    '2026-10-22,13,16,17,12,100,1000',
    '2026-10-23,16,15,16,12,100,1000'
  ]);
}

test('short-horizon outcome covers T+1..T+5 and bestHorizon', () => {
  const row = evaluateOne({
    symbol:'600001', price:10, asOf:'2026-10-16',
    scores:{v12SelectionRaw:88}, industry:'AI'
  }, bars(), {
    marketHistory:[
      {date:'2026-10-16',close:100},{date:'2026-10-19',close:101},
      {date:'2026-10-20',close:102},{date:'2026-10-21',close:103},
      {date:'2026-10-22',close:104},{date:'2026-10-23',close:105}
    ],
    sectorHistories:{AI:[
      {date:'2026-10-16',close:100},{date:'2026-10-19',close:100},
      {date:'2026-10-20',close:100},{date:'2026-10-21',close:101},
      {date:'2026-10-22',close:101},{date:'2026-10-23',close:101}
    ]}
  });
  assert.deepEqual(Object.keys(row.horizons), ['t1','t2','t3','t4','t5']);
  assert.equal(row.return_2d, 40);
  assert.equal(row.return_4d, 60);
  assert.equal(row.bestHorizon, 'T+4');
  assert.equal(row.bestHorizonBasis, 'market-excess-return');
  assert.equal(row.market_excess_return_1d, 9);
  assert.equal(row.sector_excess_return_3d, 29);
  assert.equal(row.MFE_3d, 50);
  assert.equal(row.MAE_3d, -10);
  assert.equal(row.outcomeStatus, 'complete');
});

test('UTC timestamp uses Asia/Shanghai trading date and excludes same-day bars', () => {
  const row=evaluateOne({symbol:'600001',price:10,asOf:'2026-10-16T16:30:00Z'},[
    {date:'2026-10-17',close:11,high:11,low:10},
    {date:'2026-10-20',close:12,high:12,low:11}
  ]);
  assert.equal(row.cutoffDate,'2026-10-17');
  assert.equal(row.horizons.t1.date,'2026-10-20');
  assert.equal(row.horizons.t1.returnPct,20);
});

test('missing high low never fabricates MFE or MAE', () => {
  const row=evaluateOne({symbol:'600001',price:10,asOf:'2026-10-16'},[
    {date:'2026-10-19',close:11},{date:'2026-10-20',close:12},
    {date:'2026-10-21',close:13},{date:'2026-10-22',close:14},
    {date:'2026-10-23',close:15}
  ]);
  assert.equal(row.horizons.t1.mfePct,null);
  assert.equal(row.horizons.t5.maePct,null);
});

test('selection analysis reports rank, quantile and market/time layers', () => {
  const rows=Array.from({length:5},(_,i)=>({
    symbol:'60000'+(i+1),selectionScore:100-i*10,
    psychology:{stage:'acceleration'},
    horizons:{t1:{returnPct:(4-i),marketExcessReturnPct:3-i,sectorExcessReturnPct:2-i,mfePct:4-i,maePct:-i}},
  }));
  const result=analyzeV12Selection({snapshots:[
    {asOf:'2026-10-16T03:15:00Z',decision:{market:{marketRisk:'weak',emotion:{label:'FEVER'}},datasetCandidates:rows}},
    {asOf:'2026-10-16T05:30:00Z',marketRegime:'bull',signals:rows}
  ]});
  assert.equal(result.schema,'v12-selection-analysis-v1');
  assert.equal(result.overall.t1.pairCount,10);
  assert.ok(result.overall.t1.rankIC > 0);
  assert.equal(result.overall.t1.top20.sampleCount,2);
  assert.ok(result.byMarketRegime.bear);
  assert.ok(result.byMarketRegime.bull);
  assert.ok(result.byEmotion.high);
  assert.ok(result.byEmotionStage.acceleration);
  assert.ok(result.byTimeBucket.morning_1115);
  assert.ok(result.overall.t1.top20.riskAdjustedReturnPct !== undefined);
});
