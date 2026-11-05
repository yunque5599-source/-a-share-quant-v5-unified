import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateMarketTransition} from '../research/v16/market_transition.js';
import {evaluateOvernightGlobalImpact} from '../research/v16/overnight_global_impact.js';
import {scoreSectorRotation, evaluateEntryTiming} from '../research/v16/sector_rotation.js';
import {buildV16DecisionOverlay} from '../research/v16/decision_overlay.js';
import {replayV16Snapshots, buildNov4Nov5ValidationReport} from '../research/v16/replay.js';

function session(date, mode = 'strong') {
  const strong = mode === 'strong';
  const weak = mode === 'weak';
  const breadthRatio = strong ? 0.76 : weak ? 0.18 : 0.22;
  const indexPct = strong ? 1.3 : weak ? -1.6 : 0.9;
  return {
    date,
    breadth: {upRatio: breadthRatio, universe: 'full-market', up: strong ? 4200 : weak ? 900 : 1200, down: strong ? 900 : weak ? 4100 : 3800},
    indices: [
      {name: 'SSE', changePct: indexPct, trend5Pct: strong ? 2 : weak ? -4 : 1, trend20Pct: strong ? 3 : weak ? -7 : 2, aboveMa5: strong || !weak, aboveMa10: strong, aboveMa20: strong},
      {name: 'ChiNext', changePct: indexPct + (strong ? 0.5 : weak ? -0.5 : 0.2), trend5Pct: strong ? 3 : weak ? -5 : 1.5, trend20Pct: strong ? 4 : weak ? -8 : 2, aboveMa5: strong || !weak, aboveMa10: strong, aboveMa20: strong},
      {name: 'STAR50', changePct: indexPct + (strong ? 0.8 : weak ? -0.8 : 0.4), trend5Pct: strong ? 4 : weak ? -6 : 2, trend20Pct: strong ? 5 : weak ? -9 : 3, aboveMa5: strong || !weak, aboveMa10: strong, aboveMa20: strong}
    ],
    turnover: {amountChangePct: strong ? 18 : weak ? -12 : 22},
    sentiment: {
      limitUpCount: strong ? 95 : weak ? 8 : 10,
      limitDownCount: strong ? 4 : weak ? 65 : 45,
      brokenBoardRate: strong ? 0.14 : weak ? 0.78 : 0.68,
      nextDayPremiumPct: strong ? 1.4 : weak ? -2.2 : -1.4,
      nextDayPositiveRatio: strong ? 0.72 : weak ? 0.18 : 0.25
    },
    sectors: {breadthRatio: strong ? 0.72 : weak ? 0.2 : 0.28, positiveFlowRatio: strong ? 0.75 : weak ? 0.2 : 0.25, topSectorRepeatDays: strong ? 3 : 0, leaderRelativeStrengthPct: strong ? 2.5 : weak ? -2 : -1.5, sourceScope: 'full-market'},
    leaders: [
      {relativeStrengthPct: strong ? 2 : weak ? -2 : -1, closeLocation: strong ? 0.82 : weak ? 0.18 : 0.25},
      {relativeStrengthPct: strong ? 1.5 : weak ? -2.5 : -1.2, closeLocation: strong ? 0.78 : weak ? 0.2 : 0.3},
      {relativeStrengthPct: strong ? 2.2 : weak ? -1.8 : -1.1, closeLocation: strong ? 0.8 : weak ? 0.15 : 0.25}
    ]
  };
}

test('market transition requires multi-session confirmation before BULL', () => {
  const oneDay = evaluateMarketTransition({sessions: [session('2026-11-04', 'strong')], asOf: '2026-11-04'});
  assert.equal(oneDay.regime, 'TRANSITION');
  assert.equal(oneDay.classification_status, 'INSUFFICIENT_CONFIRMATION');
  assert.equal(oneDay.trade_permission, 'WAIT_FOR_CONFIRMATION');
  assert.notEqual(oneDay.trade_permission, 'SELECTIVE');

  const confirmed = evaluateMarketTransition({
    sessions: [session('2026-11-04', 'strong'), session('2026-11-05', 'strong')],
    asOf: '2026-11-05'
  });
  assert.equal(confirmed.regime, 'BULL');
  assert.equal(confirmed.classification_status, 'CONFIRMED');
  assert.equal(confirmed.trade_permission, 'SELECTIVE');
});

test('one-day index/breadth divergence is a watch state, not confirmed distribution', () => {
  const row = session('2026-11-05', 'mixed');
  row.indices = row.indices.map(item => ({...item, changePct: 1.2, trend5Pct: 2.2, trend20Pct: 3, aboveMa5: true, aboveMa10: true, aboveMa20: true}));
  const result = evaluateMarketTransition({sessions: [row], asOf: '2026-11-05'});
  assert.equal(result.regime, 'TRANSITION');
  assert.equal(result.classification_status, 'DIVERGENCE_WATCH');
});

test('weak-to-strong improvement permits only a probe before BULL confirmation', () => {
  const result = evaluateMarketTransition({
    sessions: [session('2026-11-04', 'weak'), session('2026-11-05', 'strong')],
    asOf: '2026-11-05'
  });
  assert.equal(result.regime, 'TRANSITION');
  assert.equal(result.trade_permission, 'PROBE_ONLY');
  assert.ok(result.market_transition_score >= 55);
  assert.ok(result.improving_component_count >= 2);
});

test('two weak full-market sessions classify BEAR and restrict new risk', () => {
  const result = evaluateMarketTransition({
    sessions: [session('2026-11-04', 'weak'), session('2026-11-05', 'weak')],
    asOf: '2026-11-05'
  });
  assert.equal(result.regime, 'BEAR');
  assert.equal(result.trade_permission, 'NO_NEW_RISK');
  assert.ok(result.recommended_position_range_pct[1] <= 15);
});

test('index strength with very weak breadth identifies DISTRIBUTION divergence', () => {
  const first = session('2026-11-03', 'strong');
  const second = session('2026-11-04', 'strong');
  const third = session('2026-11-05', 'mixed');
  third.indices = third.indices.map(row => ({...row, changePct: 1.2, trend5Pct: 2.2, trend20Pct: 3, aboveMa5: true, aboveMa10: true, aboveMa20: true}));
  third.turnover.amountChangePct = 25;
  const result = evaluateMarketTransition({sessions: [first, second, third], asOf: '2026-11-05'});
  assert.equal(result.regime, 'DISTRIBUTION');
  assert.equal(result.trade_permission, 'REDUCE_RISK');
});

