import test from 'node:test';
import assert from 'node:assert/strict';
import { assessNextDayLimitUpCandidate, rankNextDayLimitUpCandidates } from '../research/v13-limitup-precursor/next_day_limitup.js';

function makeRow({
  code='600558', name='大西洋', board='SH_MAIN', pct=2.2,
  r3Pct=4.5, r5Pct=8.2, r10Pct=13.4, distHigh20Pct=-2.5,
  volumeExpansion=1.8, closeLocation=0.86,
  recentLimitUp5Count=0, recentLimitUp10Count=1,
  sector=76, marketFit=72, flow=78, flowCount=5,
  flowPositiveShare=0.8, mainNet5=18000000,
  leaderStatus='leader', candidateRank=1,
  catalystScore=null, catalystDirection=null
}={}) {
  return {
    code,name,board,asOf:'2026-10-26',
    currentPct:pct,quote:{pct},
    components:{trend:78,volumePrice:82,flow,sector,marketFit},
    features:{
      r3Pct,r5Pct,r10Pct,distHigh20Pct,volumeExpansion,closeLocation,
      recentLimitUp5Count,recentLimitUp10Count,flowCount,flowPositiveShare,mainNet5
    },
    leaderEvidence:{
      isLeader:leaderStatus==='leader',leaderStatus,candidateRank,
      industryLeaderScore:78,themeHeat:72,themeName:'工业设备'
    },
    psychology:catalystScore===null?{primaryTheme:'工业设备'}:{
      primaryTheme:'工业设备',
      stockNewsFallback:{headlineCatalystScore:catalystScore,headlineCatalystDirection:catalystDirection}
    }
  };
}

test('dual-path rank includes a low-daily-return near-resistance setup that ignition-only gate rejects',()=>{
  const row=makeRow({pct:1.0,distHigh20Pct:-1.8,volumeExpansion:2.1,recentLimitUp5Count:0});
  const result=assessNextDayLimitUpCandidate(row);
  assert.equal(result.passed,true);
  assert.equal(result.path,'PREBREAKOUT');
  assert.equal(result.stage,'NEXT_DAY_PREBREAKOUT_WATCH');
  assert.equal(result.action,'WATCH_NEXT_SESSION_CONFIRMATION');
  assert.equal(result.method,'dual-path-next-session-limit-up-ranking-not-a-calibrated-probability');
  assert.ok(result.components.resistanceProximity>=90);
});

test('continuation path rewards strong close, volume and recent limit-up history',()=>{
  const result=assessNextDayLimitUpCandidate(makeRow({
    pct:6.8,recentLimitUp5Count:1,recentLimitUp10Count:2,volumeExpansion:2.2,closeLocation:0.94
  }));
  assert.equal(result.passed,true);
  assert.equal(result.path,'CONTINUATION');
  assert.ok(result.components.priorLimitUpActivity>60);
  assert.ok(result.score>=65);
});

test('ranking returns both paths and does not promote an already locked limit-up',()=>{
  const result=rankNextDayLimitUpCandidates([
    makeRow({code:'600001',name:'突破观察',pct:1.1,distHigh20Pct:-1.5}),
    makeRow({code:'600002',name:'延续观察',pct:6.8,recentLimitUp5Count:1}),
    makeRow({code:'600003',name:'已涨停',pct:10.0}),
    makeRow({code:'600004',name:'*ST风险股',pct:3.0})
  ],{maxResults:10,minScore:45});
  assert.equal(result.summary.observationOnly,true);
  assert.equal(result.summary.calibratedProbability,false);
  assert.equal(result.summary.entrySignal,false);
  assert.equal(result.summary.returnedCount,2);
  assert.equal(result.summary.continuationCount,1);
  assert.equal(result.summary.prebreakoutCount,1);
  assert.ok(result.assessed.find(row=>row.code==='600003').failedGates.includes('already-at-daily-limit'));
  assert.ok(result.assessed.find(row=>row.code==='600004').failedGates.includes('restricted-listing-name'));
});

test('negative catalyst is penalized and exposed as a risk flag',()=>{
  const base=makeRow({pct:2.5});
  const negative=makeRow({pct:2.5,catalystScore:90,catalystDirection:'negative'});
  const a=assessNextDayLimitUpCandidate(base);
  const b=assessNextDayLimitUpCandidate(negative);
  assert.ok(b.score<a.score);
  assert.ok(b.riskFlags.some(flag=>flag.includes('负面催化')));
});
