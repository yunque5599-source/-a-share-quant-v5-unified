import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreCandidatePsychology, withPsychology,
  PSYCHOLOGY_WEIGHTS
} from '../psychology_score.js';

const hotTheme = {
  code:'BK9001', name:'智能体应用', asOf:'2026-10-16',
  changePct:6, change5dPct:12, prior5dPct:3,
  mainNetPct:5, priorMainNetPct:1,
  upCount:40, downCount:10, flatCount:5, memberCount:55,
  limitUpCount:8, priorLimitUpCount:3,
  leaderCode:'600001', leaderChangePct:8, candidateRank:1,
  narrativeScore:90, narrativeEvidence:['产业催化明确','订单/产品验证持续'],
  imaginationScore:88, imaginationEvidence:['市场空间大','渗透率仍低']
};

const weakTheme = {
  code:'BK9002', name:'弱题材', asOf:'2026-10-16',
  changePct:-4, change5dPct:-3, prior5dPct:2,
  mainNetPct:-4, priorMainNetPct:-1,
  upCount:2, downCount:8, flatCount:40, memberCount:50,
  limitUpCount:0, priorLimitUpCount:1,
  leaderCode:'600009', leaderChangePct:-2, candidateRank:20,
  narrativeScore:30, narrativeEvidence:['催化弱'],
  imaginationScore:25, imaginationEvidence:['空间有限']
};

test('weights sum to 100% and hot leader scores materially higher', () => {
  assert.equal(Object.values(PSYCHOLOGY_WEIGHTS).reduce((a,b)=>a+b,0), 1);
  const hot = scoreCandidatePsychology(
    {symbol:'600001',asOf:'2026-10-16',pct:6,themes:['BK9001']},
    {themes:[hotTheme]}
  );
  const weak = scoreCandidatePsychology(
    {symbol:'600001',asOf:'2026-10-16',pct:-3,themes:['BK9002']},
    {themes:[weakTheme]}
  );
  assert.equal(hot.complete, true);
  assert.equal(hot.primaryTheme.code, 'BK9001');
  assert.ok(hot.score >= 80);
  assert.ok(hot.psychology === undefined);
  assert.equal(weak.complete, true);
  assert.ok(weak.score < 45);
  assert.ok(hot.score > weak.score + 30);
  assert.equal(hot.stage, 'mainstream');
  assert.equal(weak.stage, 'decay');
});

test('missing narrative or imagination never becomes an optimistic psychology score', () => {
  const incomplete = structuredClone(hotTheme);
  delete incomplete.narrativeScore;
  delete incomplete.narrativeEvidence;
  const result = scoreCandidatePsychology(
    {symbol:'600001',asOf:'2026-10-16',themes:['BK9001']},
    {themes:[incomplete]}
  );
  assert.equal(result.score, null);
  assert.equal(result.scoreRaw, null);
  assert.equal(result.complete, false);
  assert.ok(result.reasons.includes('narrative-evidence-missing'));
});

test('future theme snapshots are excluded by as-of chronology', () => {
  const future = {...hotTheme, asOf:'2026-10-17'};
  const result = scoreCandidatePsychology(
    {symbol:'600001',asOf:'2026-10-16',themes:['BK9001']},
    {themes:[future]}
  );
  assert.equal(result.score, null);
  assert.equal(result.primaryTheme, null);
  assert.equal(result.selectionBasis, 'no-theme-match');
});

test('primary theme uses explicit relevance instead of cherry-picking the highest psychology score', () => {
  const hotter = {...hotTheme, code:'BK9003', name:'热点A', relevanceScore:50};
  const primary = {...weakTheme, code:'BK9004', name:'主叙事B', relevanceScore:90};
  const result = scoreCandidatePsychology(
    {symbol:'600001',asOf:'2026-10-16',themes:['BK9003','BK9004']},
    {themes:[hotter, primary]}
  );
  assert.equal(result.primaryTheme.code, 'BK9004');
  assert.equal(result.selectionBasis, 'relevance-score');
});

test('theme-by-symbol context works without duplicating theme references on candidate', () => {
  const result = scoreCandidatePsychology(
    {symbol:'600001',asOf:'2026-10-16',pct:6},
    {themeBySymbol:{'600001':[hotTheme]}}
  );
  assert.equal(result.primaryTheme.code, 'BK9001');
  assert.equal(result.complete, true);
});

test('withPsychology preserves input and exposes canonical score fields', () => {
  const candidate = {
    symbol:'600001', asOf:'2026-10-16',
    scores:{alphaRaw:90},
    themes:['BK9001']
  };
  const before = structuredClone(candidate);
  const result = withPsychology(candidate, {themes:[hotTheme]});
  assert.deepEqual(candidate, before);
  assert.equal(result.scores.alphaRaw, 90);
  assert.equal(result.scores.psychology, result.psychology.score);
  assert.equal(result.scores.psychologyRaw, result.psychology.scoreRaw);
});
