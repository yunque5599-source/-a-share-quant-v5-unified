import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ALPHA_WEIGHTS, createCandidateRecord, finiteNumber } from '../schema.js';
import { scoreCandidate, rankCandidates } from '../alpha_score.js';
import { integrateCandidateFlow } from '../candidate_flow.js';

const fixtureUrl = new URL('./fixtures/v11_flow.json', import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'));
const clone = () => structuredClone(fixture);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, actual + ' != ' + expected);
function record(scores, extra = {}) {
  return {
    symbol: '600001', marketRisk: 'normal',
    features: Object.fromEntries(Object.keys(ALPHA_WEIGHTS).map((key, i) => [key, { score: scores[i] }])),
    ...extra
  };
}
function first(result) { return result.ranking.find(candidate => candidate.symbol === '600001'); }

test('canonical schema rejects malformed numbers and clamps genuine scores', () => {
  for (const value of [null, undefined, '', ' ', '-', true, [], {}, NaN, Infinity]) {
    assert.equal(finiteNumber(value), null);
  }
  const candidate = createCandidateRecord(record(['90', 120, -10, 80, 100]));
  assert.equal(candidate.schema, 'v11-short-alpha-candidate-v1');
  assert.equal(candidate.features.capital.score, 90);
  assert.equal(candidate.features.momentum.score, 100);
  assert.equal(candidate.features.sector.score, 0);
  assert.equal(candidate.quality.complete, true);
});

test('Alpha implements exactly 30/25/20/15/10 with positive risk safety', () => {
  assert.deepEqual(ALPHA_WEIGHTS, { capital: .30, momentum: .25, sector: .20, volume: .15, risk: .10 });
  const candidate = scoreCandidate(record([80, 70, 60, 50, 90]));
  near(candidate.scores.alpha, 70);
  near(candidate.scores.components.capital.contribution, 24);
  assert.ok(scoreCandidate(record([80, 70, 60, 50, 100])).scores.alpha >
    scoreCandidate(record([80, 70, 60, 50, 0])).scores.alpha);
});

test('missing factors keep fixed weights and cannot be declared complete', () => {
  const candidate = scoreCandidate(record([null, 100, 100, 100, 100], { quality: { complete: true } }));
  assert.equal(candidate.scores.alpha, 70);
  assert.equal(candidate.quality.complete, false);
  assert.deepEqual(candidate.quality.missing, ['capital']);
});

test('quality flags override caller complete=true', () => {
  for (const quality of [{ stale: true }, { degraded: true }, { blockedReasons: ['error'] }]) {
    const candidate = scoreCandidate(record([100, 100, 100, 100, 100], { quality: { ...quality, complete: true } }));
    assert.equal(candidate.quality.complete, false);
  }
});

test('rank uses unrounded scores, stable ties, first-symbol dedup, and no mutation', () => {
  const records = [
    record([89.999, 89.999, 89.999, 89.999, 89.999], { symbol: '600001' }),
    record([90, 90, 90, 90, 90], { symbol: '600002' }),
    record([90, 90, 90, 90, 90], { symbol: '600003' }),
    record([100, 100, 100, 100, 100], { symbol: '600001' })
  ];
  const before = JSON.stringify(records);
  const result = rankCandidates(records);
  assert.deepEqual(result.map(x => x.symbol), ['600002', '600003', '600001']);
  assert.equal(result[2].scores.alpha, 90);
  assert.ok(result[2].scores.alphaRaw < 90);
  assert.equal(JSON.stringify(records), before);
  assert.deepEqual(rankCandidates(null), []);
});

test('join existing ranked/deep/sector responses by code, not response order', () => {
  const input = clone();
  input.deep.items.reverse();
  const before = JSON.stringify(input);
  const result = integrateCandidateFlow(input);
  assert.equal(result.version, 'V11 Short Alpha Phase 1');
  assert.equal(result.ranking.length, 2);
  assert.equal(result.ranking[0].symbol, '600001');
  assert.equal(first(result).quality.complete, true);
  assert.equal(first(result).source.deep, true);
  assert.equal(JSON.stringify(input), before);
  assert.ok(result.ranking[0].scores.alpha > result.ranking[1].scores.alpha);
  assert.ok(['BUY', 'WATCH', 'WAIT'].includes(result.action));
});