test('candidate-pool breadth is explicitly downgraded versus full-market breadth', () => {
  const full = session('2026-11-05', 'strong');
  const proxy = structuredClone(full);
  proxy.breadth.universe = 'candidate-pool';
  const fullResult = evaluateMarketTransition({sessions: [full], asOf: '2026-11-05'});
  const proxyResult = evaluateMarketTransition({sessions: [proxy], asOf: '2026-11-05'});
  assert.ok(proxyResult.confidence < fullResult.confidence);
  assert.ok(proxyResult.data_warnings.includes('breadth-is-not-full-market'));
});

test('approximate limit labels reduce sentiment confidence and are surfaced as warnings', () => {
  const row = session('2026-11-05', 'strong');
  row.sentiment.limitLabelQuality = 'APPROXIMATE_PROXY';
  const result = evaluateMarketTransition({sessions: [row], asOf: '2026-11-05'});
  assert.ok(result.data_warnings.includes('limit-up-down-counts-are-approximate-proxies'));
});

test('future sessions are excluded from point-in-time market classification', () => {
  const result = evaluateMarketTransition({
    sessions: [session('2026-11-04', 'weak'), session('2026-11-05', 'strong'), session('2026-11-06', 'strong')],
    asOf: '2026-11-05'
  });
  assert.equal(result.asOf, '2026-11-05');
  assert.equal(result.history.length, 2);
});

const usSplitMarket = {
  asOf: '2026-11-04',
  indices: {nasdaqCompositePct: -1.5, nasdaq100Pct: -1.7, soxPct: 1.8},
  etfs: {smhPct: 1.6, soxxPct: 1.4, qqqPct: -1.6},
  stocks: {NVDA: 2.1, AMD: 1.8, AVGO: 0.9, MU: 3.2, SNDK: 2.8, MSFT: -1.1, AMZN: -0.8, GOOGL: -0.6, META: -0.9}
};

test('overnight model separates semiconductor strength from mega-cap weakness', () => {
  const result = evaluateOvernightGlobalImpact({us: usSplitMarket});
  assert.ok(result.us_semiconductor_strength > 58);
  assert.ok(result.us_mega_cap_tech_strength < 50);
  assert.ok(result.industries.gpu_chip_design.overnight_impact_score > result.industries.ai_applications.overnight_impact_score);
  assert.notEqual(result.industries.memory_storage.overnight_impact_score, result.industries.liquid_cooling.overnight_impact_score);
});

test('missing US market data is UNCERTAIN and does not become neutral', () => {
  const result = evaluateOvernightGlobalImpact({us: {}});
  assert.equal(result.overnight_impact_score, null);
  assert.equal(result.overnight_impact_classification, 'UNCERTAIN');
  assert.equal(result.industries.gpu_chip_design.impact_classification, 'UNCERTAIN');
  assert.equal(result.policy_event_status, 'NOT_MEASURABLE');
});

test('only verified sourced policy events contribute to policy risk', () => {
  const result = evaluateOvernightGlobalImpact({
    us: {
      ...usSplitMarket,
      policyEvents: [
        {verified: true, sourceUrl: 'https://example.com/verified', severity: 0.8, direction: 'negative', sourceConfidence: 0.9},
        {verified: false, sourceUrl: 'https://example.com/unverified', severity: 1, direction: 'negative'}
      ]
    }
  });
  assert.ok(result.policy_event_risk > 0);
  assert.equal(result.verified_policy_event_count, 1);
});

test('negative overnight signal can be overridden by measured low-open absorption', () => {
  const negative = {
    asOf: '2026-11-04',
    indices: {nasdaqCompositePct: -2.1, nasdaq100Pct: -2.4, soxPct: -2.8},
    etfs: {smhPct: -2.7, soxxPct: -2.5, qqqPct: -2.2},
    stocks: {NVDA: -3, AMD: -2.8, AVGO: -2, MU: -3.2, SNDK: -3.5, MSFT: -1.8, AMZN: -1.6, GOOGL: -1.5, META: -1.7}
  };
  const open = {
    gpu_chip_design: {
      first15mComplete: true, auctionPct: -1.8, first15mReturnPct: 2.5,
      first15mVolumeRatio: 2.0, sectorAdvancersRatio: 0.90,
      leaderRelativeStrengthPct: 5.0, priceVsVwapPct: 2.5, gapRecoveryPct: 100
    }
  };
  const result = evaluateOvernightGlobalImpact({us: negative, aShareOpen: open});
  const industry = result.industries.gpu_chip_design;
  assert.equal(industry.impact_classification, 'POSITIVE');
  assert.equal(industry.a_share_open_signal, 'RELATIVE_STRENGTH_CONFIRMED');
  assert.ok(industry.low_open_absorption_score >= 65);
});

test('daily-only inputs cannot claim first-15-minute absorption', () => {
  const result = evaluateOvernightGlobalImpact({us: usSplitMarket});
  assert.equal(result.industries.gpu_chip_design.a_share_open_status, 'NOT_MEASURABLE');
  assert.equal(result.industries.gpu_chip_design.a_share_open_signal, 'NOT_MEASURABLE');
});

test('sector rotation distinguishes persistence, acceleration and profit-taking risk', () => {
  const previous = [{key: 'battery', rankToday: 12, advancersRatio: 0.42, positiveFlowRatio: 0.4, leaderRelativeStrengthPct: -0.8}];
  const current = [{key: 'battery', label: '电池', rankToday: 2, d1Pct: 3.5, d3Pct: 6, d5Pct: 8, advancersRatio: 0.82, positiveFlowRatio: 0.78, leaderRelativeStrengthPct: 2.8, topSectorRepeatDays: 3, previousDayReturnPct: 1}];
  const result = scoreSectorRotation({sectors: current, previousSectors: previous, market: {d1Pct: 0.5}});
  const row = result.sectors[0];
  assert.ok(row.sector_persistence_score > 65);
  assert.ok(row.sector_rotation_acceleration_score > 65);
  assert.ok(row.opportunity_score > 60);
  assert.equal(row.previous_snapshot_available, true);
});

test('yesterday surge and today reversal raise profit-taking risk', () => {
  const result = scoreSectorRotation({
    sectors: [{key: 'solar', rankToday: 1, d1Pct: -1.8, d3Pct: 7, d5Pct: 10, advancersRatio: 0.35, positiveFlowRatio: 0.3, previousDayReturnPct: 8, brokenBoardRate: 0.7, nearLimitUpCount: 10}],
    previousSectors: [{key: 'solar', rankToday: 2, advancersRatio: 0.7, positiveFlowRatio: 0.65}],
    market: {d1Pct: -0.2}
  });
  assert.ok(result.sectors[0].profit_taking_risk_score >= 50);
});

