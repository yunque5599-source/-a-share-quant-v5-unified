import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { integrateCandidateFlow } from '../candidate_flow.js';

const fixture = JSON.parse(await readFile(
  new URL('./fixtures/v11_flow.json', import.meta.url), 'utf8'
));

const psychology = {
  themeBySymbol:{
    '600001':[{
      code:'BK9001', name:'强主线', asOf:'2026-04-03',
      changePct:6, change5dPct:12, prior5dPct:3,
      mainNetPct:5, priorMainNetPct:1,
      upCount:40, downCount:10, flatCount:5, memberCount:55,
      limitUpCount:8, priorLimitUpCount:3,
      leaderCode:'600001', leaderChangePct:8, candidateRank:1,
      narrativeScore:90, narrativeEvidence:['明确产业催化'],
      imaginationScore:88, imaginationEvidence:['空间大']
    }],
    '000002':[{
      code:'BK9002', name:'弱题材', asOf:'2026-04-03',
      changePct:-4, change5dPct:-3, prior5dPct:2,
      mainNetPct:-4, priorMainNetPct:-1,
      upCount:2, downCount:8, flatCount:40, memberCount:50,
      limitUpCount:0, priorLimitUpCount:1,
      leaderCode:'600009', leaderChangePct:-2, candidateRank:20,
      narrativeScore:30, narrativeEvidence:['催化弱'],
      imaginationScore:25, imaginationEvidence:['空间有限']
    }]
  }
};

test('candidate flow attaches psychology without changing the legacy Alpha ranking contract', () => {
  const input = structuredClone(fixture);
  input.ranked.data.candidates = input.ranked.data.candidates.filter(row => row.f12 === '600001');
  input.deep.items = input.deep.items.filter(row => row.code === '600001');
  input.psychology = {themeBySymbol:{'600001':psychology.themeBySymbol['600001']}};
  const result = integrateCandidateFlow(input);
  assert.equal(result.version, 'V11 Short Alpha Phase 1');
  assert.equal(result.schema, 'v11-short-alpha-flow-v1');
  assert.equal(result.diagnostics.psychologyComplete, 1);
  assert.equal(result.diagnostics.v12Eligible, 1);
  assert.equal(result.ranking.length, 1);
  assert.ok(result.ranking.every(row => row.psychology?.complete === true));
  assert.equal(result.tradeRanking.length, 1);
  assert.equal(result.tradeRanking[0].symbol, '600001');
  assert.equal(result.tradeRanking[0].tradeRank, 1);
  assert.ok(result.tradeRanking[0].scores.v12TradeRaw >
    result.tradeRanking[1].scores.v12TradeRaw);
});

test('without psychology evidence V11 remains usable but V12 trade ranking stays empty', () => {
  const result = integrateCandidateFlow(fixture);
  assert.equal(result.ranking.length, 2);
  assert.equal(result.tradeRanking.length, 0);
  assert.equal(result.diagnostics.psychologyComplete, 0);
  assert.equal(result.diagnostics.v12Eligible, 0);
});
