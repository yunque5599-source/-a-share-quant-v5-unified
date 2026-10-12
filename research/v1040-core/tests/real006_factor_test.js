import assert from 'node:assert/strict';
import { adaptMarketPayload } from '../adapter/market_adapter.js';
import { evaluateReal } from '../run.js';

function dateFor(index) {
  return '2026-01-' + String(index + 1).padStart(2, '0');
}

function klineRows(mode) {
  const closes = mode === 'high'
    ? [...Array.from({ length: 20 }, (_, index) => 100 + index * 0.5), 110, 112, 114, 116, 118]
    : Array.from({ length: 25 }, (_, index) => 100 + index * 0.05);
  const high = mode === 'high';
  return closes.map((close, index) => ({
    date: dateFor(index),
    open: close - (high ? 1 : 0.05),
    close,
    high: close + (high ? 1 : 0.05),
    low: close - (high ? 1 : 0.05),
    volume: high && index === 24 ? 30_000_000 : high ? 10_000_000 : 5_000_000,
    amount: high ? 1_000_000_000 : 50_000_000
  }));
}

function flowRows(mode) {
  return Array.from({ length: 25 }, (_, index) => ({
    date: dateFor(index),
    mainNet: mode === 'high' ? 100_000_000 : -30_000_000,
    mainNetPct: mode === 'high' ? 8 : -2,
    amount: mode === 'high' ? 1_000_000_000 : 50_000_000,
    index
  }));
}

const payload = {
  data: {
    indices: [{ name: '上证', pct: 0.8 }, { name: '深证', pct: 1.1 }],
    sectorResearch: {
      sectors: [
        { industry: '新能源', medianPct: 6 },
        { industry: '银行', medianPct: 0 },
        { industry: '题材', medianPct: -3 }
      ]
    },
    candidates: [
      { f12: '600001', f14: '趋势资金龙头', f3: 5, f6: 1_000_000_000, f8: 8, f100: '新能源', catalystScore: 95 },
      { f12: '600002', f14: '趋势资金二号', f3: 4, f6: 1_000_000_000, f8: 7, f100: '新能源', catalystScore: 90 },
      { f12: '000003', f14: '弱势样本', f3: -1, f6: 50_000_000, f8: 1, f100: '题材', catalystScore: 30 }
    ],
    historyBySymbol: {
      '600001': { data: { klines: klineRows('high') } },
      '600002': { data: { klines: klineRows('high') } },
      '000003': { data: { klines: klineRows('low') } }
    },
    flowBySymbol: {
      '600001': { data: { klines: flowRows('high') } },
      '600002': { data: { klines: flowRows('high') } },
      '000003': { data: { klines: flowRows('low') } }
    }
  }
};

const result = evaluateReal(payload);
assert.equal(result.market.marketRisk, 'normal');
assert.equal(result.action, 'BUY');
assert.deepEqual(result.portfolio.map(item => item.symbol), ['600001', '600002']);
assert.ok(result.ranking[0].adjustedScore >= 90);
assert.ok(result.ranking[1].adjustedScore >= 85);
assert.ok(result.ranking[0].historyMetrics.gain5Pct > 5);
assert.ok(result.ranking[0].historyMetrics.trend20Pct > 20);
assert.equal(result.ranking[0].historyMetrics.maAligned, true);
assert.ok(result.ranking[0].fundingMetrics.consecutivePositiveDays >= 5);
assert.ok(result.ranking[0].historyMetrics.volumeExpansionRatio > 2);
assert.equal(result.ranking[0].historyMetrics.breakout, true);
assert.ok(result.ranking[0].shortTermScore >= 90);

const noProxy = adaptMarketPayload({
  data: { candidates: [{ f12: '600009', f14: '仅排名', f24: 30, rankScore: 99 }] }
});
assert.equal(noProxy.candidates[0].capitalScore, null);
assert.equal(noProxy.candidates[0].trendScore, null);
assert.equal(noProxy.candidates[0].shortTermGainPct, null);
console.log('REAL-006 trend/funds/industry/strength tests: PASS');