test('entry timing is separate from sector opportunity and requires pullback confirmation', () => {
  const sector = scoreSectorRotation({
    sectors: [{key: 'battery', rankToday: 1, d1Pct: 4, d3Pct: 8, d5Pct: 12, advancersRatio: 0.8, positiveFlowRatio: 0.8, leaderRelativeStrengthPct: 3, topSectorRepeatDays: 3}],
    market: {d1Pct: 0.5}
  });
  const entry = evaluateEntryTiming({
    price: 10, ma5: 10, atrPct: 3, dayPct: 1, closeLocation: 0.8,
    priceVsVwapPct: 0.5, flow3: 1, flow5: 2, pullbackTouched: true, reclaimedMa5: true
  });
  assert.ok(sector.sectors[0].opportunity_score > 60);
  assert.equal(entry.pass, true);
  const chase = evaluateEntryTiming({
    price: 10.6, ma5: 10, atrPct: 3, dayPct: 8, closeLocation: 0.8,
    priceVsVwapPct: 0.5, flow3: 1, flow5: 2, pullbackTouched: false, reclaimedMa5: true
  });
  assert.equal(chase.pass, false);
});

test('missing entry timing data is NOT_MEASURABLE rather than an implicit pass', () => {
  const result = evaluateEntryTiming({price: 10, ma5: 10});
  assert.equal(result.status, 'NOT_MEASURABLE');
  assert.equal(result.pass, false);
});

function marketState(regime = 'BULL', permission = null) {
  const defaultPermission = {BULL:'SELECTIVE',TRANSITION:'PROBE_ONLY',BEAR:'NO_NEW_RISK',DISTRIBUTION:'REDUCE_RISK'}[regime];
  return {regime, trade_permission: permission ?? defaultPermission, confidence: 82, data_warnings: [], recommended_position_range_pct: regime === 'BULL' ? [35, 65] : [10, 35]};
}
function sectorResult(score = 82) {
  return {sectors: [{key: 'gpu_chip_design', label: 'GPU及芯片设计', opportunity_score: score}]};
}
function overnightResult(classification = 'POSITIVE', score = 72, mappingConfidence = 85, openSignal = 'NOT_MEASURABLE') {
  return {industries: {gpu_chip_design: {
    overnight_impact_score: score, adjusted_impact_score: score,
    impact_classification: classification, industry_mapping_confidence: mappingConfidence,
    a_share_open_signal: openSignal, a_share_open_status: 'NOT_MEASURABLE'
  }}};
}
function candidate(entryPass = true) {
  return {code: '688001', name: '样本', industryKey: 'gpu_chip_design', score: 85,
    entryTiming: {pass: entryPass, entry_timing_score: entryPass ? 88 : 40}};
}

test('BULL market with strong sector and confirmed entry allows selective entry only', () => {
  const result = buildV16DecisionOverlay({
    market: marketState('BULL'), sectorRotation: sectorResult(), overnight: overnightResult(), candidate: candidate(true)
  });
  assert.equal(result.decision, 'SELECTIVE_ENTRY');
  assert.equal(result.buy_permission, true);
  assert.equal(result.execution, 'NO_ORDER_PLACEMENT');
});

test('transition state with insufficient confirmation cannot bypass the market gate', () => {
  const result = buildV16DecisionOverlay({
    market: marketState('TRANSITION', 'WAIT_FOR_CONFIRMATION'),
    sectorRotation: sectorResult(), overnight: overnightResult(), candidate: candidate(true)
  });
  assert.equal(result.decision, 'WAIT_FOR_MARKET_CONFIRMATION');
  assert.equal(result.buy_permission, false);
});

test('TRANSITION market limits permission to a small probe', () => {
  const result = buildV16DecisionOverlay({
    market: marketState('TRANSITION'), sectorRotation: sectorResult(), overnight: overnightResult(), candidate: candidate(true)
  });
  assert.equal(result.decision, 'PROBE_ONLY');
  assert.equal(result.single_position_cap_pct, 8);
});

test('BEAR market blocks new entry even when stock score is high', () => {
  const result = buildV16DecisionOverlay({
    market: marketState('BEAR'), sectorRotation: sectorResult(), overnight: overnightResult(), candidate: candidate(true)
  });
  assert.equal(result.decision, 'NO_NEW_RISK');
  assert.equal(result.buy_permission, false);
});

test('strongly negative overseas impact blocks entry unless A-share relative strength is confirmed', () => {
  const blocked = buildV16DecisionOverlay({
    market: marketState('BULL'), sectorRotation: sectorResult(),
    overnight: overnightResult('NEGATIVE', 25, 90), candidate: candidate(true)
  });
  assert.equal(blocked.decision, 'WAIT_FOR_OVERSEAS_RISK');
  const offset = buildV16DecisionOverlay({
    market: marketState('BULL'), sectorRotation: sectorResult(),
    overnight: overnightResult('NEGATIVE', 25, 90, 'RELATIVE_STRENGTH_CONFIRMED'), candidate: candidate(true)
  });
  assert.equal(offset.decision, 'SELECTIVE_ENTRY');
});

test('high opportunity score cannot bypass an unconfirmed entry timing gate', () => {
  const result = buildV16DecisionOverlay({
    market: marketState('BULL'), sectorRotation: sectorResult(), overnight: overnightResult(), candidate: candidate(false)
  });
  assert.equal(result.opportunity_score > 70, true);
  assert.equal(result.entry_timing_pass, false);
  assert.equal(result.buy_permission, false);
  assert.equal(result.decision, 'WAIT_FOR_ENTRY');
});

function replaySnapshot(date, breadthScope = 'full-market') {
  const row = session(date, 'strong');
  row.breadth.universe = breadthScope;
  return {
    tradeDate: date,
    capturedAt: date + 'T15:05:00+08:00',
    market: row,
    marketSummary: {d1Pct: 1.1},
    us: usSplitMarket,
    sectors: [{key: 'semiconductor', rankToday: 1, d1Pct: 2, d3Pct: 4, d5Pct: 5, advancersRatio: 0.7, positiveFlowRatio: 0.7, leaderRelativeStrengthPct: 2, topSectorRepeatDays: 2}]
  };
}

test('replay excludes snapshots captured after the requested as-of date', () => {
  const result = replayV16Snapshots({
    snapshots: [replaySnapshot('2026-11-04'), replaySnapshot('2026-11-05'), replaySnapshot('2026-11-06')],
    asOf: '2026-11-05'
  });
  assert.equal(result.replayedSnapshotCount, 2);
  assert.equal(result.excludedFutureSnapshotCount, 1);
  assert.equal(result.reports.at(-1).tradeDate, '2026-11-05');
});

test('Nov 4–5 validation refuses to fabricate missing point-in-time snapshots', () => {
  const result = buildNov4Nov5ValidationReport({snapshots: [replaySnapshot('2026-11-05')]});
  assert.equal(result.status, 'NOT_MEASURABLE');
  assert.deepEqual(result.missingPointInTimeSnapshotDates, ['2026-11-04']);
});

