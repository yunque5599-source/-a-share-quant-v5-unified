import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateMarketTransition} from '../research/v16/market_transition.js';
import {scoreSectorRotation} from '../research/v16/sector_rotation.js';
import {buildV16DecisionOverlay} from '../research/v16/decision_overlay.js';

function marketSession(sentiment={}) {
  return {
    date:'2026-11-18',
    breadth:{upRatio:0.62,up:3300,down:1900,flat:100,universe:'full-market',fullMarket:true},
    indices:[
      {key:'shanghai',changePct:0.8,trend5Pct:1.2,trend20Pct:2,aboveMa5:true,aboveMa10:true,aboveMa20:true},
      {key:'shenzhen',changePct:1,trend5Pct:1.5,trend20Pct:2.5,aboveMa5:true,aboveMa10:true,aboveMa20:true},
      {key:'chinext',changePct:1.2,trend5Pct:2,trend20Pct:3,aboveMa5:true,aboveMa10:true,aboveMa20:true},
      {key:'star50',changePct:1.5,trend5Pct:2.2,trend20Pct:3.2,aboveMa5:true,aboveMa10:true,aboveMa20:true}
    ],
    turnover:{amountChangePct:5},
    sentiment:{
      limitUpCount:45,limitDownCount:10,brokenBoardRate:0.2,
      nextDayPremiumPct:0.5,nextDayPositiveRatio:0.6,
      limitLabelQuality:'EASTMONEY_POOL',...sentiment
    },
    sectors:{breadthRatio:0.65,positiveFlowRatio:0.62,topSectorRepeatDays:2,leaderRelativeStrengthPct:1.8,sourceScope:'full-market'},
    leaders:[
      {relativeStrengthPct:1.5,closeLocation:0.8},
      {relativeStrengthPct:1.2,closeLocation:0.75},
      {relativeStrengthPct:1.8,closeLocation:0.82}
    ]
  };
}

test('LHB breadth is a capped market-sentiment input and missing LHB remains missing',()=>{
  const without=evaluateMarketTransition({sessions:[marketSession()],asOf:'2026-11-18'});
  const withLhb=evaluateMarketTransition({sessions:[marketSession({
    lhbPositiveStockRatio:0.8,
    lhbInstitutionalPositiveStockRatio:0.75
  })],asOf:'2026-11-18'});
  assert.ok(withLhb.components.sentiment>without.components.sentiment);
  assert.ok(withLhb.confidence<without.confidence);
});

test('sector LHB breadth only contributes when at least three LHB stocks are observed',()=>{
  const base={
    key:'电子',label:'电子',d1Pct:2,d3Pct:4,d5Pct:6,
    advancersRatio:0.8,positiveFlowRatio:0.75,
    leaderRelativeStrengthPct:2,topSectorRepeatDays:2
  };
  const without=scoreSectorRotation({sectors:[base],market:{d1Pct:0}}).sectors[0];
  const withLhb=scoreSectorRotation({sectors:[{...base,lhbStockCount:4,lhbPositiveRatio:1}],market:{d1Pct:0}}).sectors[0];
  const insufficient=scoreSectorRotation({sectors:[{...base,lhbStockCount:2,lhbPositiveRatio:1}],market:{d1Pct:0}}).sectors[0];
  assert.ok(withLhb.sector_persistence_score>without.sector_persistence_score);
  assert.equal(insufficient.sector_persistence_score,without.sector_persistence_score);
});

test('persistent funding can improve research opportunity but chase risk blocks entry',()=>{
  const base={
    market:{regime:'BULL',trade_permission:'SELECTIVE',confidence:80},
    sectorRotation:{sectors:[{key:'电子',label:'电子',opportunity_score:80}]},
    candidate:{
      code:'002463',name:'样本股',industryKey:'电子',candidateScore:80,
      entryTiming:{pass:true,score:80},
      fundingEvidence:{status:'AVAILABLE',fundingScore:90,mainFlowPositiveDays:3,institutionalPositiveDays:2,trendConfirmed:true,chaseRiskScore:0}
    }
  };
  const allowed=buildV16DecisionOverlay(base);
  assert.equal(allowed.decision,'SELECTIVE_ENTRY');
  assert.equal(allowed.buy_permission,true);
  assert.equal(allowed.funding_evidence_score,90);
  const blocked=buildV16DecisionOverlay({
    ...base,
    candidate:{...base.candidate,fundingEvidence:{...base.candidate.fundingEvidence,chaseRiskScore:90}}
  });
  assert.equal(blocked.decision,'WAIT_FOR_ENTRY');
  assert.equal(blocked.buy_permission,false);
  assert.ok(blocked.reasons.includes('high-turnover-and-price-extension-block-chase-entry'));
});

test('institutional LHB buying without higher lows is explicitly not a bottom signal',()=>{
  const result=buildV16DecisionOverlay({
    market:{regime:'BULL',trade_permission:'SELECTIVE',confidence:80},
    sectorRotation:{sectors:[{key:'电子',label:'电子',opportunity_score:80}]},
    candidate:{
      code:'002463',name:'样本股',industryKey:'电子',candidateScore:80,
      entryTiming:{pass:true,score:80},
      fundingEvidence:{status:'NO_CONFIRMED_PERSISTENCE',fundingScore:null,institutionalPositiveDays:2,trendConfirmed:false,chaseRiskScore:0}
    }
  });
  assert.ok(result.reasons.includes('institutional-buying-without-higher-lows-is-not-a-bottom-signal'));
});
