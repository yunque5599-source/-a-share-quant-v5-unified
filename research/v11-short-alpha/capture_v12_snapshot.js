import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import marketHandler from '../../api/market.js';
import discoveryHandler from '../../api/discovery_universe.js';
import psychologyHandler from '../../api/psychology_universe.js';
import { integrateCandidateFlow } from './candidate_flow.js';
import { selectV12Candidates } from './v12_universe.js';
import { sourceQuality as contractSourceQuality, validateSnapshot, canonicalSnapshotId } from './snapshot_contract.js';

const MODEL_VERSIONS = Object.freeze({
  alpha:'V11 Short Alpha Phase 1',
  timing:'Buy Timing Phase 1',
  psychology:'V12 Psychology Score Phase 3 Behavioral',
  trade:'V12 Trade Score Phase 1',
  selection:'V12 Short-Horizon Selection Score v1'
});

function invoke(handler, url) {
  return new Promise((resolvePromise, reject) => {
    let body = '';
    const req = {method:'GET', url};
    const res = {
      statusCode:200,
      setHeader() {},
      status(code) { this.statusCode = code; return this; },
      json(value) {
        body = JSON.stringify(value);
        resolvePromise({statusCode:this.statusCode, body});
      },
      send(value) {
        body = typeof value === 'string' ? value : JSON.stringify(value);
        resolvePromise({statusCode:this.statusCode, body});
      },
      end(value = '') {
        body = typeof value === 'string' ? value : JSON.stringify(value);
        resolvePromise({statusCode:this.statusCode, body});
      }
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

function parseResult(name, result) {
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(name + ' returned HTTP ' + result.statusCode + ': ' + result.body.slice(0, 500));
  }
  try {
    return JSON.parse(result.body);
  } catch (error) {
    throw new Error(name + ' returned invalid JSON: ' + error.message);
  }
}

function ymdhm(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone:'Asia/Shanghai',
    year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', hourCycle:'h23'
  }).formatToParts(date);
  const get = key => parts.find(item => item.type === key)?.value;
  return get('year') + get('month') + get('day') + '-' + get('hour') + get('minute');
}

function snapshotPath(explicit) {
  if (explicit) return resolve(explicit);
  return resolve('research/v11-short-alpha/live_snapshots/v12-' + ymdhm() + '.json');
}

function assertQualifiedDiscovery(discovery) {
  if (discovery?.status === 'SOURCE_FAILED' || discovery?.qualifiedForDiscovery === false) {
    throw new Error('discovery universe is not qualified: ' +
      JSON.stringify(discovery?.quality ?? discovery?.error ?? null));
  }
}

function sourceQualitySummary({rankedCandidates, selectedCodes, deepPayload, discoveryPayload, psychologyPayload, decision}) {
  const psychology = psychologyPayload?.data ?? psychologyPayload ?? {};
  const psychologyDiagnostics = psychology?.diagnostics ?? {};
  const deepItems = Array.isArray(deepPayload?.items) ? deepPayload.items : [];
  const deepByCode = new Map(deepItems.map(item => [String(item?.code ?? ''), item]));
  const missingDeep = selectedCodes.filter(code => !deepByCode.has(code));
  const degradedDeep = deepItems.filter(item =>
    item?.error || item?.dataQuality?.degraded === true ||
    item?.dataQuality?.klineSource !== 'eastmoney' ||
    item?.dataQuality?.flowSource !== 'eastmoney'
  );
  const discoveryDegraded = discoveryPayload?.quality?.degraded === true ||
    discoveryPayload?.source === 'ranked-candidate-sector-proxy-v1';
  const psychologyUnavailable = (psychologyDiagnostics.conceptRows ?? 0) <= 0 ||
    (psychologyDiagnostics.themeCount ?? psychology?.themes?.length ?? 0) <= 0;
  const reasons = [];
  if (rankedCandidates.length < 5) reasons.push('ranked-candidates-insufficient');
  if (missingDeep.length) reasons.push('deep-candidates-missing');
  if (degradedDeep.length) reasons.push('deep-source-degraded');
  if (discoveryDegraded) reasons.push('discovery-source-degraded');
  if (psychologyUnavailable) reasons.push('psychology-source-unavailable');
  if (!decision?.asOf) reasons.push('snapshot-asof-missing');
  return {
    status:reasons.length ? 'SOURCE_UNAVAILABLE' : 'CAPTURED',
    valid:reasons.length === 0,
    reasons,
    rankedCandidateCount:rankedCandidates.length,
    selectedCodeCount:selectedCodes.length,
    deepItemCount:deepItems.length,
    missingDeepCodes:missingDeep,
    degradedDeepCount:degradedDeep.length,
    discoveryDegraded,
    psychologyConceptRows:psychologyDiagnostics.conceptRows ?? null,
    psychologyThemeCount:psychologyDiagnostics.themeCount ?? psychology?.themes?.length ?? 0,
    psychologyResearchFailures:psychologyDiagnostics.researchFailures ?? 0,
    decisionCandidateCount:decision?.ranking?.length ?? 0,
    decisionQualityComplete:decision?.ranking?.filter(row => row.quality?.complete === true).length ?? 0
  };
}

export function validateCapturedSnapshot(snapshot = {}) {
  const reasons = [];
  if (snapshot.schema !== 'v12-live-snapshot-v1') reasons.push('schema-invalid');
  if (!snapshot.snapshotId) reasons.push('snapshot-id-missing');
  if (!snapshot.capturedAt || !Number.isFinite(Date.parse(snapshot.capturedAt))) reasons.push('captured-at-invalid');
  if (!snapshot.asOf || !Number.isFinite(Date.parse(snapshot.asOf))) reasons.push('asof-invalid');
  const candidates = snapshot?.decision?.datasetCandidates;
  if (!Array.isArray(candidates) || candidates.length < 5) reasons.push('candidate-count-insufficient');
  if (snapshot?.quality?.status !== 'CAPTURED' || snapshot?.quality?.valid !== true) reasons.push('source-quality-invalid');
  return {valid:reasons.length === 0, status:reasons.length ? 'INVALID_SNAPSHOT' : 'CAPTURED', reasons};
}

function median(values){
  const sorted=[...values].sort((a,b)=>a-b);
  if(!sorted.length)return null;
  const mid=Math.floor(sorted.length/2);
  return sorted.length%2?sorted[mid]:(sorted[mid-1]+sorted[mid])/2;
}
function buildRankedSectorProxy(candidates){
  const groups=new Map();
  for(const row of candidates){
    const industry=String(row?.f100??row?.industry??'').trim();
    const pct=Number(row?.f3??row?.pct??row?.changePct);
    if(!industry||!Number.isFinite(pct))continue;
    const bucket=groups.get(industry)||[];
    bucket.push(pct);
    groups.set(industry,bucket);
  }
  const sectors=[...groups.entries()]
    .map(([industry,pcts])=>({industry,medianPct:median(pcts),sampleCount:pcts.length}))
    .filter(row=>row.medianPct!==null)
    .sort((a,b)=>b.medianPct-a.medianPct||b.sampleCount-a.sampleCount||a.industry.localeCompare(b.industry));
  return {
    qualifiedForDiscovery:sectors.length>=5,
    quality:{qualified:sectors.length>=5,degraded:true},
    source:'ranked-candidate-sector-proxy-v1',
    sectorResearch:{sectors}
  };
}

const ranked = parseResult(
  'ranked_candidates',
  await invoke(marketHandler, '/api/market?action=ranked_candidates')
);

const rankedCandidates = ranked?.data?.candidates ?? [];
const selectedCandidates = selectV12Candidates(rankedCandidates, 30);
const codes = selectedCandidates.map(row => String(row?.f12 ?? ''));

if (codes.length < 5) {
  throw new Error('fewer than five eligible main-board candidates were returned');
}

const codeQuery = codes.join(',');
const [deep, discovery, psychology] = await Promise.all([
  invoke(marketHandler, '/api/market?action=deep_batch&codes=' + encodeURIComponent(codeQuery)),
  invoke(discoveryHandler, '/api/discovery_universe'),
  invoke(psychologyHandler, '/api/psychology_universe?codes=' + encodeURIComponent(codeQuery))
]);

const deepPayload = parseResult('deep_batch', deep);
const discoveryPayload = discovery.statusCode === 200
  ? parseResult('discovery_universe', discovery)
  : buildRankedSectorProxy(rankedCandidates);
const psychologyPayload = parseResult('psychology_universe', psychology);

assertQualifiedDiscovery(discoveryPayload);

const rankedForV12 = {
  ...ranked,
  data:{
    ...ranked.data,
    candidates:rankedCandidates.filter(row => codes.includes(String(row?.f12 ?? '')))
  }
};
const decision = integrateCandidateFlow({
  ranked:rankedForV12,
  deep:deepPayload,
  discovery:discoveryPayload,
  psychology:psychologyPayload?.data ?? psychologyPayload
}, {
  asOf:ranked?.data?.generatedAt
});

const capturedAt = new Date().toISOString();
const qualitySummary = sourceQualitySummary({
  rankedCandidates, selectedCodes:codes, deepPayload, discoveryPayload,
  psychologyPayload, decision
});
const contractQuality = contractSourceQuality({
  ranked, deep:deepPayload, discovery:discoveryPayload,
  psychology:psychologyPayload, decision, quoteRows:rankedCandidates,
  asOf:decision.asOf
});
const sourceQuality = {...qualitySummary, ...contractQuality};
const output = {
  schema:'v12-live-snapshot-v1',
  snapshotId:canonicalSnapshotId(decision.asOf ?? capturedAt),
  capturedAt,
  asOf:decision.asOf,
  modelVersions:MODEL_VERSIONS,
  quality:sourceQuality,
  sourcePolicy:{
    provider:'Eastmoney',
    pointInTime:'captured-at-source',
    futureDataExcludedByAsOf:true,
    brokerConnected:false,
    automaticOrderPlacement:false
  },
  inputs:{
    ranked,
    deep:deepPayload,
    discovery:discoveryPayload,
    psychology:psychologyPayload
  },
  decision:{
    schema:decision.schema,
    version:decision.version,
    asOf:decision.asOf,
    market:decision.market,
    diagnostics:decision.diagnostics,
    datasetCandidates:decision.ranking.map(row => ({
      ...row,
      selectionScore:row.scores?.v12SelectionRaw ?? row.scores?.v12Selection ?? null
    })),
    tradeRanking:decision.tradeRanking.slice(0, 20).map(row => ({
      tradeRank:row.tradeRank,
      symbol:row.symbol,
      name:row.name,
      industry:row.industry,
      price:row.price,
      marketRisk:row.marketRisk,
      alpha:row.scores?.alpha ?? null,
      timing:row.scores?.timing ?? null,
      psychology:row.scores?.psychology ?? null,
      v12Trade:row.scores?.v12Trade ?? null,
      psychologyStage:row.psychology?.stage ?? 'unknown',
      primaryTheme:row.psychology?.primaryTheme ?? null,
      fomoRisk:row.psychology?.fomoRisk ?? null,
      quality:row.quality
    }))
  }
};

const validation = validateCapturedSnapshot(output);
const contractValidation = validateSnapshot(output);
if (!validation.valid || !contractValidation.valid) {
  console.error(JSON.stringify({
    status:validation.status,
    snapshotId:output.snapshotId,
    reasons:[...sourceQuality.reasons, ...validation.reasons, ...contractValidation.reasons]
  }, null, 2));
  throw new Error('snapshot validation failed');
}
const outputFile = snapshotPath(process.argv[2]);
await mkdir(dirname(outputFile), {recursive:true});
await writeFile(outputFile, JSON.stringify(output, null, 2) + '\n', 'utf8');

const deepDiagnostics = (deepPayload?.items ?? []).slice(0, 10).map(item => ({
  code:item?.code ?? null,
  klineRows:Array.isArray(item?.kline?.data?.klines) ? item.kline.data.klines.length : 0,
  flowRows:Array.isArray(item?.flow?.data?.klines) ? item.flow.data.klines.length : 0,
  klineSource:item?.dataQuality?.klineSource ?? null,
  flowSource:item?.dataQuality?.flowSource ?? null,
  error:item?.error ?? null
}));
const blockCounts = {};
for (const row of decision.ranking) {
  for (const reason of row.quality?.blockedReasons ?? []) {
    blockCounts[reason] = (blockCounts[reason] ?? 0) + 1;
  }
}
const modelTop = decision.ranking.slice(0, 10).map(row => ({
  rank:row.rank ?? null,
  symbol:row.symbol,
  name:row.name,
  alpha:row.scores?.alpha ?? null,
  timing:row.scores?.timing ?? null,
  psychology:row.scores?.psychology ?? null,
  v12Trade:row.scores?.v12Trade ?? null,
  psychComplete:row.psychology?.complete === true,
  qualityComplete:row.quality?.complete === true,
  blockedReasons:(row.quality?.blockedReasons ?? []).slice(0, 6),
  missing:(row.quality?.missing ?? []).slice(0, 6)
}));
console.log(JSON.stringify({
  status:output.status ?? 'CAPTURED',
  file:outputFile,
  capturedAt,
  asOf:decision.asOf,
  candidatePool:codes.length,
  rankingCount:decision.ranking.length,
  qualityComplete:decision.ranking.filter(row => row.quality?.complete === true).length,
  psychologyComplete:decision.diagnostics.psychologyComplete,
  v12Scoreable:decision.ranking.filter(row => row.scores?.v12TradeRaw !== null).length,
  v12Eligible:decision.diagnostics.v12Eligible,
  blockedReasonCounts:blockCounts,
  deepDiagnostics,
  modelTop,
  top5:decision.tradeRanking.slice(0, 5).map(row => ({
    rank:row.tradeRank,
    symbol:row.symbol,
    name:row.name,
    v12Trade:row.scores?.v12Trade ?? null
  }))
}, null, 2));

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // All work is performed at module scope so a failed source call exits non-zero.
}