test('candidate-pool and missing intraday data are labelled partial and NOT_MEASURABLE', () => {
  const result = replayV16Snapshots({snapshots: [replaySnapshot('2026-11-05', 'candidate-pool')], asOf: '2026-11-05'});
  const report = result.reports[0];
  assert.equal(report.capabilities.fullMarketBreadth, 'NOT_MEASURABLE');
  assert.equal(report.capabilities.aShareOpen, 'NOT_MEASURABLE');
  assert.equal(report.status, 'PARTIAL');
});

  const result = evaluateMarketTransition({
    sessions: [session('2026-11-04', 'weak'), session('2026-11-05', 'weak')],
    asOf: '2026-11-05'
  });
  assert.equal(result.regime, 'BEAR');
  assert.equal(result.trade_permission, 'NO_NEW_RISK');
  assert.ok(result.recommended_position_range_pct[1] <= 15);
});

test('index strength with very weak breadth identifies DISTRIBUTION divergence', () => {
  const first = session('2026-11-03', 'strong');
  const second = session('2026-11-04', 'strong');
  const third = session('2026-11-05', 'mixed');
  third.indices = third.indices.map(row => ({...row, changePct: 1.2, trend5Pct: 2.2, trend20Pct: 3, aboveMa5: true, aboveMa10: true, aboveMa20: true}));
  third.turnover.amountChangePct = 25;
  const result = evaluateMarketTransition({sessions: [first, second, third], asOf: '2026-11-05'});
  assert.equal(result.regime, 'DISTRIBUTION');
  assert.equal(result.trade_permission, 'REDUCE_RISK');
});

test('candidate-pool breadth is explicitly downgraded versus full-market breadth', () => {
  const full = session('2026-11-05', 'strong');
  const proxy = structuredClone(full);
  proxy.breadth.universe = 'candidate-pool';
  const fullResult = evaluateMarketTransition({sessions: [full], asOf: '2026-11-05'});
  const proxyResult = evaluateMarketTransition({sessions: [proxy], asOf: '2026-11-05'});
  assert.ok(proxyResult.confidence < fullResult.confidence);
  assert.ok(proxyResult.data_warnings.includes('breadth-is-not-full-market'));
});

test('approximate limit labels reduce sentiment confidence and are surfaced as warnings', () => {
  const row = session('2026-11-05', 'strong');
  row.sentiment.limitLabelQuality = 'APPROXIMATE_PROXY';
  const result = evaluateMarketTransition({sessions: [row], asOf: '2026-11-05'});
  assert.ok(result.data_warnings.includes('limit-up-down-counts-are-approximate-proxies'));
});

test('future sessions are excluded from point-in-time market classification', () => {
  const result = evaluateMarketTransition({
    sessions: [session('2026-11-04', 'weak'), session('2026-11-05', 'strong'), session('2026-11-06', 'strong')],
    asOf: '2026-11-05'
  });
  assert.equal(result.asOf, '2026-11-05');
  assert.equal(result.history.length, 2);
});

const usSplitMarket = {
  asOf: '2026-11-04',
  indices: {nasdaqCompositePct: -1.5, nasdaq100Pct: -1.7, soxPct: 1.8},
  etfs: {smhPct: 1.6, soxxPct: 1.4, qqqPct: -1.6},
  stocks: {NVDA: 2.1, AMD: 1.8, AVGO: 0.9, MU: 3.2, SNDK: 2.8, MSFT: -1.1, AMZN: -0.8, GOOGL: -0.6, META: -0.9}
};

test('overnight model separates semiconductor strength from mega-cap weakness', () => {
  const result = evaluateOvernightGlobalImpact({us: usSplitMarket});
  assert.ok(result.us_semiconductor_strength > 58);
  assert.ok(result.us_mega_cap_tech_strength < 50);
  assert.ok(result.industries.gpu_chip_design.overnight_impact_score > result.industries.ai_applications.overnight_impact_score);
  assert.notEqual(result.industries.memory_storage.overnight_impact_score, result.industries.liquid_cooling.overnight_impact_score);
});

test('missing US market data is UNCERTAIN and does not become neutral', () => {
  const result = evaluateOvernightGlobalImpact({us: {}});
  assert.equal(result.overnight_impact_score, null);
  assert.equal(result.overnight_impact_classification, 'UNCERTAIN');
  assert.equal(result.industries.gpu_chip_design.impact_classification, 'UNCERTAIN');
  assert.equal(result.policy_event_status, 'NOT_MEASURABLE');
});

test('only verified sourced policy events contribute to policy risk', () => {
  const result = evaluateOvernightGlobalImpact({
    us: {
      ...usSplitMarket,
      policyEvents: [
        {verified: true, sourceUrl: 'https://example.com/verified', severity: 0.8, direction: 'negative', sourceConfidence: 0.9},
        {verified: false, sourceUrl: 'https://example.com/unverified', severity: 1, direction: 'negative'}
      ]
    }
  });
  assert.ok(result.policy_event_risk > 0);
  assert.equal(result.verified_policy_event_count, 1);
});

test('negative overnight signal can be overridden by measured low-open absorption', () => {
  const negative = {
    asOf: '2026-11-04',
    indices: {nasdaqCompositePct: -2.1, nasdaq100Pct: -2.4, soxPct: -2.8},
    etfs: {smhPct: -2.7, soxxPct: -2.5, qqqPct: -2.2},
    stocks: {NVDA: -3, AMD: -2.8, AVGO: -2, MU: -3.2, SNDK: -3.5, MSFT: -1.8, AMZN: -1.6, GOOGL: -1.5, META: -1.7}
  };
  const open = {
    gpu_chip_design: {
      first15mComplete: true, auctionPct: -1.8, first15mReturnPct: 2.5,
      first15mVolumeRatio: 2.0, sectorAdvancersRatio: 0.90,
      leaderRelativeStrengthPct: 5.0, priceVsVwapPct: 2.5, gapRecoveryPct: 100
    }
  };
  const result = evaluateOvernightGlobalImpact({us: negative, aShareOpen: open});
  const industry = result.industries.gpu_chip_design;
  assert.equal(industry.impact_classification, 'POSITIVE');
  assert.equal(industry.a_share_open_signal, 'RELATIVE_STRENGTH_CONFIRMED');
  assert.ok(industry.low_open_absorption_score >= 65);
});

test('daily-only inputs cannot claim first-15-minute absorption', () => {
  const result = evaluateOvernightGlobalImpact({us: usSplitMarket});
  assert.equal(result.industries.gpu_chip_design.a_share_open_status, 'NOT_MEASURABLE');
  assert.equal(result.industries.gpu_chip_design.a_share_open_signal, 'NOT_MEASURABLE');
});

