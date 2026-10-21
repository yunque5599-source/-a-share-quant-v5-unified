import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalSnapshotId, sessionAt, validateSnapshot, sourceQuality } from '../snapshot_contract.js';

function base() {
  const asOf = '2026-10-05T03:15:00Z';
  return {
    schema:'v12-live-snapshot-v1',
    snapshotId:canonicalSnapshotId(asOf),
    capturedAt:'2026-10-05T03:15:05Z',
    asOf,
    sourcePolicy:{pointInTime:'captured-at-source'},
    quality:{status:'CAPTURED',valid:true,quoteVerified:true,eligibleCandidates:5},
    decision:{ranking:[...Array(5)].map((_, index) => ({
      symbol:index < 3 ? '60000' + (index + 1) : '00000' + (index + 1),
      price:10,asOf,quality:{complete:true},psychology:{complete:true},
      scores:{v12SelectionRaw:80}
    })),datasetCandidates:[]}
  };
}
test('sessionAt recognizes synchronous A-share windows', () => {
  assert.equal(sessionAt(new Date('2026-10-05T03:15:00Z')),true);
  assert.equal(sessionAt(new Date('2026-10-05T04:00:00Z')),false);
});
test('strict contract rejects duplicate, degraded, stale, and unverified candidates', () => {
  const snapshot = base();
  snapshot.decision.datasetCandidates = snapshot.decision.ranking;
  snapshot.quality.quoteVerified = false;
  snapshot.decision.datasetCandidates[1] = {...snapshot.decision.datasetCandidates[0]};
  const result = validateSnapshot(snapshot);
  assert.equal(result.valid,false);
  assert.ok(result.reasons.includes('duplicate-symbol'));
  assert.ok(result.reasons.includes('quotes-not-verified'));
});
test('source quality does not qualify incomplete psychology or fallback deep data', () => {
  const result = sourceQuality({
    ranked:{data:{candidates:[...Array(5)].map((_,i)=>({f12:'60000'+(i+1)}))}},
    deep:{items:[...Array(5)].map(()=>({dataQuality:{klineSource:'eastmoney',flowSource:'eastmoney'}}))},
    discovery:{qualifiedForDiscovery:true,quality:{qualified:true}},
    psychology:{data:{themes:[{name:'AI'}],diagnostics:{conceptRows:10,researchFailures:4}}},
    decision:{ranking:[...Array(5)].map((_,i)=>({symbol:'60000'+(i+1),quality:{complete:true},psychology:{complete:true},scores:{v12SelectionRaw:80}}))},
    quoteRows:[...Array(5)].map((_,i)=>({f12:'60000'+(i+1),f2:10,f124:Date.parse('2026-10-05T03:15:00Z')/1000})),
    asOf:'2026-10-05T03:15:00Z'
  });
  assert.equal(result.valid,false);
  assert.ok(result.reasons.includes('psychology-research-incomplete'));
});
