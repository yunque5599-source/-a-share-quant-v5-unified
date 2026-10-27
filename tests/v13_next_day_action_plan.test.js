import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNextDayActionPlan } from '../research/v13-limitup-precursor/next_day_action_plan.js';

function snap({id,available=true,rankings={},candidates=[]}={}) {
  return {
    snapshotId:id ?? 'snapshot',
    capturedAt:id === 'yesterday' ? '2026-10-26T05:00:00.000Z' : '2026-10-27T05:00:00.000Z',
    recommendationsAvailable:available,
    rankings,
    candidates
  };
}

test('current main-board candidate near limit-up is logged as materialized, not a chase entry', () => {
  const current = snap({
    id:'today',
    rankings:{overall:[{rank:1,code:'600558',name:'大西洋',score:82,entryEligible:true,quote:{pct:10.07}}]},
    candidates:[{code:'600558',name:'大西洋',quote:{pct:10.07}}]
  });
  const plan = buildNextDayActionPlan(current);
  assert.equal(plan.status,'CURRENT_ONLY_NO_PRIOR_SNAPSHOT');
  assert.equal(plan.currentActions[0].action,'MOVE_MATERIALIZED_NO_CHASE');
  assert.match(plan.currentActions[0].reason,/等待下一交易日重新评估/);
});

test('prior-day Atlantic pick is recognized as a follow-through event when current move reaches limit', () => {
  const previous = snap({
    id:'yesterday',
    rankings:{overall:[{rank:2,code:'600558',name:'大西洋',score:71}]}
  });
  const current = snap({
    id:'today',
    rankings:{overall:[{rank:1,code:'600558',name:'大西洋',score:82,entryEligible:false,quote:{pct:10.07}}]},
    candidates:[{code:'600558',name:'大西洋',quote:{pct:10.07}}]
  });
  const plan = buildNextDayActionPlan(current, previous);
  assert.equal(plan.status,'CURRENT_AND_PRIOR_REVIEW');
  assert.equal(plan.priorDayFollowThrough.length,1);
  assert.equal(plan.priorDayFollowThrough[0].followThrough,'LIMIT_UP_OR_NEAR_LIMIT');
  assert.equal(plan.priorDayFollowThrough[0].action,'NO_CHASE');
  assert.equal(plan.summary.priorLimitUpOrNearLimit,1);
});

test('a weak current move triggers reassessment rather than automatic averaging down', () => {
  const current = snap({
    id:'today',
    rankings:{overall:[{rank:1,code:'000156',name:'华数传媒',score:58,quote:{pct:-2.6}}]},
    candidates:[{code:'000156',name:'华数传媒',quote:{pct:-2.6}}]
  });
  const plan = buildNextDayActionPlan(current);
  assert.equal(plan.currentActions[0].action,'WEAKENED_REASSESS_RISK');
  assert.match(plan.currentActions[0].reason,/不因排名靠前而追价|支撑位/);
});

test('previous picks remain assessable even when absent from current top-ranked lists', () => {
  const previous = snap({
    id:'yesterday',
    rankings:{overall:[{rank:3,code:'600558',name:'大西洋',score:70}]}
  });
  const current = snap({
    id:'today',
    rankings:{overall:[{rank:1,code:'000156',name:'华数传媒',score:62,quote:{pct:-2.6}}]},
    candidates:[
      {code:'000156',name:'华数传媒',quote:{pct:-2.6}},
      {code:'600558',name:'大西洋',quote:{pct:1.2},score:{score:65,entryEligible:false,entryGateReasons:['flow-weak']}}
    ]
  });
  const plan = buildNextDayActionPlan(current, previous);
  assert.equal(plan.priorDayFollowThrough[0].code,'600558');
  assert.equal(plan.priorDayFollowThrough[0].followThrough,'STABLE_OR_POSITIVE');
  assert.equal(plan.priorDayFollowThrough[0].currentPct,1.2);
});

test('missing current candidate is marked not reassessed, not assumed to have failed', () => {
  const previous = snap({id:'yesterday',rankings:{overall:[{rank:1,code:'600558',name:'大西洋',score:70}]}});
  const current = snap({id:'today',rankings:{overall:[{rank:1,code:'000156',name:'华数传媒',score:60,quote:{pct:-1}}]}});
  const plan = buildNextDayActionPlan(current, previous);
  assert.equal(plan.priorDayFollowThrough[0].followThrough,'NOT_REASSESSED');
});

test('source-quality failure suppresses actionable current decisions', () => {
  const previous = snap({id:'yesterday',rankings:{overall:[{rank:1,code:'600558',name:'大西洋',score:70}]}});
  const current = snap({id:'today',available:false,rankings:{overall:[{rank:1,code:'600558',name:'大西洋',score:80,quote:{pct:10}}]}});
  const plan = buildNextDayActionPlan(current, previous);
  assert.equal(plan.status,'SOURCE_UNAVAILABLE');
  assert.equal(plan.currentActions[0].action,'SOURCE_UNAVAILABLE');
  assert.equal(plan.priorDayFollowThrough[0].followThrough,'CURRENT_SOURCE_UNAVAILABLE');
});

test('a qualified moderate-move candidate waits for a trigger instead of auto-buying', () => {
  const current = snap({
    id:'today',
    rankings:{overall:[{rank:1,code:'600558',name:'大西洋',score:75,entryEligible:true,quote:{pct:3.2}}]}
  });
  const plan = buildNextDayActionPlan(current);
  assert.equal(plan.currentActions[0].action,'ENTRY_TRIGGER_WATCH');
  assert.match(plan.currentActions[0].reason,/不是自动买入指令/);
});
