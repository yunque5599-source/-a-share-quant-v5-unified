import test from 'node:test';
import assert from 'node:assert/strict';
import {buildV16DailySnapshot} from '../research/v16/snapshot_archive.js';
import {
  rankEarlyTrendPrefilter,
  aggregateIndustryRows,
  buildSectorFlowEvidence,
  scoreCapitalFlowResponse,
  scoreEntryTiming,
  buildV17OneClickSelection
} from '../research/v17_one_click_selection.js';

function stock(code, overrides = {}) {
  return {
    code, name: '样本股' + code, industry: '电子',
    price: 10, pct: 1.2, amount: 120000000, turn: 4.5,
    mainNet: 18000000, mainPct: 2.1, pct60: 12,
    low: 9.8, open: 9.9, high: 10.2, specialTreatment: false,
    ...overrides
  };
}

function industryRows({net = 10000000, pct = 1, low = 9.5, day = 0} = {}) {
  return Array.from({length: 8}, (_, index) => stock(String(600000 + index), {
    mainNet: net + index * 100000,
    amount: 50000000,
    pct: pct + index * 0.1,
    low: low + day * 0.1,
    price: 10 + day * 0.15
  }));
}

function qualifiedSnapshot(tradeDate, day) {
  return {
    tradeDate,
    capturedAt: tradeDate + 'T15:20:00+08:00',
    quality: {qualifiedForReplay: true},
    stockRows: industryRows({net: 8000000 + day * 1000000, pct: 0.7 + day * 0.2, low: 9.5 + day * 0.1, day}),
    market: {
      breadth: {universe: 'full-market', fullMarket: true, coverage: 0.995, up: 3200, down: 1800, flat: 100},
      indices: [{key: 'shanghai', name: '上证指数', trend5Pct: 0.8, changePct: 0.3}],
      turnover: {amountCny: 900000000000},
      sentiment: {limitUpCount: 50, limitDownCount: 5},
      sectors: [{key: '电子', d1Pct: 0.8, advancersRatio: 0.7, positiveFlowRatio: 0.75, leaderRelativeStrengthPct: 1.1}],
      leaders: []
    }
  };
}

function currentContext({fullMarket = false} = {}) {
  const rows = industryRows();
  const sector = {
    key: '电子', label: '电子', constituentCount: 8, d1Pct: 1.1,
    advancersRatio: 0.75, positiveFlowRatio: 0.75, netFlowCny: 75000000,
    leaderRelativeStrengthPct: 1.2, rankToday: 1
  };
  return {
    capturedAt: '2026-11-25T15:25:00+08:00',
    chinaCalendarDate: '2026-11-25',
    chinaCloseFinalized: true,
    aShareSessionDate: '2026-11-25',
    aShare: {
      dataStatus: fullMarket ? 'FINALIZED_SESSION' : 'LAST_AVAILABLE_SESSION',
      breadth: {
        fullMarket, universe: fullMarket ? 'full-market' : 'partial-market',
        coverage: fullMarket ? 0.995 : 0.15, uniqueSymbols: fullMarket ? 5800 : 900,
        totalReported: 5931, up: 3200, down: 1800, flat: 100
      },
      source: {complete: fullMarket, pagesFetched: fullMarket ? 60 : 9, pageCount: 60},
      stockRows: rows,
      sectors: [sector],
      marketAveragePct: 0.6,
      indices: [{key: 'shanghai', name: '上证指数', trend5Pct: 0.8, changePct: 0.3}],
      turnover: {amountCny: 900000000000},
      sentiment: {limitUpCount: 50, limitDownCount: 5, limitLabelQuality: 'APPROXIMATE_PROXY'},
      limitPools: {limitUp: [], limitDown: [], sourceStatus: {limitUp: 'NOT_MEASURABLE'}},
      lhb: {dailyStatus: 'NOT_MEASURABLE'}
    }
  };
}

