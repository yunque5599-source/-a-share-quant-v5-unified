import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {selectObservationCandidates, _internal} from '../research/v15_one_click_selection.js';
import {parseCodes} from '../api/market.js';
import {replayV15Snapshots} from '../research/v15_replay.js';

function row(code, overrides = {}) {
  return {
    code,
    name: '样本' + code,
    price: 20,
    pct: 2,
    amount: 120_000_000,
    turn: 4,
    pct60: 8,
    mainNet: 20_000_000,
    mainPct: 3,
    industry: '测试行业',
    rankScore: 65,
    rankHits: 2,
    ...overrides
  };
}

test('observation discovery exposes seven independent lanes', () => {
  const rows = [
    row('600001', {pct: 3, pct60: 8, turn: 4, industry: '成长行业'}),
    row('600002', {pct: 8.8, pct60: 15, turn: 12, industry: '强势行业'}),
    row('600003', {pct: -2, pct60: 4, turn: 10, mainNet: 5_000_000, mainPct: 1, industry: '资金行业'}),
    row('600004', {pct: -1, pct60: -22, turn: 12, mainNet: 8_000_000, mainPct: 1.5, industry: '反转行业'}),
    row('600005', {pct: 4, pct60: 2, turn: 1.5, mainNet: 2_000_000, mainPct: 1, industry: '低换手行业'}),
    row('600006', {pct: 1, pct60: 4, amount: 1_200_000_000, turn: 3, industry: '高成交行业'}),
    row('600007', {pct: 1, pct60: 2, industry: '板块共振'}),
    row('600008', {pct: 2, pct60: 3, industry: '板块共振'}),
    row('600009', {pct: 3, pct60: 4, industry: '板块共振'}),
    row('600010', {pct: 4, pct60: 5, industry: '板块共振'}),
    row('600011', {pct: 5, pct60: 6, industry: '板块共振'})
  ];
  const result = selectObservationCandidates(rows, {limit: 20});
  assert.equal(result.schema, 'v15-one-click-observation-lanes-v1');
  assert.equal(result.probabilityCalibration, 'NOT_CALIBRATED');
  assert.ok(result.laneCounts['early-breakout'] > 0);
  assert.ok(result.laneCounts['limit-up-approach'] > 0);
  assert.ok(result.laneCounts['capital-flow'] > 0);
  assert.ok(result.laneCounts['reversal-watch'] > 0);
  assert.ok(result.laneCounts['low-turnover-breakout'] > 0);
  assert.ok(result.laneCounts['industry-strength'] > 0);
  assert.ok(result.laneCounts['liquidity-volume'] > 0);
  assert.ok(result.laneTopCandidates['limit-up-approach'].length > 0);
});

test('shortlist is diversified, unique, and never grants entry eligibility', () => {
  const rows = Array.from({length: 40}, (_, i) => row(String(600100 + i), {
    pct: i % 10,
    pct60: i % 2 ? -18 : 12,
    turn: 1 + (i % 8),
    amount: 60_000_000 + i * 30_000_000,
    mainNet: i % 3 ? 3_000_000 : -1_000_000,
    mainPct: i % 3 ? 1.2 : -0.5,
    industry: i % 2 ? '行业甲' : '行业乙'
  }));
  const result = selectObservationCandidates(rows, {limit: 5, excludeCodes: new Set(['600100'])});
  assert.equal(result.selectedCount, result.candidates.length);
  assert.ok(result.candidates.length <= 5);
  assert.equal(new Set(result.candidates.map(x => x.code)).size, result.candidates.length);
  assert.ok(!result.candidates.some(x => x.code === '600100'));
  for (const candidate of result.candidates) {
    assert.equal(candidate.researchOnly, true);
    assert.equal(candidate.entryEligible, false);
    assert.ok(candidate.entryGateReasons.includes('research-observation-only-not-a-buy-signal'));
    assert.ok(candidate.observationLaneLabels.length > 0);
    assert.ok(Number.isFinite(candidate.observationScore));
  }
});

test('reversal observation does not convert a falling stock into a buy signal', () => {
  const rows = [
    row('600201', {pct: -3.5, pct60: -30, mainNet: 10_000_000, mainPct: 2, turn: 18}),
    row('600202', {pct: -5.5, pct60: -30, mainNet: 10_000_000, mainPct: 2, turn: 18})
  ];
  const result = selectObservationCandidates(rows, {limit: 10});
  const reversal = result.candidates.find(x => x.code === '600201');
  assert.ok(reversal);
  assert.ok(reversal.observationLanes.includes('reversal-watch'));
  assert.equal(reversal.entryEligible, false);
  assert.equal(_internal.limitPctForCode('300001'), 20);
  assert.equal(_internal.limitPctForCode('600001'), 10);
});

test('invalid, restricted, non-main-board and missing-data rows do not create observation candidates', () => {
  const rows = [
    row('600301', {name: '*ST样本'}),
    row('600302', {price: null}),
    row('600303', {amount: null}),
    row('600304', {pct: null}),
    row('300001', {}),
    row('688001', {}),
    row('900305', {})
  ];
  const result = selectObservationCandidates(rows, {limit: 10});
  assert.equal(result.validInputCount, 0);
  assert.equal(result.selectedCount, 0);
});

test('deep batch parser accepts the full 30+5 one-click scan set without duplicates', () => {
  const codes = Array.from({length: 35}, (_, i) => String(600500 + i));
  assert.equal(parseCodes(codes.join(','), 40).length, 35);
  assert.equal(parseCodes([...codes, codes[0], 'bad-code'].join(','), 40).length, 35);
  assert.equal(parseCodes(codes.join(',')).length, 30);
});