test('sector rotation distinguishes persistence, acceleration and profit-taking risk', () => {
  const previous = [{key: 'battery', rankToday: 12, advancersRatio: 0.42, positiveFlowRatio: 0.4, leaderRelativeStrengthPct: -0.8}];
  const current = [{key: 'battery', label: '电池', rankToday: 2, d1Pct: 3.5, d3Pct: 6, d5Pct: 8, advancersRatio: 0.82, positiveFlowRatio: 0.78, leaderRelativeStrengthPct: 2.8, topSectorRepeatDays: 3, previousDayReturnPct: 1}];
  const result = scoreSectorRotation({sectors: current, previousSectors: previous, market: {d1Pct: 0.5}});
  const row = result.sectors[0];
  assert.ok(row.sector_persistence_score > 65);
  assert.ok(row.sector_rotation_acceleration_score > 65);
  assert.ok(row.opportunity_score > 60);
  assert.equal(row.previous_snapshot_available, true);
});

test('yesterday surge and today reversal raise profit-taking risk', () => {
  const result = scoreSectorRotation({
    sectors: [{key: 'solar', rankToday: 1, d1Pct: -1.8, d3Pct: 7, d5Pct: 10, advancersRatio: 0.35, positiveFlowRatio: 0.3, previousDayReturnPct: 8, brokenBoardRate: 0.7, nearLimitUpCount: 10}],
    previousSectors: [{key: 'solar', rankToday: 2, advancersRatio: 0.7, positiveFlowRatio: 0.65}],
    market: {d1Pct: -0.2}
  });
  assert.ok(result.sectors[0].profit_taking_risk_score >= 50);
});

test('entry timing is separate from sector opportunity and requires pullback confirmation', () => {
  const sector = scoreSectorRotation({
    sectors: [{key: 'battery', rankToday: 1, d1Pct: 4, d3Pct: 8, d5Pct: 12, advancersRatio: 0.8, positiveFlowRatio: 0.8, leaderRelativeStrengthPct: 3, topSectorRepeatDays: 3}],
    market: {d1Pct: 0.5}
  });
  const entry = evaluateEntryTiming({
    price: 10, ma5: 10, atrPct: 3, dayPct: 1, closeLocation: 0.8,
    priceVsVwapPct: 0.5, flow3: 1, flow5: 2, pullbackTouched: true, reclaimedMa5: true
  });
  assert.ok(sector.sectors[0].opportunity_score > 60);
  assert.equal(entry.pass, true);
  const chase = evaluateEntryTiming({
    price: 10.6, ma5: 10, atrPct: 3, dayPct: 8, closeLocation: 0.8,
    priceVsVwapPct: 0.5, flow3: 1, flow5: 2, pullbackTouched: false, reclaimedMa5: true
  });
  assert.equal(chase.pass, false);
});

test('missing entry timing data is NOT_MEASURABLE rather than an implicit pass', () => {
  const result = evaluateEntryTiming({price: 10, ma5: 10});
  assert.equal(result.status, 'NOT_MEASURABLE');
  assert.equal(result.pass, false);
});

function marketState(regime = 'BULL') {
  return {regime, confidence: 82, data_warnings: [], recommended_position_range_pct: regime === 'BULL' ? [35, 65] : [10, 35]};
}
function sectorResult(score = 82) {
  return {sectors: [{key: 'gpu_chip_design', label: 'GPU及芯片设计', opportunity_score: score}]};
}
function overnightResult(classification = 'POSITIVE', score = 72, mappingConfidence = 85, openSignal = 'NOT_MEASURABLE') {
  return {industries: {gpu_chip_design: {
    overnight_impact_score: score, adjusted_impact_score: score,
    impact_classification: classification, industry_mapping_confidence: mappingConfidence,
    a_share_open_signal: openSignal, a_share_open_status: 'NOT_MEASURABLE'
  }}};
}
function candidate(entryPass = true) {
  return {code: '688001', name: '样本', industryKey: 'gpu_chip_design', score: 85,
    entryTiming: {pass: entryPass, entry_timing_score: entryPass ? 88 : 40}};
}

test('BULL market with strong sector and confirmed entry allows selective entry only', () => {
  const result = buildV16DecisionOverlay({
    market: marketState('BULL'), sectorRotation: sectorResult(), overnight: overnightResult(), candidate: candidate(true)
  });
  assert.equal(result.decision, 'SELECTIVE_ENTRY');
  assert.equal(result.buy_permission, true);
  assert.equal(result.execution, 'NO_ORDER_PLACEMENT');
});

test('TRANSITION market limits permission to a small probe', () => {
  const result = buildV16DecisionOverlay({
    market: marketState('TRANSITION'), sectorRotation: sectorResult(), overnight: overnightResult(), candidate: candidate(true)
  });
  assert.equal(result.decision, 'PROBE_ONLY');
  assert.equal(result.single_position_cap_pct, 8);
});

test('BEAR market blocks new entry even when stock score is high', () => {
  const result = buildV16DecisionOverlay({
    market: marketState('BEAR'), sectorRotation: sectorResult(), overnight: overnightResult(), candidate: candidate(true)
  });
  assert.equal(result.decision, 'NO_NEW_RISK');
  assert.equal(result.buy_permission, false);
});

test('strongly negative overseas impact blocks entry unless A-share relative strength is confirmed', () => {
  const blocked = buildV16DecisionOverlay({
    market: marketState('BULL'), sectorRotation: sectorResult(),
    overnight: overnightResult('NEGATIVE', 25, 90), candidate: candidate(true)
  });
  assert.equal(blocked.decision, 'WAIT_FOR_OVERSEAS_RISK');
  const offset = buildV16DecisionOverlay({
    market: marketState('BULL'), sectorRotation: sectorResult(),
    overnight: overnightResult('NEGATIVE', 25, 90, 'RELATIVE_STRENGTH_CONFIRMED'), candidate: candidate(true)
  });
  assert.equal(offset.decision, 'SELECTIVE_ENTRY');
});

test('high opportunity score cannot bypass an unconfirmed entry timing gate', () => {
  const result = buildV16DecisionOverlay({
    market: marketState('BULL'), sectorRotation: sectorResult(), overnight: overnightResult(), candidate: candidate(false)
  });
  assert.equal(result.opportunity_score > 70, true);
  assert.equal(result.entry_timing_pass, false);
  assert.equal(result.buy_permission, false);
  assert.equal(result.decision, 'WAIT_FOR_ENTRY');
});

