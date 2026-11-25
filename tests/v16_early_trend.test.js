import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scanV16,
  earlyTrend,
  flowContinuity,
  industryResonance,
  marketRegime
} from '../research/v16_early_trend.js';

const AS_OF = '2026-11-25T20:30:00+08:00';
const CAPTURED_AT = '2026-11-25T20:25:00+08:00';
const SOURCE = 'synthetic-fixture';

function tradingDates(end = '2026-11-25', count = 65) {
  const cursor = new Date(end + 'T00:00:00Z');
  const dates = [];
  while (dates.length < count) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return dates.reverse();
}

function makeBars({confirmed = false, overheated = false} = {}) {
  const dates = tradingDates();
  const bars = dates.map((date, i) => {
    const close = 10 + i * 0.001;
    return {
      date,
      availableAt: date + 'T15:05:00+08:00',
      source: SOURCE,
      open: close - 0.01,
      high: close + 0.05,
      low: close - 0.05,
      close,
      volume: 1000,
      amount: 100_000_000,
      turnover: 4
    };
  });
  if (confirmed) {
    bars.at(-2).open = 10.15;
    bars.at(-2).high = 10.30;
    bars.at(-2).low = 10.10;
    bars.at(-2).close = 10.25;
    bars.at(-2).volume = 1200;
    bars.at(-2).amount = 120_000_000;
    bars.at(-1).open = 10.18;
    bars.at(-1).high = 10.35;
    bars.at(-1).low = 10.13;
    bars.at(-1).close = 10.30;
    bars.at(-1).volume = 1500;
    bars.at(-1).amount = 150_000_000;
  } else {
    bars.at(-1).open = 10.15;
    bars.at(-1).high = 10.30;
    bars.at(-1).low = 10.10;
    bars.at(-1).close = 10.25;
    bars.at(-1).volume = 1500;
    bars.at(-1).amount = 150_000_000;
  }
  if (overheated) {
    const last = bars.at(-1);
    last.open = 11.90;
    last.high = 12.20;
    last.low = 11.80;
    last.close = 12.10;
    last.volume = 1800;
    last.amount = 180_000_000;
  }
  return bars;
}

