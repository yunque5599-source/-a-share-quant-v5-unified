import { readFile, writeFile, mkdir, access, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { asOfDate } from './schema.js';

export const PERSISTENCE_SCHEMA = 'v12-research-persistence-v1';
export const STORAGE_POLICY = Object.freeze({
  raw:'research-only compact snapshot; point-in-time candidate features immutable',
  outcomes:'separate appendable forward outcome records',
  merged:'derived file; never overwrites raw feature fields',
  news:'long-term store excludes raw news body/content'
});

const HORIZONS = [1, 2, 3, 4, 5];
const list = value => Array.isArray(value) ? value : [];

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function safeId(value) {
  return String(value ?? '').replace(/[^0-9A-Za-z._-]/g, '_');
}

export function snapshotId(snapshot = {}) {
  const value = snapshot.snapshotId ?? snapshot.asOf ?? snapshot.capturedAt;
  return safeId(value);
}

export function validateRawSnapshot(snapshot = {}) {
  const reasons = [];
  if (snapshot.schema !== 'v12-live-snapshot-v1') reasons.push('schema-invalid');
  if (!snapshotId(snapshot)) reasons.push('snapshot-id-missing');
  if (!snapshot.asOf || !asOfDate(snapshot.asOf)) reasons.push('asof-invalid');
  if (!snapshot.capturedAt || !Number.isFinite(Date.parse(snapshot.capturedAt))) reasons.push('captured-at-invalid');
  if (!Array.isArray(snapshot?.decision?.datasetCandidates) ||
      snapshot.decision.datasetCandidates.length < 5) reasons.push('candidate-count-insufficient');
  if (snapshot?.quality?.status !== 'CAPTURED' || snapshot?.quality?.valid !== true) {
    reasons.push('source-quality-invalid');
  }
  return {valid:reasons.length === 0, status:reasons.length ? 'INVALID_SNAPSHOT' : 'CAPTURED', reasons};
}

function compactPsychology(value) {
  if (!value || typeof value !== 'object') return value;
  const copy = clone(value);
  const strip = item => {
    if (!item || typeof item !== 'object') return item;
    const result = {...item};
    delete result.news;
    delete result.content;
    delete result.body;
    delete result.evidence;
    return result;
  };
  if (Array.isArray(copy.themes)) copy.themes = copy.themes.map(strip);
  if (Array.isArray(copy.data?.themes)) copy.data.themes = copy.data.themes.map(strip);
  return copy;
}

export function compactSnapshot(snapshot = {}) {
  const copy = clone(snapshot);
  if (copy.inputs?.psychology) copy.inputs.psychology = compactPsychology(copy.inputs.psychology);
  copy.storagePolicy = STORAGE_POLICY;
  return copy;
}

function outcomeRows(outcome = {}) {
  if (Array.isArray(outcome?.signals)) return outcome.signals;
  if (Array.isArray(outcome?.evaluated)) return outcome.evaluated;
  if (Array.isArray(outcome?.decision?.datasetCandidates)) return outcome.decision.datasetCandidates;
  return [];
}

function outcomeFor(outcomeMap, symbol) {
  return outcomeMap.get(String(symbol ?? '')) ?? null;
}

function horizonOutcome(item, horizon) {
  const source = item?.horizons?.['t' + horizon] ?? item?.horizonProfile?.['t' + horizon];
  if (!source || source.returnPct === null || source.returnPct === undefined ||
      !Number.isFinite(Number(source.returnPct))) {
    return {status:'pending', returnPct:null, date:source?.date ?? null};
  }
  return {...clone(source), status:'complete', returnPct:Number(source.returnPct)};
}

export function mergeOutcomeIntoSnapshot(snapshot = {}, outcome = {}) {
  const original = clone(snapshot);
  const map = new Map(outcomeRows(outcome).map(row => [
    String(row?.symbol ?? row?.code ?? ''), row
  ]));
  const candidates = list(original?.decision?.datasetCandidates);
  const mergedCandidates = candidates.map(candidate => {
    const symbol = String(candidate?.symbol ?? candidate?.code ?? '');
    const item = outcomeFor(map, symbol);
    return {
      ...candidate,
      forwardOutcome: {
        sourceSchema:outcome?.schema ?? null,
        horizons:Object.fromEntries(HORIZONS.map(horizon => [
          't' + horizon, horizonOutcome(item, horizon)
        ]))
      }
    };
  });
  return {
    ...original,
    persistenceSchema:PERSISTENCE_SCHEMA,
    snapshotId:snapshotId(original),
    storagePolicy:STORAGE_POLICY,
    decision:{
      ...original.decision,
      datasetCandidates:mergedCandidates
    }
  };
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function writeImmutable(path, value) {
  const text = JSON.stringify(value, null, 2) + '\n';
  if (await exists(path)) {
    const current = await readFile(path, 'utf8');
    if (current !== text) throw new Error('immutable record conflict: ' + path);
    return {written:false, conflict:false};
  }
  await mkdir(dirname(path), {recursive:true});
  await writeFile(path, text, 'utf8');
  return {written:true, conflict:false};
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function atomicWrite(path, text) {
  await mkdir(dirname(path), {recursive:true});
  const temp = path + '.tmp-' + process.pid;
  await writeFile(temp, text, 'utf8');
  await rename(temp, path);
}

function datePath(snapshot) {
  const day = asOfDate(snapshot.asOf) ?? 'unknown-date';
  const [year, month, date] = day.split('-');
  return {year, month, date};
}

function manifestEntry(snapshot, paths, outcome) {
  const rows = outcomeRows(outcome);
  return {
    schema:PERSISTENCE_SCHEMA,
    snapshotId:snapshotId(snapshot),
    asOf:snapshot.asOf,
    capturedAt:snapshot.capturedAt,
    sourcePolicy:snapshot.sourcePolicy ?? null,
    modelVersions:snapshot.modelVersions ?? null,
    quality:snapshot.quality ?? null,
    candidateCount:list(snapshot?.decision?.datasetCandidates).length,
    outcomeRows:rows.length,
    storage:{
      raw:paths.raw,
      outcome:paths.outcome,
      merged:paths.merged
    }
  };
}

export async function persistV12Research({snapshot, outcome = {}, storeDir}) {
  if (!storeDir) throw new Error('storeDir is required');
  const validation = validateRawSnapshot(snapshot);
  if (!validation.valid) throw new Error('cannot persist invalid snapshot: ' + validation.reasons.join(','));
  const id = snapshotId(snapshot);
  const date = datePath(snapshot);
  const base = resolve(storeDir);
  const paths = {
    raw:join(base, 'raw', date.year, date.month, date.date, id + '.json'),
    outcome:join(base, 'outcomes', date.year, date.month, date.date, id + '.json'),
    merged:join(base, 'merged', date.year, date.month, date.date, id + '.json')
  };
  const storedSnapshot = compactSnapshot(snapshot);
  const rawResult = await writeImmutable(paths.raw, storedSnapshot);
  let storedOutcome = clone(outcome);
  if (await exists(paths.outcome)) {
    const previous = await readJson(paths.outcome);
    const map = new Map(outcomeRows(previous).map(row => [String(row?.symbol ?? row?.code ?? ''), row]));
    for (const row of outcomeRows(outcome)) {
      const symbol = String(row?.symbol ?? row?.code ?? '');
      const prior = map.get(symbol) ?? {};
      const horizons = {...prior.horizons, ...row.horizons};
      map.set(symbol, {...prior, ...row, horizons});
    }
    storedOutcome = {
      ...previous,
      ...storedOutcome,
      schema:storedOutcome.schema ?? previous.schema ?? 'v12-forward-outcome-v2',
      signals:[...map.values()]
    };
  }
  const outcomeResult = await writeImmutable(paths.outcome, storedOutcome);
  const merged = mergeOutcomeIntoSnapshot(storedSnapshot, storedOutcome);
  const mergedResult = await writeImmutable(paths.merged, merged);
  const manifestPath = join(base, 'manifest.jsonl');
  const entry = manifestEntry(storedSnapshot, paths, storedOutcome);
  let entries = [];
  if (await exists(manifestPath)) {
    entries = (await readFile(manifestPath, 'utf8')).split('\n').filter(Boolean)
      .map(line => JSON.parse(line)).filter(item => item.snapshotId !== id);
  }
  entries.push(entry);
  entries.sort((a, b) => String(a.snapshotId).localeCompare(String(b.snapshotId)));
  await atomicWrite(manifestPath, entries.map(item => JSON.stringify(item)).join('\n') + '\n');
  return {
    status:'PERSISTED',
    snapshotId:id,
    paths,
    rawWritten:rawResult.written,
    outcomeWritten:outcomeResult.written,
    mergedWritten:mergedResult.written,
    manifestPath,
    candidateCount:list(storedSnapshot?.decision?.datasetCandidates).length,
    outcomeRows:outcomeRows(storedOutcome).length
  };
}

async function parseArgs(args) {
  const get = name => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : null;
  };
  const snapshotPath = get('--snapshot');
  const outcomePath = get('--outcome');
  const storeDir = get('--store');
  if (!snapshotPath || !storeDir) {
    throw new Error('usage: node persist_v12_research.js --snapshot FILE --store DIR [--outcome FILE]');
  }
  return {
    snapshot:await readJson(resolve(snapshotPath)),
    outcome:outcomePath ? await readJson(resolve(outcomePath)) : {},
    storeDir
  };
}

export async function runCLI(args = process.argv.slice(2)) {
  const result = await persistV12Research(await parseArgs(args));
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && import.meta.url === new URL('file://' + resolve(process.argv[1])).href) {
  await runCLI();
}
