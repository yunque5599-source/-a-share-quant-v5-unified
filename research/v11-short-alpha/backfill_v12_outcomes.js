import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import marketHandler from '../../api/market.js';
import { evaluateOne, parseDailyBars } from './evaluate_v12_snapshot.js';

function invoke(handler, url) {
  return new Promise((resolvePromise, reject) => {
    let body = '';
    const response = {
      statusCode:200,
      setHeader() {},
      status(code) { this.statusCode = code; return this; },
      json(value) { body = JSON.stringify(value); resolvePromise({statusCode:this.statusCode, body}); },
      send(value) { body = typeof value === 'string' ? value : JSON.stringify(value); resolvePromise({statusCode:this.statusCode, body}); },
      end(value = '') { body = typeof value === 'string' ? value : JSON.stringify(value); resolvePromise({statusCode:this.statusCode, body}); }
    };
    Promise.resolve(handler({method:'GET', url}, response)).catch(reject);
  });
}

function list(value) { return Array.isArray(value) ? value : []; }
function markPending(row) {
  const horizons = Object.fromEntries([1,2,3,4,5].map(h => {
    const item = {...(row.horizons?.['t' + h] ?? {})};
    item.status = Number.isFinite(item.returnPct) ? 'complete' : 'pending';
    return ['t' + h, item];
  }));
  return {...row, horizons, horizonProfile:horizons};
}

export async function backfillSnapshot(snapshot, {market = marketHandler} = {}) {
  const candidates = list(snapshot?.decision?.datasetCandidates ?? snapshot?.decision?.ranking);
  if (!candidates.length) throw new Error('snapshot contains no datasetCandidates');
  const codes = [...new Set(candidates.map(row => String(row?.symbol ?? ''))
    .filter(code => /^(00|60)\d{4}$/.test(code)))];
  if (!codes.length) throw new Error('snapshot contains no eligible stock codes');
  const response = await invoke(market, '/api/market?action=deep_batch&codes=' + encodeURIComponent(codes.join(',')));
  if (response.statusCode !== 200) {
    throw new Error('deep_batch unavailable HTTP ' + response.statusCode);
  }
  const payload = JSON.parse(response.body);
  const byCode = new Map(list(payload?.items).map(item => [String(item?.code ?? ''), item]));
  const signals = candidates.map(candidate => {
    const code = String(candidate?.symbol ?? '');
    const item = byCode.get(code);
    const bars = parseDailyBars(item?.kline);
    const evaluated = evaluateOne(candidate, bars, {snapshot});
    return markPending(evaluated);
  });
  return {
    schema:'v12-forward-outcome-v2',
    snapshotId:snapshot.snapshotId ?? null,
    evaluatedAt:new Date().toISOString(),
    sourceSnapshot:{
      snapshotId:snapshot.snapshotId ?? null,
      capturedAt:snapshot.capturedAt ?? null,
      asOf:snapshot.asOf ?? null,
      schema:snapshot.schema ?? null,
      market:snapshot.decision?.market ?? snapshot.market ?? null,
      sourcePolicy:snapshot.sourcePolicy ?? null
    },
    measurementPolicy:{
      entry:'snapshot decision price; not broker fill',
      horizons:'T+1..T+5 trading sessions strictly after Asia/Shanghai asOf',
      pending:'missing future trading session remains pending; never zero-filled',
      originalFeatures:'features and psychology are copied from the raw snapshot only'
    },
    summary:{
      candidateCount:signals.length,
      completeT1:signals.filter(row => row.horizons.t1.status === 'complete').length,
      completeT5:signals.filter(row => row.horizons.t5.status === 'complete').length,
      pendingT1:signals.filter(row => row.horizons.t1.status === 'pending').length,
      pendingT5:signals.filter(row => row.horizons.t5.status === 'pending').length
    },
    signals
  };
}

async function main(args) {
  const inputIndex = args.indexOf('--input');
  if (inputIndex < 0 || !args[inputIndex + 1]) {
    throw new Error('usage: node backfill_v12_outcomes.js --input SNAPSHOT.json --output OUTCOME.json');
  }
  const outputIndex = args.indexOf('--output');
  if (outputIndex < 0 || !args[outputIndex + 1]) throw new Error('--output is required');
  const snapshot = JSON.parse(await readFile(resolve(args[inputIndex + 1]), 'utf8'));
  const result = await backfillSnapshot(snapshot);
  const output = resolve(args[outputIndex + 1]);
  await mkdir(dirname(output), {recursive:true});
  await writeFile(output, JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({status:'OUTCOME_BACKFILLED',output,snapshotId:result.snapshotId,...result.summary},null,2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2));
