import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import marketHandler from '../../api/market.js';

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

function n(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseDailyBars(raw) {
  const rows = Array.isArray(raw) ? raw : raw?.data?.klines ?? raw?.klines ?? [];
  return rows.map(row => {
    const fields = typeof row === 'string' ? row.split(',') : row;
    return {
      date:String(Array.isArray(fields) ? fields?.[0] ?? '' : fields?.date ?? ''),
      close:n(Array.isArray(fields) ? fields?.[2] : fields?.close ?? fields?.price),
      high:n(Array.isArray(fields) ? fields?.[3] : fields?.high),
      low:n(Array.isArray(fields) ? fields?.[4] : fields?.low)
    };
  }).filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && row.close > 0)
    .sort((a,b) => a.date.localeCompare(b.date));
}

function asOfDate(asOf) {
  const match = String(asOf ?? '').match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? null;
}

function forwardBars(bars, cutoff) {
  if (!cutoff) return [];
  return bars.filter(row => row.date > cutoff);
}

function evaluateOne(signal, bars) {
  const entryPrice = n(signal?.price);
  const cutoff = asOfDate(signal?.asOf);
  const future = forwardBars(bars, cutoff).slice(0, 5);
  const result = {
    symbol:String(signal?.symbol ?? ''),
    name:String(signal?.name ?? ''),
    tradeRank:n(signal?.tradeRank),
    asOf:signal?.asOf ?? null,
    entryPrice,
    cutoffDate:cutoff,
    availableForwardBars:future.length,
    horizons:{},
    maxFavorableReturn5d:null,
    maxAdverseReturn5d:null,
    outcomeStatus:entryPrice > 0 && future.length > 0 ? 'partial' : 'pending'
  };

  for (const horizon of [1,3,5]) {
    const bar = future[horizon - 1];
    if (!bar) {
      result.horizons['t' + horizon] = null;
      continue;
    }
    result.horizons['t' + horizon] = {
      date:bar.date,
      close:bar.close,
      returnPct:(bar.close / entryPrice - 1) * 100
    };
  }

  if (entryPrice > 0 && future.length) {
    const highs = future.map(row => row.high).filter(value => value !== null);
    const lows = future.map(row => row.low).filter(value => value !== null);
    if (highs.length) result.maxFavorableReturn5d = (Math.max(...highs) / entryPrice - 1) * 100;
    if (lows.length) result.maxAdverseReturn5d = (Math.min(...lows) / entryPrice - 1) * 100;
  }

  if (future.length >= 5) result.outcomeStatus = 'complete';
  return result;
}

function aggregate(rows) {
  const usable = rows.filter(row => row.entryPrice > 0);
  const summary = {count:usable.length, horizons:{}};
  for (const horizon of [1,3,5]) {
    const key = 't' + horizon;
    const returns = usable.map(row => row.horizons[key]?.returnPct).filter(value => value !== null);
    summary.horizons[key] = {
      n:returns.length,
      avgReturnPct:returns.length ? returns.reduce((sum,v) => sum + v, 0) / returns.length : null,
      medianReturnPct:returns.length ? [...returns].sort((a,b) => a-b)[Math.floor(returns.length / 2)] : null,
      winRatePct:returns.length ? returns.filter(value => value > 0).length / returns.length * 100 : null,
      lossRatePct:returns.length ? returns.filter(value => value < 0).length / returns.length * 100 : null
    };
  }
  const maxFav = usable.map(row => row.maxFavorableReturn5d).filter(value => value !== null);
  const maxAdv = usable.map(row => row.maxAdverseReturn5d).filter(value => value !== null);
  summary.mfe5dAvgPct = maxFav.length ? maxFav.reduce((sum,v) => sum + v, 0) / maxFav.length : null;
  summary.mae5dAvgPct = maxAdv.length ? maxAdv.reduce((sum,v) => sum + v, 0) / maxAdv.length : null;
  return summary;
}

export { parseDailyBars, asOfDate, forwardBars, evaluateOne, aggregate };

async function main() {
const inputFile = process.argv[2];
if (!inputFile) throw new Error('usage: node evaluate_v12_snapshot.js <snapshot.json> [output.json]');

const snapshot = JSON.parse(await readFile(resolve(inputFile), 'utf8'));
const signals = (snapshot?.decision?.tradeRanking ?? []).slice(0, 20);
const codes = [...new Set(signals.map(row => String(row?.symbol ?? '')).filter(code => /^\d{6}$/.test(code)))];
if (!codes.length) throw new Error('snapshot contains no trade-ranking symbols');

const response = await invoke(
  marketHandler,
  '/api/market?action=deep_batch&codes=' + encodeURIComponent(codes.join(','))
);
if (response.statusCode !== 200) {
  throw new Error('deep_batch returned HTTP ' + response.statusCode + ': ' + response.body.slice(0, 500));
}
const payload = JSON.parse(response.body);
const byCode = new Map((payload?.items ?? []).map(item => [String(item?.code ?? ''), item]));

const evaluated = signals.map(signal => evaluateOne(signal, parseDailyBars(byCode.get(String(signal.symbol)))));
const output = {
  schema:'v12-forward-outcome-v1',
  evaluatedAt:new Date().toISOString(),
  sourceSnapshot:{
    capturedAt:snapshot?.capturedAt ?? null,
    asOf:snapshot?.asOf ?? null,
    schema:snapshot?.schema ?? null
  },
  measurementPolicy:{
    entry:'snapshot decision price; not a broker fill',
    forwardBars:'first T+1/T+3/T+5 trading-day daily closes strictly after snapshot as-of date',
    sameDayBarExcluded:true,
    futureDataLeakageGuard:'bars with date <= snapshot as-of date are excluded',
    feesSlippageExcluded:true
  },
  summary:{
    top1:aggregate(evaluated.slice(0,1)),
    top5:aggregate(evaluated.slice(0,5)),
    top10:aggregate(evaluated.slice(0,10)),
    top20:aggregate(evaluated)
  },
  signals:evaluated
};

const outputFile = resolve(process.argv[3] || inputFile.replace(/\.json$/i, '-outcome.json'));
await mkdir(dirname(outputFile), {recursive:true});
await writeFile(outputFile, JSON.stringify(output, null, 2) + '\n', 'utf8');

console.log(JSON.stringify({
  status:'V12_FORWARD_OUTCOME_CAPTURED',
  outputFile,
  sourceAsOf:output.sourceSnapshot.asOf,
  top1:output.summary.top1,
  top5:output.summary.top5,
  completeSignals:evaluated.filter(row => row.outcomeStatus === 'complete').length
}, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
