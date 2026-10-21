import { readFile, writeFile, mkdir, access, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { asOfDate } from './schema.js';

export const PERSISTENCE_SCHEMA = 'v12-research-persistence-v2';
export const STORAGE_POLICY = Object.freeze({
  raw:'research-only compact snapshot; point-in-time candidate features immutable',
  outcomes:'separate appendable forward outcome records keyed by snapshotId/symbol/asOf',
  merged:'derived file; never overwrites raw feature fields',
  news:'long-term store excludes raw news body/content/articles/evidence'
});
const HORIZONS = Object.freeze([1, 2, 3, 4, 5]);
const list = value => Array.isArray(value) ? value : [];

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
function canonicalTimestamp(value) {
  if (typeof value !== 'string' || !asOfDate(value) || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}
function canonicalSnapshotId(asOf) {
  const stamp = canonicalTimestamp(asOf);
  return stamp ? 'v12-' + stamp.replace(/[:.]/g, '_') : null;
}
function legacySnapshotId(asOf) {
  return typeof asOf === 'string' ? 'v12-' + asOf.replace(/[^0-9A-Za-z._-]/g, '_') : null;
}
function safeId(value) {
  return String(value ?? '').replace(/[^0-9A-Za-z._-]/g, '_');
}
export function snapshotId(snapshot = {}) {
  return safeId(snapshot.snapshotId || canonicalSnapshotId(snapshot.asOf) || snapshot.capturedAt);
}
function identityMatches(snapshot) {
  const actual = String(snapshot.snapshotId ?? '');
  return !!actual && [canonicalSnapshotId(snapshot.asOf), legacySnapshotId(snapshot.asOf)].includes(actual);
}
function candidateRows(snapshot) {
  return list(snapshot?.decision?.datasetCandidates);
}
function rowSymbol(row) {
  return String(row?.symbol ?? row?.code ?? '').trim();
}
function assertUniqueSymbols(rows, label = 'rows') {
  const seen = new Set();
  for (const row of rows) {
    const symbol = rowSymbol(row);
    if (!symbol) throw new Error(label + ': symbol-missing');
    if (seen.has(symbol)) throw new Error(label + ': duplicate-symbol:' + symbol);
    seen.add(symbol);
  }
}
export function validateRawSnapshot(snapshot = {}) {
  const reasons = [];
  const stamp = canonicalTimestamp(snapshot.asOf);
  if (snapshot.schema !== 'v12-live-snapshot-v1') reasons.push('schema-invalid');
  if (!snapshot.snapshotId) reasons.push('snapshot-id-missing');
  if (!stamp || !asOfDate(snapshot.asOf)) reasons.push('asof-invalid');
  if (!snapshot.capturedAt || !canonicalTimestamp(snapshot.capturedAt)) reasons.push('captured-at-invalid');
  if (stamp && !identityMatches(snapshot)) reasons.push('snapshot-id-asof-mismatch');
  if (snapshot.synthetic === true || snapshot.dataKind === 'synthetic') reasons.push('synthetic-not-real');
  if (snapshot.sourcePolicy?.pointInTime !== 'captured-at-source') reasons.push('point-in-time-source-missing');
  const candidates = candidateRows(snapshot);
  if (candidates.length < 5) reasons.push('candidate-count-insufficient');
  try { assertUniqueSymbols(candidates, 'datasetCandidates'); }
  catch (error) { reasons.push(error.message); }
  for (const row of candidates) {
    if (!/^(00|60)\d{4}$/.test(rowSymbol(row))) reasons.push('symbol-invalid');
    if (row.asOf && stamp && canonicalTimestamp(row.asOf) !== stamp) reasons.push('candidate-asof-mismatch');
  }
  if (snapshot?.quality?.status !== 'CAPTURED' || snapshot?.quality?.valid !== true) {
    reasons.push('source-quality-invalid');
  }
  return {valid:reasons.length === 0, status:reasons.length ? 'INVALID_SNAPSHOT' : 'CAPTURED',
    reasons:[...new Set(reasons)]};
}

function stripNews(value, key = '') {
  if (Array.isArray(value)) return value.map(item => stripNews(item, key));
  if (!value || typeof value !== 'object') return value;
  const blocked = new Set(['news','content','body','evidence','articles','articleBody','fullText']);
  const output = {};
  for (const [name, item] of Object.entries(value)) {
    if (blocked.has(name) || blocked.has(key)) continue;
    output[name] = stripNews(item, name);
  }
  return output;
}
export function compactSnapshot(snapshot = {}) {
  const copy = stripNews(clone(snapshot));
  copy.storagePolicy = STORAGE_POLICY;
  return copy;
}

function outcomeRows(outcome = {}) {
  if (Array.isArray(outcome?.signals)) return outcome.signals;
  if (Array.isArray(outcome?.evaluated)) return outcome.evaluated;
  if (Array.isArray(outcome?.decision?.datasetCandidates)) return outcome.decision.datasetCandidates;
  return [];
}
function outcomeIdentity(outcome = {}) {
  return {
    snapshotId:outcome.snapshotId ?? outcome.sourceSnapshot?.snapshotId ?? null,
    asOf:outcome.asOf ?? outcome.sourceSnapshot?.asOf ?? null
  };
}
function assertOutcomeIdentity(snapshot, outcome = {}) {
  const rows = outcomeRows(outcome);
  if (!rows.length) return;
  if (outcome.synthetic === true || outcome.dataKind === 'synthetic') {
    throw new Error('synthetic-outcome-not-real');
  }
  const identity = outcomeIdentity(outcome);
  if (!identity.snapshotId || String(identity.snapshotId) !== snapshotId(snapshot)) {
    throw new Error('outcome-snapshot-id-mismatch');
  }
  if (!identity.asOf || asOfDate(identity.asOf) !== asOfDate(snapshot.asOf)) {
    throw new Error('outcome-asof-mismatch');
  }
  assertUniqueSymbols(rows, 'outcome');
}
function horizonSource(row, horizon) {
  return row?.horizons?.['t' + horizon] ?? row?.horizonProfile?.['t' + horizon] ?? null;
}
function normalizeHorizon(source, cutoff, previousDate = null) {
  const item = source && typeof source === 'object' ? clone(source) : {};
  const date = typeof item.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.date) ? item.date : null;
  const rawValue = item.returnPct;
  const value = rawValue === null || rawValue === undefined || rawValue === '' ? null : Number(rawValue);
  const valid = date && date > cutoff && (!previousDate || date > previousDate) && Number.isFinite(value);
  if (!valid) return {...item, status:'pending', returnPct:Number.isFinite(value) ? value : null};
  return {...item, status:'complete', returnPct:value};
}
function normalizedHorizons(row, cutoff) {
  const output = {};
  let previousDate = null;
  for (const horizon of HORIZONS) {
    const item = normalizeHorizon(horizonSource(row, horizon), cutoff, previousDate);
    output['t' + horizon] = item;
    if (item.status === 'complete') previousDate = item.date;
  }
  return output;
}
function sameOutcome(a, b) {
  return a?.status === 'complete' && b?.status === 'complete' &&
    a.date === b.date && Number(a.returnPct) === Number(b.returnPct);
}
function mergeOutcomeRows(previousRows, incomingRows, cutoff) {
  assertUniqueSymbols(previousRows, 'stored-outcome');
  assertUniqueSymbols(incomingRows, 'outcome');
  const map = new Map(previousRows.map(row => [rowSymbol(row), clone(row)]));
  for (const incoming of incomingRows) {
    const symbol = rowSymbol(incoming);
    const prior = map.get(symbol) ?? {symbol};
    const priorHorizons = normalizedHorizons(prior, cutoff);
    const nextHorizons = normalizedHorizons(incoming, cutoff);
    const horizons = {};
    for (const horizon of HORIZONS) {
      const p = priorHorizons['t' + horizon], n = nextHorizons['t' + horizon];
      if (p.status === 'complete' && n.status === 'complete' && !sameOutcome(p, n)) {
        throw new Error('outcome-conflict:' + symbol + ':t' + horizon);
      }
      horizons['t' + horizon] = p.status === 'complete' ? p : n;
    }
    map.set(symbol, {...prior, ...clone(incoming), horizons, horizonProfile:horizons});
  }
  return [...map.values()];
}
function mergedCandidate(candidate, item, outcomeSchema, cutoff) {
  const horizons = normalizedHorizons(item ?? {}, cutoff);
  const forwardOutcome = {sourceSchema:outcomeSchema ?? null, horizons};
  const result = {...candidate, forwardOutcome};
  // Outcome-only fields are exposed for validators; raw feature blocks remain untouched.
  result.horizons = horizons;
  result.horizonProfile = horizons;
  result.bestHorizon = item?.bestHorizon ?? null;
  result.bestHorizonBasis = item?.bestHorizonBasis ?? null;
  result.shortPattern = item?.shortPattern ?? null;
  return result;
}
export function mergeOutcomeIntoSnapshot(snapshot = {}, outcome = {}) {
  const validation = validateRawSnapshot(snapshot);
  if (!validation.valid) throw new Error('cannot merge invalid snapshot: ' + validation.reasons.join(','));
  assertOutcomeIdentity(snapshot, outcome);
  const rows = outcomeRows(outcome);
  const map = new Map(rows.map(row => [rowSymbol(row), row]));
  const cutoff = asOfDate(snapshot.asOf);
  return {
    ...clone(snapshot),
    persistenceSchema:PERSISTENCE_SCHEMA,
    snapshotId:snapshotId(snapshot),
    storagePolicy:STORAGE_POLICY,
    decision:{
      ...clone(snapshot.decision),
      datasetCandidates:candidateRows(snapshot).map(candidate =>
        mergedCandidate(candidate, map.get(rowSymbol(candidate)), outcome.schema, cutoff))
    }
  };
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}
async function writeImmutable(path, value) {
  const text = JSON.stringify(value, null, 2) + '\n';
  await mkdir(dirname(path), {recursive:true});
  try {
    await writeFile(path, text, {encoding:'utf8', flag:'wx'});
    return {written:true, conflict:false};
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const current = await readFile(path, 'utf8');
    if (current !== text) throw new Error('immutable record conflict: ' + path);
    return {written:false, conflict:false};
  }
}
async function atomicWrite(path, text) {
  await mkdir(dirname(path), {recursive:true});
  const temp = path + '.tmp-' + process.pid + '-' + Math.random().toString(16).slice(2);
  await writeFile(temp, text, 'utf8');
  await rename(temp, path);
}
async function writeAppendable(path, value) {
  const text = JSON.stringify(value, null, 2) + '\n';
  if (await exists(path) && await readFile(path, 'utf8') === text) return {written:false};
  await atomicWrite(path, text);
  return {written:true};
}
async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }
function datePath(snapshot) {
  const day = asOfDate(snapshot.asOf);
  const [year, month, date] = day.split('-');
  return {year, month, date};
}
function manifestEntry(snapshot, paths, outcome) {
  return {
    schema:PERSISTENCE_SCHEMA, snapshotId:snapshotId(snapshot), asOf:snapshot.asOf,
    capturedAt:snapshot.capturedAt, sourcePolicy:snapshot.sourcePolicy ?? null,
    modelVersions:snapshot.modelVersions ?? null, quality:snapshot.quality ?? null,
    candidateCount:candidateRows(snapshot).length, outcomeRows:outcomeRows(outcome).length,
    storage:{raw:paths.raw, outcome:paths.outcome, merged:paths.merged}
  };
}
async function withLock(path, operation) {
  const lock = path + '.lock';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await mkdir(lock);
      try { return await operation(); } finally { await rm(lock, {recursive:true, force:true}); }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await new Promise(resolve => setTimeout(resolve, 10 * Math.min(attempt + 1, 10)));
    }
  }
  throw new Error('manifest-lock-timeout');
}