test('5d/10d momentum and breakout use historical closes/highs, not f24 or rankScore', () => {
  const input = clone();
  const candidate = first(integrateCandidateFlow(input));
  const rows = input.deep.items[0].kline.data.klines.map(row => row.split(','));
  const close = i => +rows[i][2];
  near(candidate.features.momentum.return5dPct, (close(24) / close(19) - 1) * 100);
  near(candidate.features.momentum.return10dPct, (close(24) / close(14) - 1) * 100);
  near(candidate.features.momentum.breakoutStrengthPct,
    (close(24) / Math.max(...rows.slice(4, 24).map(row => +row[3])) - 1) * 100);
  input.ranked.data.candidates[0].f24 = 999;
  input.ranked.data.candidates[0].rankScore = 100;
  assert.deepEqual(first(integrateCandidateFlow(input)).scores, candidate.scores);
});

test('volume expansion uses volume and excludes current bar from its baseline', () => {
  const candidate = first(integrateCandidateFlow(fixture));
  near(candidate.features.volume.volumeRatio, 3);
  near(candidate.features.volume.volumeExpansionRatio, 3);
});

test('capital aligns last-five-session flow and never treats flow[11] price as amount', () => {
  const candidate = first(integrateCandidateFlow(fixture));
  near(candidate.features.capital.positiveFlowRatio5d, 1);
  near(candidate.features.capital.mainNetPct, 12);
  const input = clone();
  delete input.ranked.data.candidates[0].f184;
  input.deep.items[0].flow.data.klines = input.deep.items[0].flow.data.klines.map(row => {
    const fields = row.split(','); fields[6] = '-'; fields[11] = '0.001'; return fields.join(',');
  });
  near(first(integrateCandidateFlow(input)).features.capital.mainNetPct, 10);
});

test('capital flow preserves large and super-large order buckets for V12 psychology', () => {
  const input = clone();
  input.deep.items[0].flow.data.klines = input.deep.items[0].flow.data.klines.map(row => {
    const fields = row.split(',');
    fields[4] = '30000000'; // large-order net
    fields[5] = '20000000'; // super-large-order net
    fields[9] = '3';         // large-order net pct
    fields[10] = '2';        // super-large-order net pct
    return fields.join(',');
  });
  const candidate = first(integrateCandidateFlow(input));
  near(candidate.features.capital.largeOrderNet5dCny, 250000000);
  near(candidate.features.capital.superLargeOrderNet5dCny, 100000000);
  near(candidate.features.capital.largeOrderNetPct5d, 7);
  near(candidate.features.capital.largeOrderPositiveRatio5d, 1);
  assert.equal(candidate.features.capital.priorLargeOrderNetPct5d, 7);
});

test('sector ranking is reproducible from change pct, not supplied array order', () => {
  const input = clone();
  const before = first(integrateCandidateFlow(input)).features.sector;
  input.discovery.sectorResearch.sectors.reverse();
  const after = first(integrateCandidateFlow(input)).features.sector;
  assert.equal(before.rank, 1);
  assert.deepEqual(after, before);
});

test('risk measures peak-to-later-close drawdown, not current peak distance', () => {
  const input = clone();
  const rows = input.deep.items[0].kline.data.klines.map(row => row.split(','));
  rows[20][2] = '200';
  rows[21][2] = '100';
  rows[22][2] = '190';
  rows[23][2] = '195';
  rows[24][2] = '200';
  input.deep.items[0].kline.data.klines = rows.map(row => row.join(','));
  const candidate = first(integrateCandidateFlow(input));
  near(candidate.features.risk.maxDrawdown20dPct, 50);
  near(candidate.features.risk.currentDrawdownPct, 0);
  assert.equal(candidate.quality.complete, false);
  assert.ok(candidate.quality.blockedReasons.includes('risk-limit'));
  assert.notEqual(integrateCandidateFlow(input).action, 'BUY');
});

test('missing deep history is incomplete WATCH/WAIT, never invented SELL or BUY', () => {
  const input = clone(); input.deep.items = [];
  const result = integrateCandidateFlow(input);
  assert.equal(first(result).features.momentum.score, null);
  assert.equal(first(result).features.risk.score, null);
  assert.equal(first(result).quality.complete, false);
  assert.notEqual(result.action, 'BUY');
  assert.notEqual(result.action, 'SELL');
});

test('stale, neutral-flow, insufficient liquidity and unqualified sector data block BUY', () => {
  const cases = [
    input => { input.ranked.data.serverStale = true; },
    input => { input.deep.items[0].flow.source = 'neutral-flow-fallback'; input.deep.items[0].flow.degraded = true; },
    input => { input.deep.items[0].dataQuality.degraded = true; },
    input => { input.discovery.qualifiedForDiscovery = false; },
    input => { input.deep.items[0].barComplete = false; }
  ];
  for (const apply of cases) {
    const input = clone(); apply(input);
    const result = integrateCandidateFlow(input);
    assert.equal(first(result).quality.complete, false);
    assert.notEqual(result.action, 'BUY');
  }
  const weakLiquidity = integrateCandidateFlow(fixture).ranking[1];
  assert.ok(weakLiquidity.quality.blockedReasons.includes('liquidity-below-minimum'));
});

