import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { computeEarlyOpportunity } from '../early_opportunity.js';
import { integrateCandidateFlow } from '../candidate_flow.js';
import { V12_TRADE_WEIGHTS } from '../v12_trade_score.js';

function makeBars(closes, options = {}) {
  const start = new Date('2026-01-01T00:00:00Z');
  return closes.map((close, index) => {
    const date = new Date(start.getTime() + index * 86400000).toISOString().slice(0, 10);
    const volume = options.volume?.(index, close) ?? 1000;
    return {
      date, open:close, close,
      high:close * (1 + (options.highPct ?? 0.015)),
      low:close * (1 - (options.lowPct ?? 0.015)),
      volume, amount:volume * close
    };
  });
}

function baseThenTurn() {
  const closes = [];
  for (let i = 0; i < 35; i += 1) closes.push(120 - i * 0.75);
  const base = closes.at(-1);
  for (let i = 0; i < 17; i += 1) closes.push(base + [0, 0.15, -0.08, 0.08, -0.12][i % 5]);
  closes.push(base + 0.05, base + 0.2, base + 0.55, base + 0.95, base + 1.5, base + 2.2, base + 3.0, base + 3.8);
  return makeBars(closes, {volume:index => index >= 52 ? 1500 : 1000});
}

test('early opportunity finds a low-zone base beginning to turn without treating it as a buy guarantee', () => {
  const bars = baseThenTurn();
  const result = computeEarlyOpportunity({bars, asOf:bars.at(-1).date, features:{
    capital:{score:72}, sector:{score:70}
  }});
  assert.ok(result.score >= 0 && result.score <= 100);
  assert.ok(['early-base', 'turning-up', 'watch'].includes(result.stage));
  assert.ok(result.metrics.distance20dLowPct < 15);
  assert.ok(result.confidence > 0);
  assert.ok(result.reasons.length > 0);
  assert.equal(result.version, 'V12 Early Opportunity Discovery v1');
});

test('persistent falling knife is capped and marked as downside risk', () => {
  const bars = makeBars(Array.from({length:60}, (_, i) => 120 - i * 0.85));
  const result = computeEarlyOpportunity({bars, asOf:bars.at(-1).date});
  assert.equal(result.stage, 'downtrend-risk');
  assert.ok(result.score <= 44);
  assert.ok(result.reasons.includes('persistent-downtrend-risk') ||
    result.reasons.includes('recent-low-breakdown-risk'));
});

test('late vertical rally is marked extended and score is capped', () => {
  const closes = Array.from({length:55}, (_, i) => 100 + i * 0.02);
  closes.push(103, 106, 111, 120, 132);
  const bars = makeBars(closes, {highPct:0.03, lowPct:0.03});
  const result = computeEarlyOpportunity({bars, asOf:bars.at(-1).date});
  assert.equal(result.stage, 'extended');
  assert.ok(result.score <= 58);
});

test('future bars and incomplete same-day intraday bars cannot change features', () => {
  const bars = baseThenTurn();
  const asOf = bars.at(-1).date;
  const baseline = computeEarlyOpportunity({bars, asOf});
  const futureBar = {...bars.at(-1), date:'2026-03-20', close:999, high:1000, low:998, volume:999999};
  const future = computeEarlyOpportunity({bars:[...bars, futureBar], asOf});
  assert.equal(future.score, baseline.score);
  assert.equal(future.metrics.return5dPct, baseline.metrics.return5dPct);
  assert.equal(future.diagnostics.futureBarsIgnored, 1);

  const intraday = computeEarlyOpportunity({
    bars, asOf:asOf + 'T03:00:00Z'
  });
  assert.equal(intraday.diagnostics.sameDayBarsIgnored, 1);
  assert.equal(intraday.diagnostics.barsUsed, bars.length - 1);
});

test('insufficient history safely returns no score', () => {
  const bars = makeBars([10, 10.1, 10.2, 10.3, 10.4]);
  const result = computeEarlyOpportunity({bars, asOf:bars.at(-1).date});
  assert.equal(result.score, null);
  assert.equal(result.stage, 'insufficient-data');
  assert.equal(result.confidence, 0);
});

test('early opportunity ranking is exposed without changing frozen V12 score weights', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/v11_flow.json', import.meta.url), 'utf8'));
  const result = integrateCandidateFlow(fixture);
  assert.ok(Array.isArray(result.earlyOpportunityRanking));
  assert.ok(result.earlyOpportunityRanking.length > 0);
  assert.equal(result.version, 'V11 Short Alpha Phase 1');
  assert.deepEqual(result.ranking[0].scores.components && Object.keys(result.ranking[0].scores.components),
    ['capital', 'momentum', 'sector', 'volume', 'risk']);
  assert.deepEqual(V12_TRADE_WEIGHTS, {alpha:0.6, timing:0.25, psychology:0.15});
  assert.ok(result.ranking.every(row => row.features.earlyOpportunity !== undefined));
  assert.equal(result.earlyOpportunityRanking.every(row =>
    Number.isFinite(row.features.earlyOpportunity.score)), true);
});