function makeSnapshot({confirmed = false, marketStress = false, stale = false, missingFlow = false,
  missingIndustry = false, abnormalVolatility = false, overheated = false} = {}) {
  const dates = tradingDates();
  const bars = makeBars({confirmed, overheated});
  const availableAt = CAPTURED_AT;
  const moneyFlow = missingFlow ? [] : dates.slice(-5).map(date => ({
    date,
    availableAt,
    source: SOURCE,
    netMain: 2_000_000,
    amount: 150_000_000,
    estimated: false
  }));
  const industry = {
    industry: '测试行业',
    source: SOURCE,
    availableAt,
    verified: true,
    scope: 'industry',
    throughDate: dates.at(-1),
    sampleCount: 30,
    eligibleCount: 35,
    return3: 0.03,
    return5: 0.05,
    return10: 0.07,
    benchmarkReturn5: 0.01,
    upShare: 0.75,
    amountGrowth: 0.20,
    positiveFlowShare: 0.70,
    breakout20Share: 0.20,
    leaderPersistence: 0.80,
    medianReturn: 0.03,
    advanceDeclineRatio: 3
  };
  if (missingIndustry) industry.sampleCount = 10;
  const indices = ['SSE', 'SZSE', 'CHINEXT', 'STAR50'].map(code => ({
    code,
    source: SOURCE,
    availableAt,
    return1: marketStress ? -0.04 : 0.01
  }));
  const market = {
    source: SOURCE,
    availableAt,
    verified: true,
    scope: 'full-market',
    up: marketStress ? 800 : 3500,
    down: marketStress ? 4500 : 1800,
    flat: 100,
    limitUp: 30,
    limitDown: marketStress ? 100 : 10,
    amount: 1_000_000_000_000,
    indices,
    externalEvents: [],
    benchmarkReturns: {
      source: SOURCE,
      availableAt,
      throughDate: dates.at(-1),
      return5: 0.01,
      return10: 0.02
    }
  };
  const news = abnormalVolatility ? [{
    publishedAt: '2026-11-25T10:00:00+08:00',
    source: 'exchange-announcement-fixture',
    url: 'https://example.invalid/announcement',
    category: 'abnormal_volatility',
    impact: 'negative',
    exchangeVerified: true
  }] : [];
  const security = {
    code: '600001',
    name: '测试样本股',
    industry: '测试行业',
    bars,
    moneyFlow,
    metadata: {
      source: SOURCE,
      availableAt,
      exchange: 'SSE',
      board: 'MAIN',
      tradingDate: dates.at(-1),
      isST: false,
      delistingRisk: false,
      tradingStatus: 'TRADING',
      ruleSource: 'exchange-rule-fixture',
      ruleEffectiveAt: '2026-01-01T00:00:00+08:00',
      limitUpPrice: 11.00,
      limitDownPrice: 9.00
    },
    news,
    fundamentals: {
      source: SOURCE,
      availableAt: '2026-10-31T10:00:00+08:00',
      reportPeriod: '2026-09-30',
      netProfitGrowth: 0.12,
      operatingCashFlow: 100_000_000,
      previousOperatingCashFlow: 80_000_000,
      pe: 20,
      industryMedianPE: 15,
      pledgeRatio: 0.10,
      auditGoingConcern: false,
      fraudVerified: false
    },
    evidenceCoverage: {
      source: SOURCE,
      availableAt,
      newsComplete: true,
      fundamentalsComplete: true
    }
  };
  const snapshot = {
    id: 'fixture-' + (confirmed ? 'confirmed' : 'triggered'),
    universeId: 'fixture-main-board',
    asOf: AS_OF,
    capturedAt: stale ? '2026-11-25T19:00:00+08:00' : CAPTURED_AT,
    expectedDailyDate: dates.at(-1),
    calendar: {
      source: SOURCE,
      availableAt,
      verified: true,
      coverageThrough: dates.at(-1),
      tradingDates: dates
    },
    universeCoverage: {
      source: SOURCE,
      availableAt,
      verified: true,
      scope: 'eligible-universe',
      tradingDate: dates.at(-1),
      expectedCount: 1,
      observedCount: 1,
      coverage: 1
    },
    market,
    industries: missingIndustry ? [] : [industry],
    securities: [security]
  };
  return snapshot;
}

test('same point-in-time snapshot is deterministic and idempotent', () => {
  const snapshot = makeSnapshot({confirmed: true});
  const first = scanV16(snapshot);
  const repeated = scanV16(snapshot, first.poolState);
  assert.deepEqual(repeated, first);
  assert.equal(first.metadata.mode, 'SHADOW');
  assert.equal(first.metadata.probabilityCalibration, 'NOT_CALIBRATED');
  assert.equal(first.candidates[0].execution, 'SHADOW_NO_ORDERS');
  assert.equal(first.productionOverride, false);
});

test('first moderate-volume breakout enters TRIGGERED, not CONFIRMED', () => {
  const result = scanV16(makeSnapshot());
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].phase, 'B');
  assert.equal(result.candidates[0].state, 'TRIGGERED');
  assert.equal(result.candidates[0].buyPlanEligible, false);
  assert.equal(result.decision, 'OBSERVE');
});

test('held breakout plus complete funding, industry, market and evidence can reach CONFIRMED', () => {
  const result = scanV16(makeSnapshot({confirmed: true}));
  assert.equal(result.candidates[0].phase, 'C');
  assert.equal(result.candidates[0].state, 'CONFIRMED');
  assert.equal(result.candidates[0].buyPlanEligible, true);
  assert.deepEqual(result.buyPlanEvaluation, ['600001']);
});

