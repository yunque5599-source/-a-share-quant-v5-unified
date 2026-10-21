import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  persistV12Research,
  mergeOutcomeIntoSnapshot,
  validateRawSnapshot
} from '../persist_v12_research.js';

const SNAPSHOT_ID = 'v12-2026-10-01T03_15_00_000Z';
function snapshot(overrides = {}) {
  return {
    schema:'v12-live-snapshot-v1',
    snapshotId:SNAPSHOT_ID,
    capturedAt:'2026-10-01T03:15:05Z',
    asOf:'2026-10-01T03:15:00Z',
    modelVersions:{selection:'V12 Short-Horizon Selection Score v1'},
    sourcePolicy:{provider:'test',pointInTime:'captured-at-source'},
    quality:{status:'CAPTURED',valid:true},
    inputs:{psychology:{themes:[{name:'AI',news:[{content:'raw news body'}]}]}},
    decision:{datasetCandidates:[
      {symbol:'600001',asOf:'2026-10-01T03:15:00Z',price:10,features:{momentum:{score:88}},scores:{v12SelectionRaw:88}},
      {symbol:'600002',asOf:'2026-10-01T03:15:00Z',price:10,features:{momentum:{score:70}},scores:{v12SelectionRaw:70}},
      {symbol:'600003',asOf:'2026-10-01T03:15:00Z',price:10,features:{momentum:{score:60}},scores:{v12SelectionRaw:60}},
      {symbol:'600004',asOf:'2026-10-01T03:15:00Z',price:10,features:{momentum:{score:50}},scores:{v12SelectionRaw:50}},
      {symbol:'600005',asOf:'2026-10-01T03:15:00Z',price:10,features:{momentum:{score:40}},scores:{v12SelectionRaw:40}}
    ]},
    ...overrides
  };
}
function outcome(horizons, overrides = {}) {
  return {
    schema:'v12-forward-outcome-v2',
    snapshotId:SNAPSHOT_ID,
    sourceSnapshot:{snapshotId:SNAPSHOT_ID,asOf:'2026-10-01T03:15:00Z'},
    signals:[{symbol:'600001',features:{momentum:{score:1}},horizons}],
    ...overrides
  };
}

test('invalid source-quality snapshot cannot persist', () => {
  const result = validateRawSnapshot({...snapshot(), quality:{status:'SOURCE_UNAVAILABLE',valid:false}});
  assert.equal(result.status,'INVALID_SNAPSHOT');
});

test('raw snapshot is immutable while outcomes append and expose standard horizons', async () => {
  const store = await mkdtemp(join(tmpdir(), 'v12-persist-'));
  const first = await persistV12Research({
    snapshot:snapshot(),
    outcome:outcome({t1:{date:'2026-10-02',returnPct:3}}),
    storeDir:store
  });
  assert.equal(first.status,'PERSISTED');
  assert.equal(first.rawWritten,true);
  const mergedPath = first.paths.merged;
  let merged = JSON.parse(await readFile(mergedPath,'utf8'));
  const firstCandidate = merged.decision.datasetCandidates[0];
  assert.equal(firstCandidate.features.momentum.score,88);
  assert.equal(firstCandidate.forwardOutcome.horizons.t1.status,'complete');
  assert.equal(firstCandidate.horizons.t1.status,'complete');
  assert.equal(firstCandidate.forwardOutcome.horizons.t2.status,'pending');
  assert.equal(merged.inputs.psychology.themes[0].news,undefined);

  const second = await persistV12Research({
    snapshot:snapshot(),
    outcome:outcome({t1:{date:'2026-10-02',returnPct:null},t2:{date:'2026-10-05',returnPct:4}}),
    storeDir:store
  });
  assert.equal(second.rawWritten,false);
  merged = JSON.parse(await readFile(mergedPath,'utf8'));
  assert.equal(merged.decision.datasetCandidates[0].features.momentum.score,88);
  assert.equal(merged.decision.datasetCandidates[0].forwardOutcome.horizons.t1.returnPct,3);
  assert.equal(merged.decision.datasetCandidates[0].forwardOutcome.horizons.t2.status,'complete');
  const manifest = (await readFile(join(store,'manifest.jsonl'),'utf8')).trim().split('\n');
  assert.equal(manifest.length,1);
});

test('outcome merge keeps point-in-time features when outcome carries conflicting fields', () => {
  const merged = mergeOutcomeIntoSnapshot(snapshot(), outcome({t1:{date:'2026-10-02',returnPct:3}}));
  assert.equal(merged.decision.datasetCandidates[0].features.momentum.score,88);
  assert.equal(merged.decision.datasetCandidates[0].forwardOutcome.horizons.t1.returnPct,3);
});

test('wrong snapshot identity is rejected', async () => {
  const store = await mkdtemp(join(tmpdir(), 'v12-persist-'));
  await assert.rejects(() => persistV12Research({
    snapshot:snapshot(),
    outcome:outcome({t1:{date:'2026-10-02',returnPct:3}},{snapshotId:'v12-other'}),
    storeDir:store
  }), /outcome-snapshot-id-mismatch/);
});

test('same-day outcome remains pending', () => {
  const merged = mergeOutcomeIntoSnapshot(snapshot(), outcome({t1:{date:'2026-10-01',returnPct:5}}));
  assert.equal(merged.decision.datasetCandidates[0].forwardOutcome.horizons.t1.status,'pending');
});

test('duplicate symbols and synthetic fixtures are excluded', async () => {
  const duplicate = snapshot({decision:{datasetCandidates:[
    ...snapshot().decision.datasetCandidates,
    {symbol:'600001',price:10}
  ]}});
  assert.equal(validateRawSnapshot(duplicate).valid,false);
  const store = await mkdtemp(join(tmpdir(), 'v12-persist-'));
  await assert.rejects(() => persistV12Research({
    snapshot:snapshot(),
    outcome:outcome({t1:{date:'2026-10-02',returnPct:3}},{synthetic:true}),
    storeDir:store
  }), /synthetic-outcome-not-real/);
});

test('complete outcomes cannot be overwritten by pending or conflicting results', async () => {
  const store = await mkdtemp(join(tmpdir(), 'v12-persist-'));
  await persistV12Research({snapshot:snapshot(),outcome:outcome({t1:{date:'2026-10-02',returnPct:3}}),storeDir:store});
  await persistV12Research({snapshot:snapshot(),outcome:outcome({t1:{date:'2026-10-02',returnPct:null}}),storeDir:store});
  await assert.rejects(() => persistV12Research({
    snapshot:snapshot(),
    outcome:outcome({t1:{date:'2026-10-02',returnPct:4}}),
    storeDir:store
  }), /outcome-conflict/);
});
