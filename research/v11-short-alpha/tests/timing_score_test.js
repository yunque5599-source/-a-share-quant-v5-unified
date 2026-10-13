import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { scoreTiming, withTiming, TIMING_WEIGHTS } from '../timing_score.js';
import { scoreCandidate, rankCandidates } from '../alpha_score.js';
import { integrateCandidateFlow } from '../candidate_flow.js';

const flowFixture = JSON.parse(await readFile(
  new URL('./fixtures/v11_flow.json', import.meta.url), 'utf8'
));

function timingRecord(stage, flow, risk) {
  return {features:{momentum:{trendStage:stage,overboughtRisk:risk},capital:{flowTiming:flow}}};
}

function scoredRecord(symbol, scores, stage, flow, risk) {
  return {
    symbol,
    features: {
      capital:{score:scores[0],flowTiming:flow},
      momentum:{score:scores[1],trendStage:stage,overboughtRisk:risk},
      sector:{score:scores[2]}, volume:{score:scores[3]}, risk:{score:scores[4]}
    }
  };
}

test('startup and early capital produce a high BUY_NOW timing score', () => {
  assert.deepEqual(TIMING_WEIGHTS, {trendStage:.40,capitalLead:.35,chaseSafety:.25});
  const timing = scoreTiming(timingRecord('startup','early-inflow','normal'));
  assert.equal(timing.score, 90);
  assert.equal(timing.signal, 'BUY_NOW');
  assert.ok(timing.score >= 0 && timing.score <= 100);
});

test('high-risk late inflow produces an AVOID timing score', () => {
  const timing = scoreTiming(timingRecord('high-risk','late-high-inflow','high'));
  assert.equal(timing.score, 21.75);
  assert.equal(timing.signal, 'AVOID');
  assert.ok(timing.reasons.includes('avoid-overbought'));
});

test('missing timing evidence is explicit and never treated as a buy signal', () => {
  const timing = scoreTiming({features:{momentum:{},capital:{}}});
  assert.equal(timing.score, null);
  assert.equal(timing.signal, 'UNKNOWN');
  const timed = withTiming({
    scores:{alpha:80,alphaRaw:80,components:{}},
    features:{momentum:{},capital:{}}
  });
  assert.equal(timed.scores.composite, null);
  assert.equal(timed.timingEligible, false);
});

test('Timing and composite are additive; Alpha score remains unchanged', () => {
  const record = {
    scores:{alpha:80,alphaRaw:80,components:{capital:{contribution:24}}},
    features:{momentum:{trendStage:'startup',overboughtRisk:'normal'},capital:{flowTiming:'early-inflow'}}
  };
  const before = structuredClone(record.scores);
  const timed = withTiming(record);
  assert.deepEqual(timed.scores.alpha, before.alpha);
  assert.deepEqual(timed.scores.alphaRaw, before.alphaRaw);
  assert.deepEqual(timed.scores.components, before.components);
  assert.equal(timed.scores.timing, 90);
  assert.equal(timed.scores.composite, 83);
  assert.notStrictEqual(timed, record);
});

test('composite ranking can reorder execution candidates without mutating Alpha input', () => {
  const input = [
    scoredRecord('600001',[90,90,80,80,80],'high-risk','late-high-inflow','high'),
    scoredRecord('600002',[86,86,80,80,80],'startup','early-inflow','normal')
  ];
  const before = JSON.stringify(input);
  const alphaRank = rankCandidates(input);
  const compositeRank = rankCandidates(input,{sortBy:'composite'});
  assert.deepEqual(alphaRank.map(candidate => candidate.symbol), ['600001','600002']);
  assert.deepEqual(compositeRank.map(candidate => candidate.symbol), ['600002','600001']);
  assert.equal(alphaRank[0].scores.alpha, compositeRank[1].scores.alpha);
  assert.equal(JSON.stringify(input), before);
});

test('candidate flow exposes Alpha, Timing, and composite scores', () => {
  const result = integrateCandidateFlow(flowFixture);
  const top = result.ranking[0];
  assert.equal(top.scores.alpha, 90.02);
  assert.equal(typeof top.scores.timing, 'number');
  assert.equal(typeof top.scores.composite, 'number');
  assert.ok(top.timing.signal);
  assert.ok(top.timingEligible);
});