function replaySnapshot(date, breadthScope = 'full-market') {
  const row = session(date, 'strong');
  row.breadth.universe = breadthScope;
  return {
    tradeDate: date,
    capturedAt: date + 'T15:05:00+08:00',
    market: row,
    marketSummary: {d1Pct: 1.1},
    us: usSplitMarket,
    sectors: [{key: 'semiconductor', rankToday: 1, d1Pct: 2, d3Pct: 4, d5Pct: 5, advancersRatio: 0.7, positiveFlowRatio: 0.7, leaderRelativeStrengthPct: 2, topSectorRepeatDays: 2}]
  };
}

test('replay excludes snapshots captured after the requested as-of date', () => {
  const result = replayV16Snapshots({
    snapshots: [replaySnapshot('2026-11-04'), replaySnapshot('2026-11-05'), replaySnapshot('2026-11-06')],
    asOf: '2026-11-05'
  });
  assert.equal(result.replayedSnapshotCount, 2);
  assert.equal(result.excludedFutureSnapshotCount, 1);
  assert.equal(result.reports.at(-1).tradeDate, '2026-11-05');
});

test('Nov 4–5 validation refuses to fabricate missing point-in-time snapshots', () => {
  const result = buildNov4Nov5ValidationReport({snapshots: [replaySnapshot('2026-11-05')]});
  assert.equal(result.status, 'NOT_MEASURABLE');
  assert.deepEqual(result.missingPointInTimeSnapshotDates, ['2026-11-04']);
});

test('candidate-pool and missing intraday data are labelled partial and NOT_MEASURABLE', () => {
  const result = replayV16Snapshots({snapshots: [replaySnapshot('2026-11-05', 'candidate-pool')], asOf: '2026-11-05'});
  const report = result.reports[0];
  assert.equal(report.capabilities.fullMarketBreadth, 'NOT_MEASURABLE');
  assert.equal(report.capabilities.aShareOpen, 'NOT_MEASURABLE');
  assert.equal(report.status, 'PARTIAL');
});

  const result = buildV16DecisionOverlay({
    market: marketState('TRANSITION'), sectorRotation: sectorResult(), overnight: overnightResult(), candidate: candidate(true)
  });
  assert.equal(result.decision, 'PROBE_ONLY');
  assert.equal(result.single_position_cap_pct, 8);
});

test('BEAR market blocks new entry even when stock score is high', () => {
  const result = buildV16DecisionOverlay({
    market: marketState('BEAR'), sectorRotation: sectorResult(), overnight: overnightResult(), candidate: candidate(true)
  });
  assert.equal(result.decision, 'NO_NEW_RISK');
  assert.equal(result.buy_permission, false);
});

test('strongly negative overseas impact blocks entry unless A-share relative strength is confirmed', () => {
  const blocked = buildV16DecisionOverlay({
    market: marketState('BULL'), sectorRotation: sectorResult(),
    overnight: overnightResult('NEGATIVE', 25, 90), candidate: candidate(true)
  });
  assert.equal(blocked.decision, 'WAIT_FOR_OVERSEAS_RISK');
  const offset = buildV16DecisionOverlay({
    market: marketState('BULL'), sectorRotation: sectorResult(),
    overnight: overnightResult('NEGATIVE', 25, 90, 'RELATIVE_STRENGTH_CONFIRMED'), candidate: candidate(true)
  });
  assert.equal(offset.decision, 'SELECTIVE_ENTRY');
});

test('high opportunity score cannot bypass an unconfirmed entry timing gate', () => {
  const result = buildV16DecisionOverlay({
    market: marketState('BULL'), sectorRotation: sectorResult(), overnight: overnightResult(), candidate: candidate(false)
  });
  assert.equal(result.opportunity_score > 70, true);
  assert.equal(result.entry_timing_pass, false);
  assert.equal(result.buy_permission, false);
  assert.equal(result.decision, 'WAIT_FOR_ENTRY');
});

function replaySnapshot(date, breadthScope = 'full-market') {
  const row = session(date, 'strong');
  row.breadth.universe = breadthScope;
  return {
    tradeDate: date,
    capturedAt: date + 'T15:05:00+08:00',
    market: row,
    marketSummary: {d1Pct: 1.1},
    us: usSplitMarket,
    sectors: [{key: 'semiconductor', rankToday: 1, d1Pct: 2, d3Pct: 4, d5Pct: 5, advancersRatio: 0.7, positiveFlowRatio: 0.7, leaderRelativeStrengthPct: 2, topSectorRepeatDays: 2}]
  };
}

test('replay excludes snapshots captured after the requested as-of date', () => {
  const result = replayV16Snapshots({
    snapshots: [replaySnapshot('2026-11-04'), replaySnapshot('2026-11-05'), replaySnapshot('2026-11-06')],
    asOf: '2026-11-05'
  });
  assert.equal(result.replayedSnapshotCount, 2);
  assert.equal(result.excludedFutureSnapshotCount, 1);
  assert.equal(result.reports.at(-1).tradeDate, '2026-11-05');
});

test('Nov 4–5 validation refuses to fabricate missing point-in-time snapshots', () => {
  const result = buildNov4Nov5ValidationReport({snapshots: [replaySnapshot('2026-11-05')]});
  assert.equal(result.status, 'NOT_MEASURABLE');
  assert.deepEqual(result.missingPointInTimeSnapshotDates, ['2026-11-04']);
});

test('candidate-pool and missing intraday data are labelled partial and NOT_MEASURABLE', () => {
  const result = replayV16Snapshots({snapshots: [replaySnapshot('2026-11-05', 'candidate-pool')], asOf: '2026-11-05'});
  const report = result.reports[0];
  assert.equal(report.capabilities.fullMarketBreadth, 'NOT_MEASURABLE');
  assert.equal(report.capabilities.aShareOpen, 'NOT_MEASURABLE');
  assert.equal(report.status, 'PARTIAL');
});

  const result = evaluateMarketTransition({
    sessions: [session('2026-11-04', 'weak'), session('2026-11-05', 'weak')],
    asOf: '2026-11-05'
  });
  assert.equal(result.regime, 'BEAR');
  assert.equal(result.trade_permission, 'NO_NEW_RISK');
  assert.ok(result.recommended_position_range_pct[1] <= 15);
});

test('index strength with very weak breadth identifies DISTRIBUTION divergence', () => {
  const first = session('2026-11-03', 'strong');
  const second = session('2026-11-04', 'strong');
  const third = session('2026-11-05', 'mixed');
  third.indices = third.indices.map(row => ({...row, changePct: 1.2, trend5Pct: 2.2, trend20Pct: 3, aboveMa5: true, aboveMa10: true, aboveMa20: true}));
  third.turnover.amountChangePct = 25;
  const result = evaluateMarketTransition({sessions: [first, second, third], asOf: '2026-11-05'});
  assert.equal(result.regime, 'DISTRIBUTION');
  assert.equal(result.trade_permission, 'REDUCE_RISK');
});

