import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreNarrativeResearch, scoreImaginationResearch, attachResearchScores
} from '../psychology_research.js';

const completeResearch = {
  narrativeResearch:{
    novelty:90, credibility:85, propagation:80, persistence:75, expectationGap:88,
    evidence:['政策/产业催化原文','多家媒体持续讨论']
  },
  imaginationResearch:{
    marketSize:92, penetrationGap:86, policyRunway:80,
    technologyOptionality:90, companyCapture:78,
    evidence:['行业空间测算','渗透率仍低']
  }
};

test('structured research produces bounded narrative and imagination scores', () => {
  const n = scoreNarrativeResearch(completeResearch);
  const i = scoreImaginationResearch(completeResearch);
  assert.equal(n.complete, true);
  assert.equal(i.complete, true);
  assert.ok(n.score >= 75 && n.score <= 100);
  assert.ok(i.score >= 75 && i.score <= 100);
  assert.equal(n.evidence.length, 2);
  assert.equal(i.evidence.length, 2);
});

test('missing evidence prevents a research block from being treated as complete', () => {
  const input = structuredClone(completeResearch);
  delete input.narrativeResearch.expectationGap;
  input.narrativeResearch.evidence = [];
  const n = scoreNarrativeResearch(input);
  assert.equal(n.complete, false);
  assert.equal(n.score, null);
  assert.ok(n.confidence < 0.8);
});

test('scores are clamped and malformed fields do not create fake certainty', () => {
  const input = {
    narrativeResearch:{
      novelty:999, credibility:-20, propagation:50, persistence:50, expectationGap:'bad',
      evidence:['one','two']
    },
    imaginationResearch:{
      marketSize:120, penetrationGap:80, policyRunway:80,
      technologyOptionality:80, companyCapture:80, evidence:['one','two']
    }
  };
  const n = scoreNarrativeResearch(input);
  const i = scoreImaginationResearch(input);
  assert.equal(n.complete, false);
  assert.equal(n.score, null);
  assert.equal(i.complete, true);
  assert.ok(i.score <= 100);
});

test('attachResearchScores writes only evidence-backed fields', () => {
  const result = attachResearchScores(completeResearch);
  assert.ok(result.narrativeScore > 0);
  assert.ok(result.imaginationScore > 0);
  assert.equal(result.researchQuality.narrative.complete, true);
  assert.equal(result.researchQuality.imagination.complete, true);
});