test('the observation lane module is wired into the actual one-click flow', async () => {
  const index = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const market = await readFile(new URL('../api/market.js', import.meta.url), 'utf8');
  assert.ok(index.includes("await import('./research/v15_one_click_selection.js')"));
  assert.ok(index.includes('selectObservationCandidates'));
  assert.ok(index.includes('renderShadow(shadowFinal, observationPlan)'));
  assert.ok(index.includes('exportResearchSnapshot'));
  assert.ok(market.includes("parseCodes(u.searchParams.get('codes'), 40)"));
  assert.ok(market.includes('candidates: rows.slice(0, 900)'));
  assert.ok(market.includes('f100,f124'));
  assert.ok(index.includes("quoteAt:Number.isFinite(+x.f124)")); 
  const selector = await readFile(new URL('../research/v15_one_click_selection.js', import.meta.url), 'utf8');
  assert.ok(selector.includes('/^(00|60)\\d{4}$/'));
  assert.ok(selector.includes('laneTopCandidates'));
});


function replaySnapshot() {
  return {
    schema: 'ashare-v15-full-universe-snapshot-v1',
    capturedAt: '2026-10-29T02:00:00.000Z',
    tradeDate: '2026-10-29',
    quality: {qualifiedForReplay: true, reasons: []},
    universe: {
      fields: ['code', 'name', 'price', 'specialTreatment'],
      rows: [
        ['600001', '股票甲', 10, false],
        ['600002', '股票乙', 20, false],
        ['600003', '股票丙', 30, false]
      ]
    },
    strategies: {
      primaryTop: [{code: '600001', score: 90}],
      legacyShadowTop: [{code: '600002', score: 80}],
      v15ObservationTop: [{code: '600003', score: 85}],
      observationLanes: {'limit-up-approach': [{code: '600003', score: 85, lanes: ['limit-up-approach']}]}
    }
  };
}

test('forward replay compares old and new candidate sets with verified labels', () => {
  const snapshot = replaySnapshot();
  const dailyBarsByCode = {
    '600001': [
      {date: '2026-10-29', close: 20, high: 20, low: 8, isLimitUp: true},
      {date: '2026-10-30', close: 10.5, high: 10.7, low: 10.1, isLimitUp: false}
    ],
    '600002': [{date: '2026-10-30', close: 22, high: 22, low: 20, isLimitUp: true}],
    '600003': [{date: '2026-10-30', close: 33, high: 33, low: 30, isLimitUp: true}]
  };
  const report = replayV15Snapshots({snapshots: [snapshot], dailyBarsByCode, horizons: [1], topKs: [1, 2]});
  const primary = report.perSnapshot.find(x => x.strategy === 'primaryTop' && x.requestedK === 1);
  const legacy = report.perSnapshot.find(x => x.strategy === 'legacyUnion' && x.requestedK === 2);
  const v15 = report.perSnapshot.find(x => x.strategy === 'v15Union' && x.requestedK === 2);
  assert.equal(primary.hitCount, 0, 'same-day daily candle must not leak into labels');
  assert.equal(legacy.hitCount, 1);
  assert.equal(v15.hitCount, 1);
  assert.equal(legacy.observedUniverseLimitUpCount, 2);
  assert.equal(legacy.observedPoolRecallAtK, 0.5);
  assert.equal(v15.observedPoolRecallAtK, 0.5);
});

test('unknown limit-up labels are excluded, not counted as misses', () => {
  const snapshot = replaySnapshot();
  const dailyBarsByCode = Object.fromEntries(['600001', '600002', '600003'].map(code => [
    code, [{date: '2026-10-30', close: 10, high: 11, low: 9}]
  ]));
  const report = replayV15Snapshots({snapshots: [snapshot], dailyBarsByCode, horizons: [1], topKs: [1]});
  const primary = report.perSnapshot.find(x => x.strategy === 'primaryTop' && x.requestedK === 1);
  assert.equal(primary.labelledCount, 0);
  assert.equal(primary.precisionAtK, null);
  assert.equal(primary.observedUniverseLimitUpCount, 0);
  assert.equal(primary.observedPoolRecallAtK, null);
});

test('same-day intraday labels are used only after the recorded capture timestamp', () => {
  const snapshot = replaySnapshot();
  const intradayBarsByCode = {
    '600001': [
      {date: '2026-10-29', timestamp: '2026-10-29T01:59:00.000Z', close: 10, high: 10, low: 10, isLimitUp: true},
      {date: '2026-10-29', timestamp: '2026-10-29T02:05:00.000Z', close: 11, high: 11, low: 10, isLimitUp: true}
    ]
  };
  const report = replayV15Snapshots({
    snapshots: [snapshot],
    dailyBarsByCode: {},
    intradayBarsByCode,
    horizons: [1],
    topKs: [1]
  });
  const primary = report.perSnapshot.find(x => x.strategy === 'primaryTop' && x.requestedK === 1);
  assert.equal(primary.hitCount, 1);
  assert.equal(primary.avgReturnPct, 10);
});

test('unqualified snapshots are skipped unless explicitly included', () => {
  const snapshot = replaySnapshot();
  snapshot.quality.qualifiedForReplay = false;
  const dailyBarsByCode = {'600001': [{date: '2026-10-30', close: 11, isLimitUp: true}]};
  const skipped = replayV15Snapshots({snapshots: [snapshot], dailyBarsByCode, horizons: [1], topKs: [1]});
  assert.equal(skipped.snapshotCount, 0);
  assert.equal(skipped.excludedSnapshots[0].reason, 'snapshot-not-qualified-for-replay');
  const included = replayV15Snapshots({snapshots: [snapshot], dailyBarsByCode, horizons: [1], topKs: [1], includeUnqualified: true});
  assert.equal(included.snapshotCount, 1);
});