test('missing five-session flow is NOT_MEASURABLE and cannot confirm', () => {
  const result = scanV16(makeSnapshot({confirmed: true, missingFlow: true}));
  assert.equal(result.candidates[0].flow.complete, false);
  assert.equal(result.candidates[0].flow.sourceType, 'NOT_MEASURABLE');
  assert.equal(result.candidates[0].state, 'TRIGGERED');
  assert.equal(result.candidates[0].buyPlanEligible, false);
});

test('incomplete industry coverage cannot confirm or receive a full industry score', () => {
  const result = scanV16(makeSnapshot({confirmed: true, missingIndustry: true}));
  assert.equal(result.candidates[0].industryEvidence.complete, false);
  assert.equal(result.candidates[0].state, 'TRIGGERED');
  assert.equal(result.candidates[0].buyPlanEligible, false);
});

test('systemic market stress forces global WAIT and zero position allowance', () => {
  const result = scanV16(makeSnapshot({confirmed: true, marketStress: true}));
  assert.equal(result.market.regime, 'SYSTEMIC');
  assert.equal(result.market.pass, false);
  assert.equal(result.market.maxPosition, 0);
  assert.equal(result.decision, 'WAIT');
  assert.equal(result.candidates[0].buyPlanEligible, false);
});

test('stale snapshot forces WAIT and invalidates all candidate states', () => {
  const result = scanV16(makeSnapshot({confirmed: true, stale: true}));
  assert.equal(result.decision, 'WAIT');
  assert.equal(result.candidates.length, 0);
  assert.ok(result.evaluations[0].risk.hardVeto.includes('STALE_SNAPSHOT'));
});

test('exchange-verified abnormal-volatility announcement hard-vetoes the candidate', () => {
  const result = scanV16(makeSnapshot({abnormalVolatility: true}));
  assert.equal(result.evaluations[0].state, 'INVALIDATED');
  assert.ok(result.evaluations[0].risk.hardVeto.includes('ANNOUNCEMENT_abnormal_volatility'));
  assert.equal(result.candidates.length, 0);
});

test('overheated acceleration is excluded from the observation TOP pool', () => {
  const result = scanV16(makeSnapshot({overheated: true}));
  assert.ok(['D', 'E'].includes(result.evaluations[0].phase));
  assert.equal(result.candidates.length, 0);
  assert.equal(result.decision, 'WAIT');
});

test('future daily bars and future news are excluded from point-in-time scoring', () => {
  const baseline = makeSnapshot({confirmed: true});
  const baselineResult = scanV16(baseline);
  const withFuture = makeSnapshot({confirmed: true});
  withFuture.securities[0].bars.push({
    date: '2026-11-26',
    availableAt: '2026-11-26T15:05:00+08:00',
    source: SOURCE,
    open: 10.3, high: 10.5, low: 10.2, close: 10.45, volume: 5000,
    amount: 500_000_000, turnover: 10
  });
  withFuture.securities[0].news.push({
    publishedAt: '2026-11-26T09:00:00+08:00',
    source: SOURCE,
    url: 'https://example.invalid/future',
    category: 'earnings_up',
    impact: 'positive',
    businessVerified: true,
    businessRationale: 'future event',
    evidenceUrl: 'https://example.invalid/future'
  });
  const futureResult = scanV16(withFuture);
  assert.equal(futureResult.candidates[0].score, baselineResult.candidates[0].score);
  assert.equal(futureResult.candidates[0].phase, baselineResult.candidates[0].phase);
  assert.equal(futureResult.candidates[0].state, baselineResult.candidates[0].state);
  assert.ok(futureResult.candidates[0].risk.warnings.some(x => x.includes('扫描后/未公开/无来源日线已排除')));
});

test('duplicate daily bars are a hard data-quality failure', () => {
  const snapshot = makeSnapshot();
  snapshot.securities[0].bars.push({...snapshot.securities[0].bars.at(-1)});
  const result = scanV16(snapshot);
  assert.equal(result.candidates.length, 0);
  assert.ok(result.evaluations[0].risk.hardVeto.includes('DATA_QUALITY'));
});

