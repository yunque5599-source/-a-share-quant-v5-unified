'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { assessLimitUpIgnitionCandidate, rankLimitUpIgnitionCandidates } from '../research/v13-limitup-precursor/limitup_ignition.js';

function makeRow({
  code='600558', name='大西洋', board='SH_MAIN', currentPct=2.4,
  r3Pct=4.8, r5Pct=8.1, r10Pct=12.5,
  recentLimitUp5Count=0, recentLimitUp10Count=0,
  closeLocation=0.88, volumeExpansion=1.7,
  sector=74, marketFit=70, flow=72, flowCount=5, flowPositiveShare=0.8,
  mainNet5=12000000, leaderVerified=true, candidateRank=1
}={}) {
  return {
    code,name,board,asOf:'2026-10-26',
    quote:{pct:currentPct},
    components:{trend:78,volumePrice:82,flow,sector,marketFit},
    features:{r3Pct,r5Pct,r10Pct,recentLimitUp5Count,recentLimitUp10Count,closeLocation,volumeExpansion,flowCount,flowPositiveShare,mainNet5},
    leaderEvidence:leaderVerified?{
      isLeader:true,leaderStatus:'leader',candidateRank,themeName:'工业设备'
    }:{isLeader:false,leaderStatus:'unknown',themeName:null},
    psychology:{primaryTheme:'工业设备'}
  };
}

test('continuation lane retains a strong main-board setup even below the strict pre-breakout daily-move gate',()=>{
  const result=assessLimitUpIgnitionCandidate(makeRow());
  assert.equal(result.passed,true);
  assert.equal(result.code,'600558');
  assert.equal(result.stage,'LIMIT_UP_FOLLOW_THROUGH_WATCH');
  assert.equal(result.action,'WATCH_NEXT_SESSION_CONFIRMATION');
  assert.ok(result.score>=70);
  assert.equal(result.method,'heuristic-continuation-ranking-not-a-calibrated-limit-up-probability');
});

test('continuation lane can include stronger first-leg momentum without calling it a buy signal',()=>{
  const result=assessLimitUpIgnitionCandidate(makeRow({
    code:'002434',name:'万里扬',currentPct:8.4,r3Pct:12,r5Pct:17,
    closeLocation:0.93,volumeExpansion:2.2,leaderVerified:false,flowCount:2
  }));
  assert.equal(result.passed,true);
  assert.ok(result.riskFlags.includes('当日涨幅已高，次日高开和追涨风险增加'));
  assert.equal(result.action,'WATCH_NEXT_SESSION_CONFIRMATION');
});

test('already limit-up, restricted-name and persistent short-term downtrend rows are not promoted',()=>{
  const atLimit=assessLimitUpIgnitionCandidate(makeRow({currentPct:10}));
  const restricted=assessLimitUpIgnitionCandidate(makeRow({name:'ST样本'}));
  const downtrend=assessLimitUpIgnitionCandidate(makeRow({r3Pct:-4,r5Pct:-6,closeLocation:0.3,volumeExpansion:0.6}));
  assert.equal(atLimit.passed,false);
  assert.ok(atLimit.failedGates.includes('already-at-daily-limit'));
  assert.equal(restricted.passed,false);
  assert.ok(restricted.failedGates.includes('restricted-listing-name'));
  assert.equal(downtrend.passed,false);
  assert.ok(downtrend.failedGates.includes('short-term-trend-negative'));
});

test('board-specific daily-limit thresholds are respected for ChiNext and STAR',()=>{
  const growth=assessLimitUpIgnitionCandidate(makeRow({
    code:'300001',board:'CHINEXT',name:'创业板样本',currentPct:15.2
  }));
  const starAtLimit=assessLimitUpIgnitionCandidate(makeRow({
    code:'688001',board:'STAR',name:'科创板样本',currentPct:20
  }));
  assert.equal(growth.passed,true);
  assert.equal(growth.board,'CHINEXT');
  assert.equal(starAtLimit.passed,false);
  assert.ok(starAtLimit.failedGates.includes('already-at-daily-limit'));
});

test('ranking returns only passing candidates and exposes observation-only summary',()=>{
  const rows=[
    makeRow(),
    makeRow({code:'600559',name:'弱势样本',currentPct:2,r3Pct:-4,r5Pct:-6,closeLocation:0.25,volumeExpansion:0.5}),
    makeRow({code:'600560',name:'次强样本',currentPct:5.2,leaderVerified:false,sector:58,marketFit:55,flow:57})
  ];
  const result=rankLimitUpIgnitionCandidates(rows,{maxResults:5,minScore:52});
  assert.ok(result.ranking.length>=1);
  assert.ok(result.ranking.every(row=>row.passed&&row.score>=52));
  assert.equal(result.summary.observationOnly,true);
  assert.equal(result.summary.calibratedProbability,false);
  assert.equal(result.summary.entrySignal,false);
});


test('recent limit-up activity improves continuation ranking but adds a divergence-risk warning', () => {
  const noPriorLimit = assessLimitUpIgnitionCandidate(makeRow({
    recentLimitUp5Count:0, recentLimitUp10Count:0
  }));
  const activePriorLimit = assessLimitUpIgnitionCandidate(makeRow({
    recentLimitUp5Count:2, recentLimitUp10Count:3
  }));
  assert.equal(noPriorLimit.passed,true);
  assert.equal(activePriorLimit.passed,true);
  assert.ok(activePriorLimit.score > noPriorLimit.score);
  assert.ok(activePriorLimit.components.priorLimitUpActivity > noPriorLimit.components.priorLimitUpActivity);
  assert.ok(activePriorLimit.riskFlags.some(flag => flag.includes('多次涨停')));
  assert.equal(activePriorLimit.evidence.recentLimitUp5Count,2);
});

test('first-time ignition remains eligible when prior limit-up history is unavailable', () => {
  const row = makeRow({recentLimitUp5Count:null,recentLimitUp10Count:null});
  const result = assessLimitUpIgnitionCandidate(row);
  assert.equal(result.passed,true);
  assert.equal(result.evidence.priorLimitUpScore,null);
  assert.ok(result.score > 0);
});