function flatBars() {
  const rows = [];
  const start = Date.parse('2026-09-17T00:00:00Z');
  for (let index = 0; index < 70; index++) {
    const date = new Date(start + index * 86400000).toISOString().slice(0, 10);
    rows.push({
      date, open: 10, high: 10.2, low: 9.8, close: 10,
      volume: 1000000, amount: 10000000, turnover: 3,
      source: 'test fixture', availableAt: '2026-11-25T15:05:00+08:00'
    });
  }
  return rows;
}

test('early-flow prefilter ranks candidates but excludes ST, excessive daily moves and illiquid rows', () => {
  const rows = [
    stock('600001'),
    stock('600002', {name: '*ST风险股'}),
    stock('600003', {pct: 8.2}),
    stock('600004', {amount: 10000000}),
    stock('600005', {mainNet: -1000000, mainPct: -0.2}),
    stock('830001', {mainNet: 50000000, mainPct: 5})
  ];
  const result = rankEarlyTrendPrefilter(rows, {limit: 10});
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].code, '600001');
  assert.ok(result.rows[0].prefilterScore >= 0 && result.rows[0].prefilterScore <= 100);
  assert.equal(result.rows[0].use, 'DEEP_SCAN_PREFILTER_ONLY');
});

test('early-flow prefilter ordering is deterministic for equal inputs', () => {
  const rows = [stock('600003'), stock('600001'), stock('600002')];
  const first = rankEarlyTrendPrefilter(rows, {limit: 3}).rows.map(row => row.code);
  const second = rankEarlyTrendPrefilter(rows, {limit: 3}).rows.map(row => row.code);
  assert.deepEqual(first, second);
});

test('industry aggregation preserves flow ratio and breadth denominator', () => {
  const rows = [
    stock('600001', {mainNet: 10, amount: 100, pct: 1}),
    stock('600002', {mainNet: -5, amount: 100, pct: -1})
  ];
  const result = aggregateIndustryRows(rows)[0];
  assert.equal(result.sampleCount, 2);
  assert.equal(result.flowCount, 2);
  assert.equal(result.netFlowCny, 5);
  assert.equal(result.flowRatio, 0.025);
  assert.equal(result.positiveFlowRatio, 0.5);
  assert.equal(result.advancersRatio, 0.5);
});

test('three qualified sessions can identify sector inflow with breadth confirmation', () => {
  const snapshots = [
    qualifiedSnapshot('2026-11-23', 0),
    qualifiedSnapshot('2026-11-24', 1)
  ];
  const result = buildSectorFlowEvidence({
    currentRows: industryRows({net: 12000000, pct: 1.2, low: 9.7, day: 2}),
    priorSnapshots: snapshots,
    currentQualified: true,
    currentTradeDate: '2026-11-25',
    currentSectorRows: [{key: '电子', d1Pct: 1.2, advancersRatio: 0.8, positiveFlowRatio: 0.8, leaderRelativeStrengthPct: 1.4}],
    marketAveragePct: 0.5
  });
  const sector = result.find(row => row.industry === '电子');
  assert.equal(sector.status, 'REBOUND_CONFIRMED');
  assert.equal(sector.flowPositiveDays, 3);
  assert.ok(sector.persistenceScore > 50);
  assert.ok(sector.return3Pct > 0);
});

test('partial or missing snapshots never become multi-session persistence', () => {
  const snapshots = [
    {...qualifiedSnapshot('2026-11-23', 0), quality: {qualifiedForReplay: false}},
    {...qualifiedSnapshot('2026-11-24', 1), quality: {qualifiedForReplay: false}}
  ];
  const result = buildSectorFlowEvidence({
    currentRows: industryRows({net: 12000000}),
    priorSnapshots: snapshots,
    currentQualified: false,
    currentTradeDate: '2026-11-25',
    currentSectorRows: [{key: '电子', d1Pct: 1.2, advancersRatio: 0.8, positiveFlowRatio: 0.8}],
    marketAveragePct: 0.5
  });
  const sector = result.find(row => row.industry === '电子');
  assert.equal(sector.status, 'PARTIAL_ONE_DAY_INFLOW');
  assert.equal(sector.persistenceScore, null);
  assert.equal(sector.historySessions, 1);
});