test('missing independent full-market evidence yields UNKNOWN and WAIT', () => {
  const snapshot = makeSnapshot();
  snapshot.market.scope = 'candidate-pool';
  const result = scanV16(snapshot);
  assert.equal(result.market.regime, 'UNKNOWN');
  assert.equal(result.market.pass, false);
  assert.equal(result.decision, 'WAIT');
});

test('news and fundamentals risk are visible as explicit deductions', () => {
  const snapshot = makeSnapshot({confirmed: true});
  snapshot.securities[0].fundamentals.netProfitGrowth = -0.60;
  snapshot.securities[0].fundamentals.operatingCashFlow = -20_000_000;
  snapshot.securities[0].fundamentals.previousOperatingCashFlow = 80_000_000;
  snapshot.securities[0].fundamentals.pe = 100;
  snapshot.securities[0].fundamentals.industryMedianPE = 20;
  snapshot.securities[0].fundamentals.pledgeRatio = 0.60;
  const result = scanV16(snapshot);
  const codes = result.evaluations[0].risk.penalties.map(x => x.code);
  for (const code of ['EARNINGS_DECLINE','CASH_FLOW_DETERIORATION','VALUATION_DEVIATION','PLEDGE_RISK']) {
    assert.ok(codes.includes(code), 'missing risk penalty: ' + code);
  }
});

test('pool state cannot move backwards in time', () => {
  const snapshot = makeSnapshot({confirmed: true});
  const first = scanV16(snapshot);
  const earlier = {...snapshot, id: 'earlier', asOf: '2026-11-25T19:00:00+08:00', capturedAt: '2026-11-25T18:55:00+08:00'};
  assert.throws(() => scanV16(earlier, first.poolState), /backwards in time/);
});

test('market and industry helpers fail closed on stale or incomplete evidence', () => {
  const snapshot = makeSnapshot({confirmed: true});
  const staleMarket = {...snapshot.market, availableAt: '2026-11-25T19:00:00+08:00'};
  assert.equal(marketRegime(staleMarket, AS_OF).regime, 'UNKNOWN');
  const incompleteIndustry = {...snapshot.industries[0], sampleCount: 5};
  assert.equal(industryResonance(incompleteIndustry, AS_OF).complete, false);
  const flow = flowContinuity([], snapshot.securities[0].bars, AS_OF);
  assert.equal(flow.complete, false);
  assert.equal(earlyTrend(snapshot.securities[0].bars).phase, 'C');
});


test('missing or partial eligible-universe coverage forces global WAIT', () => {
  const missing = makeSnapshot({confirmed: true});
  delete missing.universeCoverage;
  const missingResult = scanV16(missing);
  assert.equal(missingResult.decision, 'WAIT');
  assert.equal(missingResult.universeCoverage.valid, false);
  assert.ok(missingResult.evaluations[0].risk.hardVeto.includes('UNIVERSE_COVERAGE_INSUFFICIENT'));

  const partial = makeSnapshot({confirmed: true});
  partial.universeCoverage.expectedCount = 100;
  partial.universeCoverage.coverage = 0.01;
  const partialResult = scanV16(partial);
  assert.equal(partialResult.decision, 'WAIT');
  assert.equal(partialResult.universeCoverage.valid, false);
});

test('stale per-security metadata fails the data-quality gate', () => {
  const snapshot = makeSnapshot({confirmed: true});
  snapshot.securities[0].metadata.availableAt = '2026-11-25T19:00:00+08:00';
  const result = scanV16(snapshot);
  assert.equal(result.candidates.length, 0);
  assert.ok(result.evaluations[0].risk.hardVeto.includes('DATA_QUALITY'));
  assert.ok(result.evaluations[0].dataQuality.errors.includes('SECURITY_METADATA_STALE'));
});

