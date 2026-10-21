import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { backtestAlpha } from '../backtest/alpha_backtest.js';

const fixtureUrl = new URL('./fixtures/alpha_backtest.json', import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'));
const clone = () => structuredClone(fixture);

test('replays T+1, T+3 and T+5 without lookahead', () => {
  const before = JSON.stringify(fixture);
  const result = backtestAlpha(clone());
  assert.deepEqual(result.horizons, [1, 3, 5]);
  assert.equal(result.asOf, null);
  assert.equal(result.results['T+1'].observations, 4);
  assert.equal(result.results['T+1'].averageReturnPct, -0.72);
  assert.equal(result.results['T+1'].winRatePct, 25);
  assert.equal(result.results['T+1'].maxDrawdownPct, 1.43);
  assert.equal(result.results['T+1'].payoffRatio, 1.23);
  assert.equal(result.results['T+3'].averageReturnPct, -0.04);
  assert.equal(result.results['T+3'].winRatePct, 50);
  assert.equal(result.results['T+3'].maxDrawdownPct, 0.59);
  assert.equal(result.results['T+5'].averageReturnPct, 2.73);
  assert.equal(result.results['T+5'].winRatePct, 50);
  assert.equal(result.results['T+5'].maxDrawdownPct, 0);
  assert.equal(JSON.stringify(fixture), before);
  assert.equal(result.results['T+1'].trades[0].exitDate, '2026-01-06');
});

test('strictly excludes bars on or before asOf and reports unavailable horizons', () => {
  const input = {
    predictions: [{asOf:'2026-01-05',ranking:[
      {symbol:'600003',price:100,scores:{alpha:88},quality:{complete:true}}
    ]}],
    histories: {600003:[
      {date:'2026-01-04',close:99},
      {date:'2026-01-05',close:100},
      {date:'2026-01-06',close:102}
    ]}
  };
  const result = backtestAlpha(input);
  assert.equal(result.results['T+1'].observations, 1);
  assert.equal(result.results['T+1'].trades[0].returnPct, 2);
  for (const horizon of [3, 5]) {
    assert.equal(result.results['T+' + horizon].observations, 0);
    assert.equal(result.results['T+' + horizon].unavailable, 1);
    assert.equal(result.results['T+' + horizon].trades[0].reason, 'no-forward-bar');
  }
});

test('missing future data is excluded only from affected horizons', () => {
  const input = clone();
  input.predictions = [input.predictions[0]];
  input.histories['600002'] = input.histories['600002'].slice(0, 3);
  const result = backtestAlpha(input);
  assert.equal(result.results['T+1'].observations, 2);
  assert.equal(result.results['T+3'].observations, 1);
  assert.equal(result.results['T+3'].unavailable, 1);
  assert.equal(result.results['T+5'].observations, 1);
  assert.equal(result.results['T+5'].unavailable, 1);
  assert.equal(result.results['T+3'].trades.find(t => t.symbol === '600002').reason, 'no-forward-bar');
});

test('incomplete alpha rows are skipped unless explicitly included', () => {
  const input = clone();
  input.predictions = [input.predictions[0]];
  input.predictions[0].ranking.push({
    symbol:'600003', rank:3, price:50, scores:{alpha:60}, quality:{complete:false}
  });
  input.histories['600003'] = [
    {date:'2026-01-05',close:50},{date:'2026-01-06',close:55},
    {date:'2026-01-07',close:56},{date:'2026-01-08',close:57},
    {date:'2026-01-09',close:58},{date:'2026-01-12',close:59}
  ];
  const skipped = backtestAlpha(input, {horizons:[1]});
  assert.equal(skipped.results['T+1'].observations, 2);
  assert.equal(skipped.diagnostics.skippedIncomplete, 1);
  const included = backtestAlpha(input, {horizons:[1],includeIncomplete:true});
  assert.equal(included.results['T+1'].observations, 3);
});

test('duplicate and malformed dates fail safely instead of inventing returns', () => {
  const input = clone();
  input.predictions = [input.predictions[0]];
  input.histories['600001'].push({date:'2026-01-06',close:999});
  input.histories['600002'].push({date:'bad-date',close:50});
  const result = backtestAlpha(input, {horizons:[1]});
  assert.equal(result.results['T+1'].observations, 0);
  assert.equal(result.results['T+1'].unavailable, 2);
  assert.ok(result.diagnostics.duplicateDates >= 1);
  assert.ok(result.diagnostics.invalidDates >= 1);
  assert.ok(result.results['T+1'].trades.every(trade => trade.reason === 'invalid-history'));
});

test('payoff ratio is JSON-safe when there are no losing trades', () => {
  const result = backtestAlpha({
    predictions:[{asOf:'2026-01-05',ranking:[
      {symbol:'600001',price:100,scores:{alpha:90},quality:{complete:true}}
    ]}],
    histories:{600001:[
      {date:'2026-01-05',close:100},{date:'2026-01-06',close:105}
    ]}
  }, {horizons:[1]});
  assert.equal(result.results['T+1'].averageReturnPct, 5);
  assert.equal(result.results['T+1'].winRatePct, 100);
  assert.equal(result.results['T+1'].payoffRatio, null);
  assert.equal(JSON.stringify(result).includes('Infinity'), false);
});

test('early-opportunity score replays captured candidate snapshots independently from Alpha', () => {
  const input = {
    predictions:[{asOf:'2026-01-05',decision:{datasetCandidates:[
      {symbol:'600001',price:100,scores:{alpha:95},features:{earlyOpportunity:{score:40}},quality:{complete:true}},
      {symbol:'600002',price:100,scores:{alpha:70},features:{earlyOpportunity:{score:90}},quality:{complete:true}},
      {symbol:'600003',price:100,scores:{alpha:80},features:{earlyOpportunity:{score:70}},quality:{complete:true}}
    ]}}],
    histories:{
      '600001':[{date:'2026-01-05',close:100},{date:'2026-01-06',close:101}],
      '600002':[{date:'2026-01-05',close:100},{date:'2026-01-06',close:106}],
      '600003':[{date:'2026-01-05',close:100},{date:'2026-01-06',close:102}]
    }
  };
  const early = backtestAlpha(input, {topN:1,horizons:[1],selectionScore:'earlyOpportunity'});
  assert.equal(early.results['T+1'].trades[0].symbol, '600002');
  assert.equal(early.results['T+1'].trades[0].selectedBy, 'earlyOpportunity');
  assert.equal(early.results['T+1'].trades[0].selectionValue, 90);
  assert.equal(early.results['T+1'].trades[0].earlyOpportunityScore, 90);
  assert.equal(early.results['T+1'].averageReturnPct, 6);

  const alpha = backtestAlpha(input, {topN:1,horizons:[1],selectionScore:'alpha'});
  assert.equal(alpha.results['T+1'].trades[0].symbol, '600001');
  assert.equal(alpha.results['T+1'].trades[0].earlyOpportunityScore, 40);
});

test('CLI emits the validation document', () => {
  const moduleFile = fileURLToPath(new URL('../backtest/alpha_backtest.js', import.meta.url));
  const fixtureFile = fileURLToPath(fixtureUrl);
  const result = spawnSync(process.execPath, [moduleFile, '--input', fixtureFile], {encoding:'utf8'});
  assert.equal(result.status, 0, result.stderr);
  const document = JSON.parse(result.stdout);
  assert.equal(document.schema, 'v11-short-alpha-backtest-v1');
  assert.deepEqual(Object.keys(document.results), ['T+1','T+3','T+5']);
});