test('one-click scan fails closed on partial universe and never emits buy eligibility', () => {
  const context = currentContext({fullMarket: false});
  context.aShare.volumePhaseRows = [{
    code: '600001', name: '样本股600001', industry: '电子', status: 'AVAILABLE',
    bars: flatBars(), phase: {status: 'AVAILABLE', classification: 'NEUTRAL', reasons: []}
  }];
  context.aShare.earlyTrendRows = [];
  context.aShare.earlyTrendDiagnostics = {status: 'AVAILABLE', requestedCount: 0, measurableCount: 0, coverage: 0};
  const result = buildV17OneClickSelection({
    context, snapshots: [], asOf: '2026-11-25T15:30:00+08:00'
  });
  assert.equal(result.decision, 'WAIT');
  assert.equal(result.universe.fullMarket, false);
  assert.equal(result.execution, 'SHADOW_NO_ORDERS');
  assert.ok(result.candidates.every(row => row.buyPlanEligible === false));
  assert.ok(result.candidates.every(row => row.state !== 'CONFIRMED'));
});

test('three-day stock flow is not scored without two prior qualified snapshots', () => {
  const context = currentContext({fullMarket: true});
  context.aShare.volumePhaseRows = [{
    code: '600001', name: '样本股600001', industry: '电子', status: 'AVAILABLE',
    bars: flatBars(), phase: {status: 'AVAILABLE', classification: 'NEUTRAL', reasons: []}
  }];
  context.aShare.earlyTrendRows = [];
  context.aShare.earlyTrendDiagnostics = {status: 'AVAILABLE', requestedCount: 0, measurableCount: 0, coverage: 0};
  const result = buildV17OneClickSelection({
    context, snapshots: [qualifiedSnapshot('2026-11-24', 1)], asOf: '2026-11-25T15:30:00+08:00'
  });
  assert.equal(result.archive.persistenceWindowAvailable, false);
  assert.equal(result.capabilities.threeSessionStockFlow, 'NOT_MEASURABLE');
  assert.ok(result.candidates.every(row => row.state !== 'CONFIRMED'));
  assert.ok(result.candidates.every(row => row.buyPlanEligible === false));
});


test('V16 snapshot archive retains V17 early-trend bars and diagnostics', () => {
  const context = currentContext({fullMarket: true});
  context.chinaCalendarDate = '2026-11-25';
  context.capturedAt = '2026-11-25T15:25:00+08:00';
  context.aShare.aShareSessionDate = '2026-11-25';
  context.aShare.dataStatus = 'FINALIZED_SESSION';
  context.aShare.breadth = {
    ...context.aShare.breadth, universe: 'full-market', fullMarket: true,
    coverage: 1, uniqueSymbols: 8, totalReported: 8
  };
  context.aShare.source = {
    complete: true, pagesFetched: 1, pageCount: 1,
    collectionStartedAt: '2026-11-25T15:00:00+08:00',
    collectionFinishedAt: '2026-11-25T15:20:00+08:00'
  };
  context.aShare.stockRows = industryRows().map(row => ({
    ...row, quoteAt: '2026-11-25T15:00:00+08:00'
  }));
  context.aShare.volumePhaseRows = [];
  context.aShare.volumePhaseDiagnostics = {status: 'NOT_MEASURABLE', coverage: 0};
  context.aShare.earlyTrendRows = [{
    code: '600001', status: 'AVAILABLE', bars: flatBars(),
    phase: {status: 'AVAILABLE', classification: 'NEUTRAL', reasons: []}
  }];
  context.aShare.earlyTrendDiagnostics = {
    status: 'AVAILABLE', requestedCount: 1, availableCount: 1,
    measurableCount: 1, coverage: 1
  };
  const snapshot = buildV16DailySnapshot(context, {minimumRows: 1});
  assert.equal(snapshot.quality.qualifiedForReplay, true);
  assert.equal(snapshot.quality.earlyTrendStatus, 'AVAILABLE');
  assert.equal(snapshot.quality.earlyTrendCoverage, 1);
  assert.equal(snapshot.earlyTrendRows.length, 1);
  assert.equal(snapshot.earlyTrendRows[0].code, '600001');
});


