import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMarketEmotion } from '../market_emotion.js';

test('market emotion is index-dominant and exposes ranked-pool diagnostics', () => {
  const result = buildMarketEmotion(
    [
      {name:'上证',pct:0.6},
      {name:'深证',pct:0.8},
      {name:'创业板',pct:0.5},
      {name:'科创50',pct:0.7}
    ],
    Array.from({length:100},(_,i)=>({f3:i<20?6:1}))
  );
  assert.ok(result.score >= 65);
  assert.equal(result.label,'RISING');
  assert.equal(result.diagnostics.indexCount,4);
  assert.equal(result.diagnostics.rankedPoolCount,100);
  assert.ok(result.diagnostics.rankedPositiveRatio > 0);
});

test('very hot participation is labelled FEVER before the score reaches 90', () => {
  const result = buildMarketEmotion(
    [
      {name:'上证',pct:1.4},
      {name:'深证',pct:1.5},
      {name:'创业板',pct:1.6},
      {name:'科创50',pct:1.3}
    ],
    Array.from({length:100},(_,i)=>({f3:i<60?9.9:6}))
  );
  assert.ok(result.score >= 82);
  assert.equal(result.label,'FEVER');
});

test('market emotion turns defensive when indices and ranked pool weaken', () => {
  const result = buildMarketEmotion(
    [
      {name:'上证',pct:-2.0},
      {name:'深证',pct:-2.2},
      {name:'创业板',pct:-2.5},
      {name:'科创50',pct:-1.8}
    ],
    Array.from({length:100},()=>({f3:-4}))
  );
  assert.ok(result.score < 45);
  assert.equal(result.label,'PANIC');
});

test('missing inputs fail closed instead of manufacturing a neutral score', () => {
  const result = buildMarketEmotion([], []);
  assert.equal(result.score,null);
  assert.equal(result.label,'UNKNOWN');
  assert.equal(result.confidence,0);
});
