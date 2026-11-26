import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateV17HistoricalReplay} from '../research/v17_one_click_backtest.js';

function dateShift(date, days) {
  return new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
}

function barsFor(tradeDate) {
  const rows = [];
  for (let index = 64; index >= 0; index--) {
    const date = dateShift(tradeDate, -index);
    const close = 10 + (64 - index) * 0.008;
    rows.push({
      date, open: close * 0.999, high: close * 1.01, low: close * 0.99, close,
      volume: 1000000, amount: 10000000, turnover: 4,
      source: 'synthetic replay fixture', availableAt: date + 'T15:05:00+08:00'
    });
  }
  return rows;
}

function replaySnapshot(tradeDate, day) {
  const stockRows = [];
  for (let index = 0; index < 550; index++) {
    const code = index === 0 ? '000001' : String(100 + index).padStart(6, '0');
    const price = 10 + day * 0.12 + index * 0.0001;
    stockRows.push({
      code, name: '回放样本' + code, industry: '电子',
      price, open: price * 0.995, high: price * 1.015, low: 9.4 + day * 0.08,
      pct: 0.8, amount: 100000000, turn: 5, mcap: 5000000000,
      pct60: 12 + day * 0.2, mainNet: 12000000, mainPct: 1.2,
      quoteAt: tradeDate + 'T15:00:00+08:00', specialTreatment: false
    });
  }
  return {
    schema: 'ashare-v16-daily-snapshot-v1',
    tradeDate, capturedAt: tradeDate + 'T15:25:00+08:00',
    sourceScope: 'full-market',
    quality: {
      qualifiedForReplay: true, sourceComplete: true,
      collectionFinishedAt: tradeDate + 'T15:20:00+08:00',
      coveragePct: 100, quoteTimestampCoverage: 1, sameDateQuoteRatio: 1
    },
    market: {
      breadth: {
        universe: 'full-market', fullMarket: true, coverage: 1,
        uniqueSymbols: stockRows.length, totalReported: stockRows.length,
        up: 420, down: 80, flat: 50
      },
      indices: [{key: 'shanghai', name: '上证指数', trend5Pct: 0.5, changePct: 0.3}],
      turnover: {amountCny: 900000000000},
      sentiment: {limitUpCount: 50, limitDownCount: 5},
      sectors: [{
        key: '电子', label: '电子', d1Pct: 1.1, advancersRatio: 0.8,
        positiveFlowRatio: 0.8, leaderRelativeStrengthPct: 1.2
      }],
      leaders: [], marketAveragePct: 0.8,
      limitPools: {status: 'AVAILABLE', sourceStatus: {limitUp: 'AVAILABLE'}, limitUp: [], limitDown: []},
      lhb: {dailyStatus: 'NOT_MEASURABLE', seatStatus: 'NOT_MEASURABLE'}
    },
    volumePhaseRows: [{
      code: '000001', name: '回放样本000001', industry: '电子',
      status: 'AVAILABLE', bars: barsFor(tradeDate),
      phase: {
        status: 'AVAILABLE', classification: 'CONSTRUCTIVE_PULLBACK',
        label: '缩量回踩守支撑', reasons: [], metrics: {deviation20Pct: 4}
      }
    }],
    volumePhaseDiagnostics: {status: 'AVAILABLE', requestedCount: 1, availableCount: 1, measurableCount: 1, coverage: 1},
    earlyTrendRows: [],
    earlyTrendDiagnostics: {status: 'AVAILABLE', requestedCount: 0, availableCount: 0, measurableCount: 0, coverage: 0},
    stockRows
  };
}

test('V17 replay remains NOT_MEASURABLE when the archive lacks matured signal dates', () => {
  const report = evaluateV17HistoricalReplay({
    snapshots: [replaySnapshot('2026-11-25', 0)],
    asOf: '2026-11-25T16:00:00+08:00'
  });
  assert.equal(report.status, 'NOT_MEASURABLE');
  assert.equal(report.promotionEligible, false);
  assert.equal(report.qualifiedSignalDates, 1);
});

test('V17 replay uses frozen signal-date data and compares V17 with V15 and momentum baselines', () => {
  const snapshots = [
    replaySnapshot('2026-11-23', 0),
    replaySnapshot('2026-11-24', 1),
    replaySnapshot('2026-11-25', 2)
  ];
  const options = {
    snapshots, asOf: '2026-11-25T16:00:00+08:00',
    topKs: [1], horizons: [1], minSignalDates: 2, minSampleCoverage: 0.95
  };
  const first = evaluateV17HistoricalReplay(options);
  assert.equal(first.aggregate.v17MainBoard.top1['T+1'].status, 'MEASURABLE');
  assert.equal(first.aggregate.v15Stage1.top1['T+1'].status, 'MEASURABLE');
  assert.equal(first.aggregate.momentum60.top1['T+1'].status, 'MEASURABLE');
  assert.equal(first.aggregate.v17MainBoard.top1['T+1'].signalDateCount, 2);
  assert.equal(first.aggregate.v17MainBoard.top1['T+1'].sampleCoverage, 1);

  const mutated = snapshots.map((snapshot, index) => index === 0 ? snapshot : ({
    ...snapshot,
    stockRows: snapshot.stockRows.map(row => row.code === '000001' ? {...row, price: 99, high: 100} : row)
  }));
  const second = evaluateV17HistoricalReplay({...options, snapshots: mutated});
  assert.deepEqual(
    first.daily[0].topK.v17All.top1.top.map(row => row.code),
    second.daily[0].topK.v17All.top1.top.map(row => row.code)
  );
  assert.equal(first.executionConvention.entry.includes('next qualified archived session open'), true);
  assert.equal(first.officialTradingCalendarStatus, 'NOT_MEASURABLE_NOT_ARCHIVED');
});
