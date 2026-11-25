import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyVolumePricePhase} from '../research/v16/volume_price_phase.js';
const AS_OF='2026-11-25T20:30:00+08:00',SOURCE='eastmoney-kline-fixture';
function dates(end='2026-11-25',count=65) {
  const cursor=new Date(end+'T00:00:00Z'),result=[];
  while(result.length<count){const day=cursor.getUTCDay();if(day!==0&&day!==6)result.push(cursor.toISOString().slice(0,10));cursor.setUTCDate(cursor.getUTCDate()-1);}
  return result.reverse();
}
function baseBars(){return dates().map((date,index)=>{const close=10+index*0.001;return {
  date,source:SOURCE,availableAt:date+'T15:05:00+08:00',open:close-0.005,
  high:close+0.03,low:close-0.03,close,volume:1000,amount:100000
};});}
function setBar(bar,{open,high,low,close,volume}){Object.assign(bar,{open,high,low,close,volume,amount:volume*100});}
function impulseThenPullback(){
  const bars=baseBars();
  setBar(bars.at(-5),{open:10.0,high:10.6,low:9.98,close:10.5,volume:2500});
  setBar(bars.at(-4),{open:10.5,high:10.55,low:10.4,close:10.45,volume:750});
  setBar(bars.at(-3),{open:10.45,high:10.48,low:10.35,close:10.4,volume:700});
  setBar(bars.at(-2),{open:10.39,high:10.46,low:10.38,close:10.42,volume:750});
  setBar(bars.at(-1),{open:10.43,high:10.45,low:10.38,close:10.41,volume:700});
  return bars;
}
test('identifies an early high-volume breakout without creating a buy instruction',()=>{
  const bars=baseBars();setBar(bars.at(-1),{open:10.2,high:10.58,low:10.18,close:10.52,volume:1800});
  const result=classifyVolumePricePhase(bars,{asOf:AS_OF});
  assert.equal(result.status,'AVAILABLE');assert.equal(result.classification,'EARLY_BREAKOUT');
  assert.equal(result.usedForSelection,false);assert.equal(result.mainScoreAdjustment,0);
});
test('identifies constructive pullback only when declining volume contracts and support holds',()=>{
  const result=classifyVolumePricePhase(impulseThenPullback(),{asOf:AS_OF,breakoutLevel:10.4});
  assert.equal(result.status,'AVAILABLE');assert.equal(result.classification,'CONSTRUCTIVE_PULLBACK');
  assert.equal(result.metrics.supportHeld,true);assert.equal(result.metrics.downVolumeContracted,true);
  assert.ok(result.metrics.pullbackDepthPct>0&&result.metrics.pullbackDepthPct<8);
});
test('identifies reacceleration after a contracted pullback and a high-volume reclaim',()=>{
  const bars=impulseThenPullback();setBar(bars.at(-1),{open:10.42,high:10.58,low:10.4,close:10.54,volume:1800});
  const result=classifyVolumePricePhase(bars,{asOf:AS_OF,breakoutLevel:10.4});
  assert.equal(result.status,'AVAILABLE');assert.equal(result.classification,'REACCELERATION');
});
test('identifies distribution risk when price loses breakout support on heavy volume',()=>{
  const bars=impulseThenPullback();
  setBar(bars.at(-4),{open:10.5,high:10.55,low:10.25,close:10.3,volume:3000});
  setBar(bars.at(-3),{open:10.3,high:10.32,low:10.05,close:10.1,volume:3200});
  setBar(bars.at(-2),{open:10.1,high:10.15,low:9.95,close:10.0,volume:3500});
  setBar(bars.at(-1),{open:10.0,high:10.05,low:9.8,close:9.9,volume:3300});
  const result=classifyVolumePricePhase(bars,{asOf:AS_OF,breakoutLevel:10.4});
  assert.equal(result.status,'AVAILABLE');assert.equal(result.classification,'DISTRIBUTION_RISK');
});
test('future bars and bars without point-in-time source metadata are excluded',()=>{
  const bars=baseBars();bars.push({...bars.at(-1),date:'2026-11-26',availableAt:'2026-11-26T15:05:00+08:00'});
  bars[0]={...bars[0],source:'',availableAt:'2026-11-25T21:00:00+08:00'};
  const result=classifyVolumePricePhase(bars,{asOf:AS_OF});
  assert.equal(result.status,'AVAILABLE');assert.equal(result.latestBarDate,'2026-11-25');assert.equal(result.visibleBarCount,64);
});
test('duplicate, stale and insufficient bars fail closed',()=>{
  const duplicate=baseBars();duplicate.push({...duplicate.at(-1)});
  assert.equal(classifyVolumePricePhase(duplicate,{asOf:AS_OF}).status,'PARTIAL');
  const stale=baseBars();stale.at(-1).date='2026-11-24';
  assert.equal(classifyVolumePricePhase(stale,{asOf:AS_OF}).status,'PARTIAL');
  assert.equal(classifyVolumePricePhase(baseBars().slice(-20),{asOf:AS_OF}).status,'NOT_MEASURABLE');
});


test('uses the explicit last completed session when asOf is the following morning',()=>{
  const bars=baseBars();
  const result=classifyVolumePricePhase(bars,{
    asOf:'2026-11-26T09:20:00+08:00',expectedDate:'2026-11-25'
  });
  assert.equal(result.status,'AVAILABLE');
  assert.equal(result.latestBarDate,'2026-11-25');
});
