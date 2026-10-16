import test from 'node:test';
import assert from 'node:assert/strict';
import { _internal } from '../../../api/v12_decision.js';

test('execution tiers keep early setup non-executable', () => {
  const tier = _internal.executionTier({
    scores:{v12Trade:58,timing:64,psychology:58},
    psychology:{fomoRisk:{score:48},stage:'ignition'},
    timing:{stage:'startup'},
    marketEmotion:{score:68}
  });
  assert.equal(tier,'EARLY_SETUP');
});

test('high quality confirmation remains stricter than early setup', () => {
  const tier = _internal.executionTier({
    scores:{v12Trade:78,timing:79,psychology:74},
    psychology:{fomoRisk:{score:58},stage:'acceleration'},
    timing:{stage:'acceleration'},
    marketEmotion:{score:80}
  });
  assert.equal(tier,'CONFIRM_ENTRY');
});

test('emotional climax cannot become a confirmation entry', () => {
  const tier = _internal.executionTier({
    scores:{v12Trade:82,timing:82,psychology:78},
    psychology:{fomoRisk:{score:84},stage:'climax'},
    timing:{stage:'acceleration'},
    marketEmotion:{score:92}
  });
  assert.notEqual(tier,'CONFIRM_ENTRY');
});
