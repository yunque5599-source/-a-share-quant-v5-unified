import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import marketHandler from '../../api/market.js';
import discoveryHandler from '../../api/discovery_universe.js';
import psychologyHandler from '../../api/psychology_universe.js';
import { integrateCandidateFlow } from './candidate_flow.js';

const MODEL_VERSIONS = Object.freeze({
  alpha:'V11 Short Alpha Phase 1',
  timing:'Buy Timing Phase 1',
  psychology:'V12 Psychology Score Phase 3 Behavioral',
  trade:'V12 Trade Score Phase 1'
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

const ranked = parseResult(
  'ranked_candidates',
  await invoke(marketHandler, '/api/market?action=ranked_candidates')
);

const rankedCandidates = ranked?.data?.candidates ?? [];
const codes = [...new Set(
  rankedCandidates
    .map(row => String(row?.f12 ?? ''))
    .filter(code => /^(00|60)\d{4}$/.test(code))
)].slice(0, 30);

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
const discoveryPayload = parseResult('discovery_universe', discovery);
const psychologyPayload = parseResult('psychology_universe', psychology);

assertQualifiedDiscovery(discoveryPayload);

const decision = integrateCandidateFlow({
  ranked,
  deep:deepPayload,
  discovery:discoveryPayload,
  psychology:psychologyPayload?.data ?? psychologyPayload
}, {
  asOf:ranked?.data?.generatedAt
});

const capturedAt = new Date().toISOString();
const output = {
  schema:'v12-live-snapshot-v1',
  capturedAt,
  asOf:decision.asOf,
  modelVersions:MODEL_VERSIONS,
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
  status:'LIVE_SNAPSHOT_CAPTURED',
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
