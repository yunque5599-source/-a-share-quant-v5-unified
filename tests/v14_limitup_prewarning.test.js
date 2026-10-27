import test from 'node:test';
import assert from 'node:assert/strict';
import {labelLimitUpHorizon,limitRuleFor} from '../research/v13-limitup-precursor/v14_limitup_labels.js';
import {scorePreLimitUp} from '../research/v13-limitup-precursor/v14_prewarning_score.js';
import {inspectIntradayCapability,scoreIntradayWarning} from '../research/v13-limitup-precursor/v14_intraday_warning.js';
import {evaluateWalkForward} from '../research/v13-limitup-precursor/v14_walk_forward.js';

const bars=(closes,dates=closes.map((_,i)=>'2026-10-'+String(i+1).padStart(2,'0')))=>closes.map((close,i)=>[dates[i],close,close,close*1.01,close*.99,100].join(','));
test('dynamic board rules and first future limit-up label exclude prior limit-ups',()=>{
 const row=labelLimitUpHorizon({code:'600001',asOf:'2026-10-02',bars:bars([10,10.1,10.2,11.22,11.3])});
 assert.equal(row.status,'COMPLETE');assert.equal(row.firstLimitUpHorizon,'T+2');assert.equal(row.priorLimitUpBeforeSignal,false);assert.equal(row.futureLimitUpWithin2,true);
 const prior=labelLimitUpHorizon({code:'600001',asOf:'2026-10-03',bars:bars([10,11.0,11.1,12.2,12.3])});
 assert.equal(prior.priorLimitUpBeforeSignal,true);
 assert.equal(limitRuleFor({code:'300001'}).limitPct,20);assert.equal(limitRuleFor({code:'600001',isST:true}).limitPct,5);
});
test('new listing rule is not fabricated',()=>assert.equal(limitRuleFor({code:'600001',listingDate:'2026-10-01',asOf:'2026-10-03'}).status,'SPECIAL_RULE_UNAVAILABLE'));
test('prewarning keeps missing flow and sector evidence explicit',()=>{
 const x=scorePreLimitUp({code:'600001',asOf:'2026-10-02',features:{r3Pct:3,r5Pct:5,r10Pct:8,distHigh20Pct:-2,volumeExpansion:1.6},components:{trend:70,volumePrice:72}});
 assert.equal(x.evidence.flow,false);assert.equal(x.evidence.sector,false);assert.ok(x.reasons.includes('capital-flow-evidence-missing'));assert.ok(x.reasons.includes('sector-evidence-missing'));
});
test('intraday channel fails closed without minute history and rejects future bars',()=>{
 const a=inspectIntradayCapability({asOf:'2026-10-27'});assert.equal(a.status,'DATA_CAPABILITY_INSUFFICIENT');
 const b=scoreIntradayWarning({asOf:'2026-10-27',minuteBars:[]});assert.equal(b.entryEligible,false);
 const c=inspectIntradayCapability({asOf:'2026-10-27',minuteBars:[{timestamp:'2026-10-28T01:00:00Z',close:10}]});assert.equal(c.status,'INVALID_INTRADAY_INPUT');
});
test('chronological walk-forward reports Top10/30/50 and frozen parameters',()=>{
 const rows=[];for(let d=1;d<=8;d++){const date='2026-09-'+String(d).padStart(2,'0');for(let s=1;s<=60;s++){rows.push({asOf:date,code:String(600000+s),features:{r3Pct:s%10,r5Pct:s%15,r10Pct:s%20,distHigh20Pct:-s/10,volumeExpansion:1+s/20},components:{trend:s,volumePrice:s}});}}
 const report=evaluateWalkForward(rows,{trainFraction:.5});assert.equal(report.walkForward.randomSplit,false);assert.ok(report.strategies.preLimitUp.dates.length>0);assert.ok(report.strategies.preLimitUp.dates[0].topK.top10);assert.ok(report.strategies.preLimitUp.dates[0].topK.top30);assert.ok(report.strategies.preLimitUp.dates[0].topK.top50);
});