test('five-session industry persistence requires four qualified prior snapshots', () => {
  const snapshots = [
    qualifiedSnapshot('2026-11-19', 0),
    qualifiedSnapshot('2026-11-20', 1),
    qualifiedSnapshot('2026-11-23', 2),
    qualifiedSnapshot('2026-11-24', 3)
  ];
  const result = buildSectorFlowEvidence({
    currentRows: industryRows({net: 15000000, pct: 1.4, low: 9.9, day: 4}),
    priorSnapshots: snapshots,
    currentQualified: true,
    currentTradeDate: '2026-11-25',
    currentSectorRows: [{key: '电子', d1Pct: 1.4, advancersRatio: 0.8, positiveFlowRatio: 0.8}],
    marketAveragePct: 0.5
  });
  const sector = result.find(row => row.industry === '电子');
  assert.equal(sector.historySessions5, 5);
  assert.equal(sector.status5, 'REBOUND_CONFIRMED');
  assert.equal(sector.flowPositiveDays5, 5);
  assert.ok(sector.persistenceScore5 > 50);
});

test('a partial snapshot blocks the five-session industry claim but not a valid recent three-session window', () => {
  const snapshots = [
    {...qualifiedSnapshot('2026-11-19', 0), quality: {qualifiedForReplay: false}},
    qualifiedSnapshot('2026-11-20', 1),
    qualifiedSnapshot('2026-11-23', 2),
    qualifiedSnapshot('2026-11-24', 3)
  ];
  const result = buildSectorFlowEvidence({
    currentRows: industryRows({net: 15000000, pct: 1.4, low: 9.9, day: 4}),
    priorSnapshots: snapshots,
    currentQualified: true,
    currentTradeDate: '2026-11-25',
    currentSectorRows: [{key: '电子', d1Pct: 1.4, advancersRatio: 0.8, positiveFlowRatio: 0.8}],
    marketAveragePct: 0.5
  });
  const sector = result.find(row => row.industry === '电子');
  assert.equal(sector.status, 'REBOUND_CONFIRMED');
  assert.equal(sector.status5, 'INSUFFICIENT_HISTORY');
  assert.equal(sector.historySessions5, 0);
});


test('flow-price response distinguishes early absorption from weak price response', () => {
  const sessions = [0, 1, 2].map(day => ({
    tradeDate: ['2026-11-23', '2026-11-24', '2026-11-25'][day],
    stockRows: [stock('600001', {
      mainNet: 12000000, amount: 100000000,
      price: 10 + day * 0.08, low: 9.4 + day * 0.1, turn: 5
    })]
  }));
  const result = scoreCapitalFlowResponse({code: '600001', sessions, asOf: '2026-11-25'});
  assert.equal(result.status, 'AVAILABLE');
  assert.equal(result.stage, 'ABSORPTION');
  assert.equal(result.higherLows, true);
  assert.ok(result.score >= 80);

  sessions[2].stockRows[0].price = 9.5;
  const weak = scoreCapitalFlowResponse({code: '600001', sessions, asOf: '2026-11-25'});
  assert.equal(weak.stage, 'WEAK_PRICE_RESPONSE');
  assert.ok(weak.score < result.score);
});

test('daily entry timing rewards constructive pullbacks and penalizes acceleration', () => {
  const pullback = scoreEntryTiming({
    phase: {status: 'AVAILABLE', classification: 'CONSTRUCTIVE_PULLBACK', metrics: {deviation20Pct: 4}},
    trend: {phase: 'C', deviation20: 0.04}, currentPct: 1.2, currentTurn: 5
  });
  const acceleration = scoreEntryTiming({
    phase: {status: 'AVAILABLE', classification: 'ACCELERATION_RISK', metrics: {deviation20Pct: 12}},
    trend: {phase: 'E', deviation20: 0.12}, currentPct: 7.2, currentTurn: 18
  });
  assert.ok(pullback > 80);
  assert.ok(acceleration <= 15);
  assert.equal(scoreEntryTiming({phase: {status: 'NOT_MEASURABLE'}}), null);
});