test('closing at the verified upper price cannot become a normal buy-plan candidate', () => {
  const snapshot = makeSnapshot({confirmed: true});
  const last = snapshot.securities[0].bars.at(-1);
  last.high = 10.30;
  last.close = 10.30;
  snapshot.securities[0].metadata.limitUpPrice = 10.30;
  const result = scanV16(snapshot);
  assert.equal(result.candidates[0].state, 'TRIGGERED');
  assert.equal(result.candidates[0].entryBlocked, true);
  assert.equal(result.candidates[0].buyPlanEligible, false);
  assert.ok(result.candidates[0].risk.warnings.some(x => x.includes('禁止按普通突破信号追买')));
});

test('flow spike reversal invalidates a previously triggered candidate', () => {
  const firstSnapshot = makeSnapshot();
  const first = scanV16(firstSnapshot);
  assert.equal(first.candidates[0].state, 'TRIGGERED');

  const next = makeSnapshot({confirmed: true});
  const nextDate = '2026-11-26';
  const nextAvailableAt = '2026-11-26T20:25:00+08:00';
  next.id = 'fixture-next-session-flow-reversal';
  next.asOf = '2026-11-26T20:30:00+08:00';
  next.capturedAt = nextAvailableAt;
  next.expectedDailyDate = nextDate;
  next.calendar.availableAt = nextAvailableAt;
  next.calendar.coverageThrough = nextDate;
  next.calendar.tradingDates.push(nextDate);
  next.universeCoverage.availableAt = nextAvailableAt;
  next.universeCoverage.tradingDate = nextDate;
  next.market.availableAt = nextAvailableAt;
  for (const index of next.market.indices) index.availableAt = nextAvailableAt;
  next.market.benchmarkReturns.availableAt = nextAvailableAt;
  next.market.benchmarkReturns.throughDate = nextDate;
  next.industries[0].availableAt = nextAvailableAt;
  next.industries[0].throughDate = nextDate;

  const security = next.securities[0];
  security.metadata.availableAt = nextAvailableAt;
  security.metadata.tradingDate = nextDate;
  security.evidenceCoverage.availableAt = nextAvailableAt;
  security.bars.push({
    date: nextDate,
    availableAt: '2026-11-26T15:05:00+08:00',
    source: SOURCE,
    open: 10.24,
    high: 10.35,
    low: 10.13,
    close: 10.30,
    volume: 1200,
    amount: 120_000_000,
    turnover: 4
  });
  const dates = [...tradingDates().slice(-4), nextDate];
  const flows = [10_000_000, 2_000_000, 2_000_000, 2_000_000, -1_000_000];
  security.moneyFlow = dates.map((date, i) => ({
    date,
    availableAt: nextAvailableAt,
    source: SOURCE,
    netMain: flows[i],
    amount: 150_000_000,
    estimated: false
  }));

  const result = scanV16(next, first.poolState);
  assert.equal(result.evaluations[0].flow.reversal, true);
  assert.equal(result.evaluations[0].state, 'INVALIDATED');
  assert.ok(result.evaluations[0].risk.hardVeto.includes('BREAKOUT_INVALIDATED'));
});

test('duplicate benchmark index rows fail closed instead of overweighting an index', () => {
  const snapshot = makeSnapshot();
  snapshot.market.indices.push({...snapshot.market.indices[0]});
  const result = scanV16(snapshot);
  assert.equal(result.market.regime, 'UNKNOWN');
  assert.equal(result.decision, 'WAIT');
});

test('stale evidence-coverage metadata cannot authorize confirmation', () => {
  const snapshot = makeSnapshot({confirmed: true});
  snapshot.securities[0].evidenceCoverage.availableAt = '2026-11-25T19:00:00+08:00';
  const result = scanV16(snapshot);
  assert.equal(result.candidates[0].state, 'TRIGGERED');
  assert.equal(result.candidates[0].buyPlanEligible, false);
  assert.equal(result.candidates[0].dataQuality.status, 'PARTIAL');
});
