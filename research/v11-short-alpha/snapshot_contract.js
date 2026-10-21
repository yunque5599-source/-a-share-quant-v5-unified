import { asOfDate } from './schema.js';

export const CAPTURE_STATES = Object.freeze(['CAPTURED', 'SKIPPED_OUTSIDE_SESSION', 'SOURCE_UNAVAILABLE', 'INVALID_SNAPSHOT']);
export function sessionAt(now = new Date()) {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) return false;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone:'Asia/Shanghai', weekday:'short', hour:'2-digit', minute:'2-digit', hourCycle:'h23'
  }).formatToParts(date);
  const get = type => parts.find(p => p.type === type)?.value;
  const minute = Number(get('hour')) * 60 + Number(get('minute'));
  return ['Mon','Tue','Wed','Thu','Fri'].includes(get('weekday')) &&
    ((minute >= 570 && minute < 690) || (minute >= 780 && minute < 900));
}
export function canonicalAsOf(value) {
  if (!asOfDate(value) || !value.includes('T')) throw new Error('timestamp must include timezone and time');
  return new Date(value).toISOString();
}
export function canonicalSnapshotId(asOf) {
  return 'v12-' + canonicalAsOf(asOf).replace(/[:.]/g, '_');
}
export function validateSnapshot(snapshot = {}, {live = false, now = new Date()} = {}) {
  const reasons = [];
  let stamp = null, capture = null;
  try { stamp = canonicalAsOf(snapshot.asOf); capture = canonicalAsOf(snapshot.capturedAt); }
  catch { reasons.push('timestamp-invalid'); }
  if (snapshot.schema !== 'v12-live-snapshot-v1') reasons.push('schema-invalid');
  if (snapshot.synthetic === true || snapshot.dataKind === 'synthetic') reasons.push('synthetic-not-real');
  if (snapshot.sourcePolicy?.pointInTime !== 'captured-at-source') reasons.push('point-in-time-source-missing');
  if (snapshot.quality?.status !== 'CAPTURED' || snapshot.quality?.valid !== true) reasons.push('source-quality-invalid');
  const candidates = snapshot.decision?.datasetCandidates;
  const seen = new Set();
  if (!Array.isArray(candidates) || candidates.length < 5) reasons.push('candidate-count-insufficient');
  for (const row of Array.isArray(candidates) ? candidates : []) {
    const symbol = String(row.symbol ?? '');
    if (!/^(00|60)\d{4}$/.test(symbol)) reasons.push('symbol-invalid');
    if (seen.has(symbol)) reasons.push('duplicate-symbol');
    seen.add(symbol);
    if (!(row.price > 0)) reasons.push('price-invalid');
    if (stamp && row.asOf && canonicalAsOf(row.asOf) !== stamp) reasons.push('candidate-asof-mismatch');
    if (row.quality?.degraded || row.quality?.stale) reasons.push('candidate-source-degraded');
  }
  if (stamp && capture) {
    const lag = Date.parse(capture) - Date.parse(stamp);
    if (lag < 0 || lag > 300000) reasons.push('capture-time-mismatch');
    if (snapshot.snapshotId !== canonicalSnapshotId(stamp)) reasons.push('snapshot-id-asof-mismatch');
    if (!sessionAt(stamp)) reasons.push('outside-session');
    if (live && (Date.parse(now) - Date.parse(capture) > 120000 || Date.parse(capture) > Date.parse(now) + 5000)) reasons.push('capture-not-current');
  }
  if (snapshot.quality?.quoteVerified !== true) reasons.push('quotes-not-verified');
  if ((snapshot.quality?.eligibleCandidates ?? 0) < 5) reasons.push('qualified-candidates-insufficient');
  return {valid:!reasons.length, status:reasons.length ? 'INVALID_SNAPSHOT' : 'CAPTURED', reasons:[...new Set(reasons)]};
}
export function sourceQuality({ranked, deep, discovery, psychology, decision, quoteRows, asOf}) {
  const reasons = [];
  const rankedData = ranked?.data ?? {};
  const diag = psychology?.diagnostics ?? psychology?.data?.diagnostics ?? {};
  const themes = psychology?.data?.themes ?? psychology?.themes ?? [];
  if ((rankedData.candidates?.length ?? 0) < 5 || rankedData.degraded ||
      /fallback|degraded/.test(rankedData.method ?? ranked.method ?? '')) reasons.push('ranked-unqualified');
  if (discovery?.qualifiedForDiscovery !== true || discovery?.quality?.degraded ||
      discovery?.quality?.qualified === false) reasons.push('discovery-unqualified');
  if ((diag.conceptRows ?? 0) < 1 || themes.length < 1) reasons.push('psychology-source-unavailable');
  const items = deep?.items ?? [];
  if (items.length < 5 || items.some(item => item.error || item.dataQuality?.degraded ||
      item.dataQuality?.flowSource !== 'eastmoney' || item.dataQuality?.klineSource !== 'eastmoney')) reasons.push('deep-source-incomplete');
  const quotes = new Map((quoteRows ?? []).map(row => [String(row.f12), row]));
  const day = asOfDate(asOf);
  let quoteVerified = true;
  for (const candidate of decision.ranking ?? []) {
    const row = quotes.get(candidate.symbol), stamp = Number(row?.f124) * 1000;
    if (!Number.isFinite(stamp) || !stamp || asOfDate(new Date(stamp).toISOString()) !== day ||
        Date.parse(asOf) - stamp > 300000 || stamp > Date.parse(asOf) + 5000 ||
        !(Number(row.f2) > 0)) quoteVerified = false;
  }
  if (!quoteVerified || quotes.size < 5) reasons.push('quote-freshness-unavailable');
  const eligibleCandidates = (decision.ranking ?? []).filter(row => row.quality?.complete === true &&
    row.psychology?.complete === true && Number.isFinite(row.scores?.v12SelectionRaw)).length;
  if (eligibleCandidates < 5) reasons.push('qualified-candidates-insufficient');
  return {status:reasons.length ? 'SOURCE_UNAVAILABLE' : 'CAPTURED', valid:!reasons.length,
    reasons, quoteVerified, eligibleCandidates, psychologyThemes:themes.length,
    researchFailures:diag.researchFailures ?? null};
}