test('candidate-pool breadth is explicitly downgraded versus full-market breadth', () => {
  const full = session('2026-11-05', 'strong');
  const proxy = structuredClone(full);
  proxy.breadth.universe = 'candidate-pool';
  const fullResult = evaluateMarketTransition({sessions: [full], asOf: '2026-11-05'});
  const proxyResult = evaluateMarketTransition({sessions: [proxy], asOf: '2026-11-05'});
  assert.ok(proxyResult.confidence < fullResult.confidence);
  assert.ok(proxyResult.data_warnings.includes('breadth-is-not-full-market'));
});

test('approximate limit labels reduce sentiment confidence and are surfaced as warnings', () => {
  const row = session('2026-11-05', 'strong');
  row.sentiment.limitLabelQuality = 'APPROXIMATE_PROXY';
  const result = evaluateMarketTransition({sessions: [row], asOf: '2026-11-05'});
  assert.ok(result.data_warnings.includes('limit-up-down-counts-are-approximate-proxies'));
});

test('future sessions are excluded from point-in-time market classification', () => {
  const result = evaluateMarketTransition({
    sessions: [session('2026-11-04', 'weak'), session('2026-11-05', 'strong'), session('2026-11-06', 'strong')],
    asOf: '2026-11-05'
  });
  assert.equal(result.asOf, '2026-11-05');
  assert.equal(result.history.length, 2);
});

const usSplitMarket = {
  asOf: '2026-11-04',
  indices: {nasdaqCompositePct: -1.5, nasdaq100Pct: -1.7, soxPct: 1.8},
  etfs: {smhPct: 1.6, soxxPct: 1.4, qqqPct: -1.6},
  stocks: {NVDA: 2.1, AMD: 1.8, AVGO: 0.9, MU: 3.2, SNDK: 2.8, MSFT: -1.1, AMZN: -0.8, GOOGL: -0.6, META: -0.9}
};

test('overnight model separates semiconductor strength from mega-cap weakness', () => {
  const result = evaluateOvernightGlobalImpact({us: usSplitMarket});
  assert.ok(result.us_semiconductor_strength > 58);
  assert.ok(result.us_mega_cap_tech_strength < 50);
  assert.ok(result.industries.gpu_chip_design.overnight_impact_score > result.industries.ai_applications.overnight_impact_score);
  assert.notEqual(result.industries.memory_storage.overnight_impact_score, result.industries.liquid_cooling.overnight_impact_score);
});

test('missing US market data is UNCERTAIN and does not become neutral', () => {
  const result = evaluateOvernightGlobalImpact({us: {}});
  assert.equal(result.overnight_impact_score, null);
  assert.equal(result.overnight_impact_classification, 'UNCERTAIN');
  assert.equal(result.industries.gpu_chip_design.impact_classification, 'UNCERTAIN');
  assert.equal(result.policy_event_status, 'NOT_MEASURABLE');
});

test('only verified sourced policy events contribute to policy risk', () => {
  const result = evaluateOvernightGlobalImpact({
    us: {
      ...usSplitMarket,
      policyEvents: [
        {verified: true, sourceUrl: 'https://example.com/verified', severity: 0.8, direction: 'negative', sourceConfidence: 0.9},
        {verified: false, sourceUrl: 'https://example.com/unverified', severity: 1, direction: 'negative'}
      ]
    }
  });
  assert.ok(result.policy_event_risk > 0);
  assert.equal(result.verified_policy_event_count, 1);
});

test('negative overnight signal can be overridden by measured low-open absorption', () => {
  const negative = {
    asOf: '2026-11-04',
    indices: {nasdaqCompositePct: -2.1, nasdaq100Pct: -2.4, soxPct: -2.8},
    etfs: {smhPct: -2.7, soxxPct: -2.5, qqqPct: -2.2},
    stocks: {NVDA: -3, AMD: -2.8, AVGO: -2, MU: -3.2, SNDK: -3.5, MSFT: -1.8, AMZN: -1.6, GOOGL: -1.5, META: -1.7}
  };
  const open = {
    gpu_chip_design: {
      first15mComplete: true, auctionPct: -1.8, first15mReturnPct: 2.5,
      first15mVolumeRatio: 2.0, sectorAdvancersRatio: 0.90,
      leaderRelativeStrengthPct: 5.0, priceVsVwapPct: 2.5, gapRecoveryPct: 100
    }
  };
  const result = evaluateOvernightGlobalImpact({us: negative, aShareOpen: open});
  const industry = result.industries.gpu_chip_design;
  assert.equal(industry.impact_classification, 'POSITIVE');
  assert.equal(industry.a_share_open_signal, 'RELATIVE_STRENGTH_CONFIRMED');
  assert.ok(industry.low_open_absorption_score >= 65);
});

test('daily-only inputs cannot claim first-15-minute absorption', () => {
  const result = evaluateOvernightGlobalImpact({us: usSplitMarket});
  assert.equal(result.industries.gpu_chip_design.a_share_open_status, 'NOT_MEASURABLE');
  assert.equal(result.industries.gpu_chip_design.a_share_open_signal, 'NOT_MEASURABLE');
});

test('sector rotation distinguishes persistence, acceleration and profit-taking risk', () => {
  const previous = [{key: 'battery', rankToday: 12, advancersRatio: 0.42, positiveFlowRatio: 0.4, leaderRelativeStrengthPct: -0.8}];
  const current = [{key: 'battery', label: '电池', rankToday: 2, d1Pct: 3.5, d3Pct: 6, d5Pct: 8, advancersRatio: 0.82, positiveFlowRatio: 0.78, leaderRelativeStrengthPct: 2.8, topSectorRepeatDays: 3, previousDayReturnPct: 1}];
  const result = scoreSectorRotation({sectors: current, previousSectors: previous, market: {d1Pct: 0.5}});
  const row = result.sectors[0];
  assert.ok(row.sector_persistence_score > 65);
  assert.ok(row.sector_rotation_acceleration_score > 65);
  assert.ok(row.opportunity_score > 60);
  assert.equal(row.previous_snapshot_available, true);
});

test('yesterday surge and today reversal raise profit-taking risk', () => {
  const result = scoreSectorRotation({
    sectors: [{key: 'solar', rankToday: 1, d1Pct: -1.8, d3Pct: 7, d5Pct: 10, advancersRatio: 0.35, positiveFlowRatio: 0.3, previousDayReturnPct: 8, brokenBoardRate: 0.7, nearLimitUpCount: 10}],
    previousSectors: [{key: 'solar', rankToday: 2, advancersRatio: 0.7, positiveFlowRatio: 0.65}],
    market: {d1Pct: -0.2}
  });
  assert.ok(result.sectors[0].profit_taking_risk_score >= 50);
});

