'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { assessPreBreakoutCandidate, rankPreBreakoutCandidates } from '../research/v13-limitup-precursor/pre_breakout.js';

function makeRow({
  code='600001', board='SH_MAIN', currentPct=2.1, r3Pct=2.2, r5Pct=5.5, r20Pct=12,
  distHigh20Pct=-4, distanceMa20Pct=2, range10dPct=5.5, volatilityCompressionRatio=0.62,
  flowPositiveShare=0.8, mainNet5=120000000, mainFlowRatioPct=1.2, flowCount=5,
  trend=80, flow=82, sector=78, marketFit=75, policyScore=85, policyEvidence=true,
  leaderVerified=true, stage='early-base'
}={}) {
  return {
    code, name:'启动前观察样本', board, asOf:'2026-10-26',
    quote:{pct:currentPct},
    source:{barCount:60,historicalFlowCount:flowCount},
    features:{
      r3Pct,r5Pct,r20Pct,distHigh20Pct,flowPositiveShare,mainNet5,mainFlowRatioPct,flowCount
    },
    components:{trend,flow,sector,marketFit,policyAlignment:policyScore},
    policyAlignment:{score:policyScore,evidenceAvailable:policyEvidence,catalogStale:false},
    leaderEvidence:leaderVerified?{isLeader:true,leaderStatus:'leader',themeName:'人工智能/算力',score:88}:null,
    psychology:{primaryTheme:'人工智能/算力'}
  };
}

function early({
  stage='early-base', range10dPct=5.5, volatilityCompressionRatio=0.62,
  distanceMa20Pct=2, baseQuality=82
}={}) {
  return {stage,score:80,confidence:0.9,
    components:{baseQuality},
    metrics:{range10dPct,volatilityCompressionRatio,distanceMa20Pct}};
}

test('pre-breakout watch prioritizes a compressed base near resistance with trend, flow, policy and leader evidence',()=>{
  const row=makeRow();
  const result=assessPreBreakoutCandidate(row,early());
  assert.equal(result.passed,true);
  assert.equal(result.stage,'PREBREAKOUT_LEADER_WATCH');
  assert.equal(result.leaderVerified,true);
  assert.equal(result.policyVerified,true);
  assert.equal(result.evidenceCoverage,result.confidence);
  assert.ok(result.score>=72);
  assert.ok(result.components.resistance>=80);
  assert.equal(result.method,'heuristic-pre-breakout-watch-score-not-a-calibrated-probability');
  assert.equal(result.triggerChecklist.prior20DayHighBroken,false);
  assert.equal(result.triggerChecklist.status,'WAIT_FOR_CLOSE_ABOVE_PRIOR_20D_HIGH_WITH_VOLUME_FLOW_AND_SECTOR_CONFIRMATION');
});

test('pre-breakout ranking labels unverified leader/policy evidence as setup watch, not a confirmed leader',()=>{
  const row=makeRow({policyEvidence:false,leaderVerified:false});
  const result=rankPreBreakoutCandidates([row],new Map([[row.code,early()]]),{maxResults:15,minScore:60});
  assert.equal(result.ranking.length,1);
  assert.equal(result.ranking[0].stage,'PREBREAKOUT_SETUP_WATCH');
  assert.equal(result.summary.verifiedLeaderCount,0);
  assert.equal(result.summary.unverifiedLeaderCount,1);
  assert.equal(result.ranking[0].policyVerified,false);
});

test('pre-breakout watch rejects an already extended or broken-out price instead of chasing it',()=>{
  const extended=makeRow({currentPct:7.2,r5Pct:18});
  const brokenOut=makeRow({code:'600002',distHigh20Pct:1.2});
  const alreadyStarted=makeRow({code:'600003',distHigh20Pct:0.2});
  assert.equal(assessPreBreakoutCandidate(extended,early()).passed,false);
  assert.equal(assessPreBreakoutCandidate(brokenOut,early()).passed,false);
  assert.equal(assessPreBreakoutCandidate(alreadyStarted,early()).passed,false);
});

test('pre-breakout watch rejects persistent downtrends, non-main-board codes, and low-break risk',()=>{
  const downtrend=makeRow({r20Pct:-20});
  const nonMain=makeRow({code:'300001',board:'CHINEXT'});
  const riskyBase=makeRow();
  assert.ok(assessPreBreakoutCandidate(downtrend,early()).failedGates.includes('persistent-downtrend-risk'));
  assert.ok(assessPreBreakoutCandidate(nonMain,early()).failedGates.includes('not-verified-main-board'));
  assert.equal(assessPreBreakoutCandidate(riskyBase,early({stage:'downtrend-risk'})).passed,false);
});

test('pre-breakout watch never fills the shortlist with failed candidates',()=>{
  const rows=[
    makeRow({code:'600010',currentPct:8}),
    makeRow({code:'600011',distHigh20Pct:-20}),
    makeRow({code:'300001',board:'CHINEXT'})
  ];
  const result=rankPreBreakoutCandidates(rows,new Map(rows.map(row=>[row.code,early()])),{maxResults:15,minScore:60});
  assert.equal(result.ranking.length,0);
  assert.equal(result.summary.passedGateCount,0);
  assert.equal(result.summary.emptyListPolicy,'never-fill-watchlist-with-failed-or-extended-candidates');
});


test('missing flow history is not converted into a positive accumulation signal',()=>{
  const row=makeRow({flowCount:0,mainNet5:0,flowPositiveShare:null,mainFlowRatioPct:null});
  row.source.historicalFlowCount=0;
  const result=assessPreBreakoutCandidate(row,early());
  assert.equal(result.metrics.flowObserved,false);
  assert.equal(result.components.capitalAccumulation,null);
  assert.ok(result.failedGates.includes('sustained-flow-evidence-insufficient'));
  assert.equal(result.passed,false);
  assert.equal(result.confidence<1,true);
});


test('industry-relative leadership is a weak ranking proxy and never upgrades an unverified theme leader',()=>{
  const row=makeRow({leaderVerified:false});
  row.leaderEvidence={
    themeName:null,leaderStatus:null,candidateRank:null,score:null,
    industryLeaderScore:92,industryMemberCount:12,source:'ranked-universe-cross-sectional-proxy'
  };
  const result=assessPreBreakoutCandidate(row,early());
  assert.equal(result.passed,true);
  assert.equal(result.leaderVerified,false);
  assert.equal(result.stage,'PREBREAKOUT_SETUP_WATCH');
  assert.equal(result.components.themeLeader,null);
  assert.equal(result.components.industryLeaderProxy,92);
});

test('industry-relative leadership proxy is ignored when peer coverage is too small',()=>{
  const row=makeRow({leaderVerified:false});
  row.leaderEvidence={
    themeName:null,leaderStatus:null,candidateRank:null,score:null,
    industryLeaderScore:99,industryMemberCount:3,source:'ranked-universe-cross-sectional-proxy'
  };
  const result=assessPreBreakoutCandidate(row,early());
  assert.equal(result.leaderVerified,false);
  assert.equal(result.components.industryLeaderProxy,null);
});
