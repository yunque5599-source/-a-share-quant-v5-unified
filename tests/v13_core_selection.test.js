'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { assessCoreSelectionCandidate, rankCoreSelection } from '../research/v13-limitup-precursor/core_selection.js';

function makeRow({
  code='600001',
  name='核心样本股',
  score=78,
  r3Pct=4.2,
  r5Pct=12,
  currentPct=3.2,
  trend=80,
  volumePrice=78,
  flow=80,
  sector=82,
  marketFit=78,
  policyScore=90,
  policyEvidence=true,
  leaderStatus='leader',
  candidateRank=1,
  themeName='人工智能/算力',
  mainNet5=120000000,
  mainFlowRatioPct=2.1,
  flowPositiveShare=0.8,
  flowCount=5,
  amount5Avg=150000000,
  atrProxyPct=2.5,
  closeLocation=0.75,
  marketRegime='risk-on',
  marketFitLabel='风险偏好回升',
  currentGapPct=1
}={}) {
  return {
    code,name,score,confidence:85,
    quote:{price:20,pct:currentPct,amount:200000000},
    source:{barCount:60,historicalFlowCount:flowCount},
    components:{trend,volumePrice,flow,sector,marketFit,policyAlignment:policyScore},
    policyAlignment:{score:policyScore,evidenceAvailable:policyEvidence,catalogStale:false,matchedThemes:[]},
    marketRegime:{regime:marketRegime,label:marketFitLabel,dataQuality:'multi-index-and-broad-quote-proxy'},
    leaderEvidence:{
      themeName,leaderStatus,candidateRank,industryLeaderScore:94,
      themeHeat:82,themeBreadth:0.72,themeLimitUpCount:4
    },
    features:{
      r3Pct,r5Pct,r10Pct:r5Pct+2,r20Pct:18,
      distHigh20Pct:-2,distLow20Pct:15,
      atrProxyPct,gapPct:currentGapPct,closeLocation,
      flowCount,mainNet5,mainNet3:mainNet5*0.55,
      mainFlowRatioPct,flowPositiveShare,amount5Avg,amount:amount5Avg,
      turnoverRate:6.2,barCount:60,volumeExpansion:1.7
    },
    psychology:{primaryTheme:themeName,leaderStatus,candidateRank,positiveHeadlineCount:2,negativeHeadlineCount:0},
    riskFlags:[]
  };
}

test('four-layer selector admits a policy-aligned theme leader only with sustained inflow and acceptable risk/reward',()=>{
  const leader=makeRow({code:'600001',r5Pct:12});
  const peers=[
    makeRow({code:'600002',name:'弱资金样本',score:70,r5Pct:5,mainNet5:-30000000,mainFlowRatioPct:-0.4,flowPositiveShare:0.2,leaderStatus:'follower',candidateRank:7,policyScore:82}),
    makeRow({code:'600003',name:'弱趋势样本',score:55,r5Pct:-2,trend:42,volumePrice:45,flow:42,sector:40,marketFit:42,policyScore:85,leaderStatus:'follower',candidateRank:9})
  ];
  const result=rankCoreSelection([leader,...peers],{
    marketRegime:leader.marketRegime,
    eligibleCodes:new Set(['600001','600002','600003']),
    maxResults:5
  });
  assert.equal(result.ranking.length,1);
  assert.equal(result.ranking[0].code,'600001');
  assert.equal(result.ranking[0].selection.eligible,true);
  assert.equal(result.ranking[0].selection.decision,'CORE_WATCH');
  assert.ok(result.ranking[0].selection.passedGates.includes('policy-direction'));
  assert.ok(result.ranking[0].selection.passedGates.includes('theme-leader'));
  assert.ok(result.ranking[0].selection.passedGates.includes('sustained-capital-flow'));
  assert.ok(result.ranking[0].riskReward.rewardRiskRatio>=1.25);
});

test('policy alignment alone cannot promote a follower with negative or non-persistent capital flow',()=>{
  const row=makeRow({
    policyScore:98,policyEvidence:true,leaderStatus:'follower',candidateRank:8,
    mainNet5:-50000000,mainFlowRatioPct:-1.5,flowPositiveShare:0.2
  });
  row.leaderEvidence.industryLeaderScore=48;
  row.leaderEvidence.themeHeat=42;
  row.leaderEvidence.themeBreadth=0.3;
  row.leaderEvidence.themeLimitUpCount=0;
  const result=assessCoreSelectionCandidate(row,{relativeStrengthPercentile:95});
  assert.equal(result.selection.eligible,false);
  assert.ok(result.selection.failedGates.some(g=>g.key==='theme-leader'));
  assert.ok(result.selection.failedGates.some(g=>g.key==='sustained-capital-flow'));
});

test('risk-off market applies higher trend, flow, market-fit and relative-strength thresholds',()=>{
  const row=makeRow({
    marketRegime:'risk-off',marketFitLabel:'防守/风险偏好下降',
    trend:60,flow:60,marketFit:60,r5Pct:8
  });
  const result=assessCoreSelectionCandidate(row,{relativeStrengthPercentile:75});
  assert.equal(result.selection.eligible,false);
  assert.ok(result.selection.failedGates.some(g=>g.key==='trend'));
  assert.ok(result.selection.failedGates.some(g=>g.key==='sustained-capital-flow'));
  assert.ok(result.selection.failedGates.some(g=>g.key==='market-regime'));
  assert.ok(result.selection.failedGates.some(g=>g.key==='relative-strength'));
});

test('overheated price action and poor reward/risk are rejected rather than placed in the core list',()=>{
  const overheated=makeRow({currentPct:8.1,currentGapPct:4.5,atrProxyPct:6.2,r5Pct:21});
  const result=assessCoreSelectionCandidate(overheated,{relativeStrengthPercentile:98});
  assert.equal(result.selection.eligible,false);
  assert.ok(result.selection.failedGates.some(g=>g.key==='chase-control'));
  assert.ok(result.selection.failedGates.some(g=>g.key==='overnight-risk'));
});

test('the selector returns an empty primary list instead of filling slots with failed candidates',()=>{
  const a=makeRow({code:'600010',r5Pct:10,policyEvidence:false});
  const b=makeRow({code:'600011',r5Pct:4,mainNet5:-20000000,mainFlowRatioPct:-0.3,flowPositiveShare:0.1});
  const result=rankCoreSelection([a,b],{
    marketRegime:a.marketRegime,
    eligibleCodes:new Set(['600010','600011']),
    maxResults:5
  });
  assert.equal(result.ranking.length,0);
  assert.equal(result.summary.eligibleCount,0);
  assert.equal(result.summary.emptyListPolicy,'never-fill-shortlist-with-failed-candidates');
});

test('the upstream pre-limit-up gate is respected even when every score component is strong',()=>{
  const row=makeRow({code:'600020'});
  const result=rankCoreSelection([row],{
    marketRegime:row.marketRegime,
    eligibleCodes:new Set(),
    maxResults:5
  });
  assert.equal(result.ranking.length,0);
  assert.ok(result.assessed[0].selection.failedGates.some(g=>g.key==='pre-limit-up-risk-filter'));
});
