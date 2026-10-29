import test from 'node:test';
import assert from 'node:assert/strict';
import {selectCandidateFunnel} from '../research/v13-limitup-precursor/live_snapshot.js';
import {assessExtremeDisagreement,rankExtremeDisagreement} from '../research/v13-limitup-precursor/extreme_disagreement_reversal.js';
test('large down high turnover remains discoverable in an independent funnel lane',()=>{
 const rows=Array.from({length:180},(_,i)=>({f12:'600'+String(i).padStart(3,'0'),f14:'普通样本'+i,f2:10,f3:1,f8:5,f10:1.1,f62:1000,rankScore:80-i}));
 rows.push({f12:'000530',f14:'冰山样本',f2:7.5,f3:-8.5,f8:32,f10:3.2,f62:-10000000,rankScore:1});
 const picked=selectCandidateFunnel(rows,120).find(x=>x.f12==='000530');
 assert.ok(picked);assert.ok(picked.funnelLanes.includes('extreme-disagreement-reversal'));
});
test('drawdown and turnover without stabilization is observation-only',()=>{
 const x=assessExtremeDisagreement({code:'000530',name:'样本',asOf:'2026-10-28',currentPct:-8,quote:{pct:-8,turnoverRate:30},features:{r5Pct:12,r10Pct:20,volumeExpansion:3,flowCount:0,sectorFieldsPresent:0},components:{trend:30,volumePrice:30}});
 assert.equal(x.status,'EXTREME_DISAGREEMENT_UNCONFIRMED');assert.equal(x.reversalConfirmed,false);assert.equal(x.entryEligible,false);assert.ok(x.riskFlags.includes('capital-flow-evidence-missing'));
});
test('stabilization plus prior strength and evidence can confirm research reversal without entry permission',()=>{
 const x=assessExtremeDisagreement({code:'000530',name:'样本',asOf:'2026-10-28',currentPct:-1,quote:{pct:-1,turnoverRate:28},features:{r3Pct:2,r5Pct:12,r10Pct:20,volumeExpansion:1.8,closeLocation:.7,flowCount:5,flowPositiveShare:.8,mainNet5:100000,sectorFieldsPresent:3},components:{trend:70,volumePrice:70,flow:75,sector:72}});
 assert.equal(x.status,'REVERSAL_CONFIRMED');assert.equal(x.reversalConfirmed,true);assert.equal(x.entryEligible,false);
});
test('duplicate channel candidates are ranked once',()=>{
 const x=rankExtremeDisagreement([{code:'000530',name:'A',currentPct:-8,features:{flowCount:0,volumeExpansion:3},components:{}} ,{code:'000530',name:'A',currentPct:-8,features:{flowCount:0,volumeExpansion:3},components:{}}],10);
 assert.equal(x.length,2);
});
