import test from 'node:test';
import assert from 'node:assert/strict';
import { backfillSnapshot } from '../backfill_v12_outcomes.js';

const asOf = '2026-10-01T03:15:00Z';
const snapshot = {
  schema:'v12-live-snapshot-v1',
  snapshotId:'v12-test',
  asOf,capturedAt:'2026-10-01T03:15:05Z',
  decision:{datasetCandidates:[{symbol:'600001',name:'Test',price:10,asOf,scores:{v12SelectionRaw:80},features:{momentum:{score:80}}}]}
};
test('backfill excludes same-day bars and leaves missing horizons pending', async () => {
  const market = async (req,res) => {
    res.json({items:[{code:'600001',kline:{data:{klines:[
      '2026-10-01,10,10.5,10.8,9.8,100',
      '2026-10-02,10,10.4,10.8,9.9,100',
      '2026-10-03,10,10.2,10.3,10.0,100'
    ]}}}]});
  };
  const result = await backfillSnapshot(snapshot,{market});
  assert.equal(result.sourceSnapshot.snapshotId,'v12-test');
  assert.equal(result.signals[0].horizons.t1.date,'2026-10-02');
  assert.equal(result.signals[0].horizons.t1.status,'complete');
  assert.equal(result.signals[0].horizons.t2.status,'complete');
  assert.equal(result.signals[0].horizons.t3.status,'pending');
  assert.equal(result.signals[0].horizons.t1.returnPct,4);
});
