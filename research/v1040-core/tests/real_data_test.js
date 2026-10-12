import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adaptMarketPayload } from '../adapter/market_adapter.js';
import { evaluateReal, savePrediction } from '../run.js';

const fixture = {
  data: {
    indices: [{ name: '上证', pct: 0.8 }, { name: '深证', pct: 1.1 }],
    candidates: [
      { f12: '600519', f14: '贵州茅台', f2: 1680, f3: 2.1, f6: 2.1e9, f8: 3.5, f24: 5.8, f62: 8e8, f184: 12, f100: '白酒', rankScore: 95 },
      { f12: '000858', f14: '五粮液', f2: 145, f3: 1.8, f6: 1.6e9, f8: 4.2, f24: 4.6, f62: 5e8, f184: 8, f100: '白酒', rankScore: 90 },
      { f12: '300999', f14: '高波动样本', f2: 20, f3: 9, f6: 1e7, f8: 18, f24: 25, f62: 1e7, f184: 3, f100: '题材', rankScore: 85 }
    ]
  }
};
const before = JSON.stringify(fixture);
const adapted = adaptMarketPayload(fixture);
assert.equal(adapted.source, 'market.js');
assert.equal(adapted.market.marketRisk, 'normal');
assert.deepEqual(adapted.candidates.map(item => item.symbol), ['600519', '000858', '300999']);
assert.ok(adapted.candidates.every(item => Number.isFinite(item.trendScore)));
assert.ok(adapted.candidates.every(item => item.catalystScore === null));
assert.equal(JSON.stringify(fixture), before);

const result = evaluateReal(fixture);
assert.equal(result.source, 'market.js');
assert.equal(result.market.marketRisk, 'normal');
assert.equal(result.ranking.length, 3);
assert.deepEqual(new Set(result.ranking.map(item => item.symbol)), new Set(['600519', '000858', '300999']));
assert.ok(result.ranking[0].adjustedScore >= result.ranking[1].adjustedScore);
assert.ok(['BUY', 'WATCH', 'WAIT'].includes(result.action));
assert.notEqual(result.action, 'BUY');
for (const item of result.ranking) {
  assert.ok(Number.isFinite(item.adjustedScore));
  assert.equal(item.dataComplete, false);
}

const discovery = adaptMarketPayload({
  schema: 'ashare-independent-main-board-v1',
  quality: { qualified: true },
  records: [{ code: '600001', name: '测试', pct: 1, amount: 9e7, turn: 2, pct60: 3, mainPct: 5, industry: '银行' }]
});
assert.equal(discovery.source, 'discovery_universe.js');
assert.equal(discovery.candidates[0].symbol, '600001');

const outputDir = await mkdtemp(join(tmpdir(), 'v1040-real005-'));
try {
  const saved = await savePrediction(result, { date: '2026-10-12', outputDir });
  const document = JSON.parse(await readFile(saved.outputPath, 'utf8'));
  assert.equal(document.date, '2026-10-12');
  assert.equal(document.decision, result.action);
  assert.equal(document.predictions.length, 3);
  assert.ok('score' in document.predictions[0]);
  assert.ok('reason' in document.predictions[0]);
  assert.ok('risk' in document.predictions[0]);
} finally {
  await rm(outputDir, { recursive: true, force: true });
}
console.log('REAL-005 real data simulation: PASS');