export async function persistV12Research({snapshot, outcome = {}, storeDir}) {
  if (!storeDir) throw new Error('storeDir is required');
  const validation = validateRawSnapshot(snapshot);
  if (!validation.valid) throw new Error('cannot persist invalid snapshot: ' + validation.reasons.join(','));
  assertOutcomeIdentity(snapshot, outcome);
  const id = snapshotId(snapshot), date = datePath(snapshot), base = resolve(storeDir);
  const paths = {
    raw:join(base, 'raw', date.year, date.month, date.date, id + '.json'),
    outcome:join(base, 'outcomes', date.year, date.month, date.date, id + '.json'),
    merged:join(base, 'merged', date.year, date.month, date.date, id + '.json')
  };
  const storedSnapshot = compactSnapshot(snapshot);
  const rawResult = await writeImmutable(paths.raw, storedSnapshot);
  const cutoff = asOfDate(snapshot.asOf);
  let storedOutcome = clone(outcome);
  if (await exists(paths.outcome)) {
    const previous = await readJson(paths.outcome);
    assertOutcomeIdentity(snapshot, previous);
    storedOutcome = {
      ...previous, ...storedOutcome, schema:storedOutcome.schema ?? previous.schema ?? 'v12-forward-outcome-v2',
      snapshotId:id, sourceSnapshot:{...(previous.sourceSnapshot ?? {}), ...(storedOutcome.sourceSnapshot ?? {}),
        snapshotId:id, asOf:snapshot.asOf},
      signals:mergeOutcomeRows(outcomeRows(previous), outcomeRows(outcome), cutoff)
    };
  } else if (outcomeRows(storedOutcome).length) {
    storedOutcome = {...storedOutcome, snapshotId:id,
      sourceSnapshot:{...(storedOutcome.sourceSnapshot ?? {}), snapshotId:id, asOf:snapshot.asOf}};
  }
  if (!outcomeRows(storedOutcome).length) {
    storedOutcome = {schema:storedOutcome.schema ?? 'v12-forward-outcome-v2', snapshotId:id,
      sourceSnapshot:{snapshotId:id, asOf:snapshot.asOf}, signals:[]};
  }
  const outcomeResult = await writeAppendable(paths.outcome, storedOutcome);
  const merged = mergeOutcomeIntoSnapshot(storedSnapshot, storedOutcome);
  const mergedResult = await writeAppendable(paths.merged, merged);
  const manifestPath = join(base, 'manifest.jsonl');
  const entry = manifestEntry(storedSnapshot, paths, storedOutcome);
  await withLock(manifestPath, async () => {
    let entries = [];
    if (await exists(manifestPath)) {
      entries = (await readFile(manifestPath, 'utf8')).split('\n').filter(Boolean)
        .map(line => JSON.parse(line)).filter(item => item.snapshotId !== id);
    }
    entries.push(entry);
    entries.sort((a, b) => String(a.snapshotId).localeCompare(String(b.snapshotId)));
    await atomicWrite(manifestPath, entries.map(item => JSON.stringify(item)).join('\n') + '\n');
  });
  return {status:'PERSISTED',snapshotId:id,paths,rawWritten:rawResult.written,
    outcomeWritten:outcomeResult.written,mergedWritten:mergedResult.written,manifestPath,
    candidateCount:candidateRows(storedSnapshot).length,outcomeRows:outcomeRows(storedOutcome).length};
}

async function parseArgs(args) {
  const get = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
  const snapshotPath = get('--snapshot'), outcomePath = get('--outcome'), storeDir = get('--store');
  if (!snapshotPath || !storeDir) throw new Error('usage: node persist_v12_research.js --snapshot FILE --store DIR [--outcome FILE]');
  return {snapshot:await readJson(resolve(snapshotPath)), outcome:outcomePath ? await readJson(resolve(outcomePath)) : {}, storeDir};
}
export async function runCLI(args = process.argv.slice(2)) {
  const result = await persistV12Research(await parseArgs(args));
  console.log(JSON.stringify(result, null, 2));
  return result;
}
if (process.argv[1] && import.meta.url === new URL('file://' + resolve(process.argv[1])).href) await runCLI();
