import test from 'node:test';
import assert from 'node:assert/strict';
import { selectV12Candidates } from '../v12_universe.js';

test('V12 deep universe is main-board only and deduplicated', () => {
  const rows = [
    {f12:'600001',rankScore:100,ranks:{mainNet:20,dayMomentum:20,swingMomentum:20,mainPct:20}},
    {f12:'000001',rankScore:99,ranks:{mainNet:19,dayMomentum:19,swingMomentum:19,mainPct:19}},
    {f12:'300001',rankScore:98,ranks:{mainNet:1,dayMomentum:1,swingMomentum:1,mainPct:1}},
    {f12:'600001',rankScore:97,ranks:{mainNet:1,dayMomentum:1,swingMomentum:1,mainPct:1}}
  ];
  const result = selectV12Candidates(rows, 30);
  assert.deepEqual(result.map(row => row.f12), ['600001','000001']);
});

test('V12 selection preserves independent capital and momentum leaders', () => {
  const rows = Array.from({length:40}, (_, i) => ({
    f12:String(600000 + i).padStart(6,'0'),
    rankScore:100-i,
    ranks:{
      mainNet:i+20,
      dayMomentum:i+20,
      swingMomentum:i+20,
      mainPct:i+20
    }
  }));
  rows[30].ranks.mainNet = 1;
  rows[31].ranks.dayMomentum = 1;
  rows[32].ranks.swingMomentum = 1;
  rows[33].ranks.mainPct = 1;
  const result = selectV12Candidates(rows, 30).map(row => row.f12);
  assert.ok(result.includes(rows[30].f12));
  assert.ok(result.includes(rows[31].f12));
  assert.ok(result.includes(rows[32].f12));
  assert.ok(result.includes(rows[33].f12));
});