test('entry timing is separate from sector opportunity and requires pullback confirmation', () => {
  const sector = scoreSectorRotation({
    sectors: [{key: 'battery', rankToday: 1, d1Pct: 4, d3Pct: 8, d5Pct: 12, advancersRatio: 0.8, positiveFlowRatio: 0.8, leaderRelativeStrengthPct: 3, topSectorRepeatDays: 3}],
    market: {d1Pct: 0.5}
  });
  const entry = evaluateEntryTiming({
    price: 10, ma5: 10, atrPct: 3, dayPct: 1, closeLocation: 0.8,
    priceVsVwapPct: 0.5, flow3: 1, flow5: 2, pullbackTouched: true, reclaimedMa5: true
  });
  assert.ok(sector.sectors[0].opportunity_score > 60);
  assert.equal(entry.pass, true);
  const chase = evaluateEntryTiming({
    price: 10.6, ma5: 10, atrPct: 3, dayPct: 8, closeLocation: 0.8,
    priceVsVwapPct: 0.5, flow3: 1, flow5: 2, pullbackTouched: false, reclaimedMa5: true
  });
  assert.equal(chase.pass, false);
});

test('missing entry timing data is NOT_MEASURABLE rather than an implicit pass', () => {
  const result = evaluateEntryTiming({price: 10, ma5: 10});
  assert.equal(result.status, 'NOT_MEASURABLE');
  assert.equal(result.pass, false);
});

function marketState(regime = 'BULL') {
  return {regime, confidence: 82, data_warnings: [], recommended_position_range_pct: regime === 'BULL' ? [35, 65] : [10, 35]};
}
function sectorResult(score = 82) {
  return {sectors: [{key: 'gpu_chip_design', label: 'GPU及芯片设计', opportunity_score: score}]};
}
function overnightResult(classification = 'POSITIVE', score = 72, mappingConfidence = 85, openSignal = 'NOT_MEASURABLE') {
  return {industries: {gpu_chip_design: {
    overnight_impact_score: score, adjusted_impact_score: score,
    impact_classification: classification, industry_mapping_confidence: mappingConfidence,
    a_share_open_signal: openSignal, a_share_open_status: 'NOT_MEASURABLE'
  }}};
}
function candidate(entryPass = true) {
  return {code: '688001', name: '样本', industryKey: 'gpu_chip_design', score: 85,
    entryTiming: {pass: entryPass, entry_timing_score: entryPass ? 88 : 40}};
}

test('BULL market with strong sector and confirmed entry allows selective entry only', () => {
  const result = buildV16DecisionOverlay({
    market: marketState('BULL'), sectorRotation: sectorResult(), overnight: overnightResult(), candidate: candidate(true)
  });
  assert.equal(result.decision, 'SELECTIVE_ENTRY');
  assert.equal(result.buy_permission, true);
  assert.equal(result.execution, 'NO_ORDER_PLACEMENT');
});

test('TRANSITION market limits permission to a small probe', () => {
  const result = buildV16DecisionOverlay({
    market: marketState('TRANSITION'), sectorRotation: sectorResult(), overnight: overnightResult(), candidate: candidate(true)
  });
  assert.equal(result.decision, 'PROBE_ONLY');
  assert.equal(result.single_position_cap_pct, 8);
});

test('BEAR market blocks new entry even when stock score is high', () => {
  const result = buildV16DecisionOverlay({
    market: marketState('BEAR'), sectorRotation: sectorResult(), overnight: overnightResult(), candidate: candidate(true)
  });
  assert.equal(result.decision, 'NO_NEW_RISK');
  assert.equal(result.buy_permission, false);
});

test('strongly negative overseas impact blocks entry unless A-share relative strength is confirmed', () => {
  const blocked = buildV16DecisionOverlay({
    market: marketState('BULL'), sectorRotation: sectorResult(),
    overnight: overnightResult('NEGATIVE', 25, 90), candidate: candidate(true)
  });
  assert.equal(blocked.decision, 'WAIT_FOR_OVERSEAS_RISK');
  const offset = buildV16DecisionOverlay({
    market: marketState('BULL'), sectorRotation: sectorResult(),
    overnight: overnightResult('NEGATIVE', 25, 90, 'RELATIVE_STRENGTH_CONFIRMED'), candidate: candidate(true)
  });
  assert.equal(offset.decision, 'SELECTIVE_ENTRY');
});

test('high opportunity score cannot bypass an unconfirmed entry timing gate', () => {
  const result = buildV16DecisionOverlay({
    market: marketState('BULL'), sectorRotation: sectorResult(), overnight: overnightResult(), candidate: candidate(false)
  });
  assert.equal(result.opportunity_score > 70, true);
  assert.equal(result.entry_timing_pass, false);
  assert.equal(result.buy_permission, false);
  assert.equal(result.decision, 'WAIT_FOR_ENTRY');
});

function replaySnapshot(date, breadthScope = 'full-market') {
  const row = session(date, 'strong');
  row.breadth.universe = breadthScope;
  return {
    tradeDate: date,
    capturedAt: date + 'T15:05:00+08:00',
    market: row,
    marketSummary: {d1Pct: 1.1},
    us: usSplitMarket,
    sectors: [{key: 'semiconductor', rankToday: 1, d1Pct: 2, d3Pct: 4, d5Pct: 5, advancersRatio: 0.7, positiveFlowRatio: 0.7, leaderRelativeStrengthPct: 2, topSectorRepeatDays: 2}]
  };
}

test('replay excludes snapshots captured after the requested as-of date', () => {
  const result = replayV16Snapshots({
    snapshots: [replaySnapshot('2026-11-04'), replaySnapshot('2026-11-05'), replaySnapshot('2026-11-06')],
    asOf: '2026-11-05'
  });
  assert.equal(result.replayedSnapshotCount, 2);
  assert.equal(result.excludedFutureSnapshotCount, 1);
  assert.equal(result.reports.at(-1).tradeDate, '2026-11-05');
});

test('Nov 4–5 validation refuses to fabricate missing point-in-time snapshots', () => {
  const result = buildNov4Nov5ValidationReport({snapshots: [replaySnapshot('2026-11-05')]});
  assert.equal(result.status, 'NOT_MEASURABLE');
  assert.deepEqual(result.missingPointInTimeSnapshotDates, ['2026-11-04']);
});

test('candidate-pool and missing intraday data are labelled partial and NOT_MEASURABLE', () => {
  const result = replayV16Snapshots({snapshots: [replaySnapshot('2026-11-05', 'candidate-pool')], asOf: '2026-11-05'});
  const report = result.reports[0];
  assert.equal(report.capabilities.fullMarketBreadth, 'NOT_MEASURABLE');
  assert.equal(report.capabilities.aShareOpen, 'NOT_MEASURABLE');
  assert.equal(report.status, 'PARTIAL');
});