test('asOf excludes future rows and preserves historical factors', () => {
  const input = clone();
  const baseline = first(integrateCandidateFlow(input));
  input.deep.items[0].kline.data.klines.push('2026-04-06,1,1,1,1,1,1');
  input.deep.items[0].flow.data.klines.push('2026-04-06,-999,0,0,0,0,-99,0,0,0,0,1,0');
  const actual = first(integrateCandidateFlow(input));
  assert.deepEqual(actual.features, baseline.features);
  assert.ok(actual.quality.warnings.includes('kline:future-row-ignored'));
});

test('duplicate or invalid history dates produce explicit quality blockers', () => {
  const input = clone();
  input.deep.items[0].kline.data.klines.push(input.deep.items[0].kline.data.klines[0]);
  const candidate = first(integrateCandidateFlow(input));
  assert.equal(candidate.quality.complete, false);
  assert.ok(candidate.quality.blockedReasons.includes('kline:duplicate-date'));
});

test('insufficient history cannot masquerade as a complete factor window', () => {
  const input = clone();
  input.deep.items[0].kline.data.klines = input.deep.items[0].kline.data.klines.slice(-10);
  assert.equal(first(integrateCandidateFlow(input)).quality.complete, false);
  input.deep.items[0].flow.data.klines = input.deep.items[0].flow.data.klines.slice(-1);
  assert.equal(first(integrateCandidateFlow(input)).features.capital.score, null);
});

test('supports existing CORE history maps and enriched candidate arrays', () => {
  const input = clone();
  const root = { ...input.ranked.data, sectorResearch: input.discovery.sectorResearch,
    historyBySymbol: Object.fromEntries(input.deep.items.map(item => [item.code, item.kline])),
    flowBySymbol: Object.fromEntries(input.deep.items.map(item => [item.code, item.flow])) };
  const expected = first(integrateCandidateFlow(input)).features;
  assert.deepEqual(first(integrateCandidateFlow({ data: root })).features, expected);
  const raw = { ...input.ranked.data.candidates[0], k: input.deep.items[0].kline.data.klines,
    f: input.deep.items[0].flow.data.klines };
  const enriched = integrateCandidateFlow([raw], { asOf: root.generatedAt, market: 'normal' });
  assert.equal(first(enriched).features.momentum.return5dPct, expected.momentum.return5dPct);
});

test('weak and unknown market preserve CORE WAIT gate', () => {
  assert.equal(integrateCandidateFlow(fixture, { market: 'weak' }).action, 'WAIT');
  assert.equal(integrateCandidateFlow(fixture, { market: 'unknown' }).action, 'WAIT');
});

test('empty, invalid and duplicate candidates are diagnosed safely', () => {
  assert.deepEqual(integrateCandidateFlow().ranking, []);
  const input = clone();
  input.ranked.data.candidates.push(input.ranked.data.candidates[0], null, { f12: 'bad' });
  const result = integrateCandidateFlow(input);
  assert.equal(result.ranking.length, 2);
  assert.equal(result.diagnostics.duplicateCandidates, 1);
  assert.equal(result.diagnostics.rejectedCandidates, 2);
});

test('new V11 CLI and existing CORE --model v11 path run without saving predictions', async () => {
  const file = fileURLToPath(fixtureUrl);
  const core = fileURLToPath(new URL('../../v1040-core/run.js', import.meta.url));
  const prediction = new URL('../../v1040-core/data/predictions/2026-10-12.json', import.meta.url);
  const before = await readFile(prediction, 'utf8');
  const v11 = fileURLToPath(new URL('../run.js', import.meta.url));
  const result = spawnSync(process.execPath, [v11, '--input', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const document = JSON.parse(result.stdout);
  assert.equal(document.ranking[0].schema, 'v11-short-alpha-candidate-v1');
  const integrated = spawnSync(process.execPath, [core, '--model', 'v11', '--input', file], { encoding: 'utf8' });
  assert.equal(integrated.status, 0, integrated.stderr);
  assert.match(integrated.stdout, /V11 Short Alpha Phase 1/);
  assert.match(integrated.stdout, /TOP1/);
  assert.match(integrated.stdout, /Decision:/);
  assert.equal(await readFile(prediction, 'utf8'), before);
});
