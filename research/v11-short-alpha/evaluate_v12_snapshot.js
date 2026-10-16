import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import marketHandler from '../../api/market.js';
import { asOfDate as normalizeAsOfDate, finiteNumber } from './schema.js';

const HORIZONS = Object.freeze([1, 2, 3, 4, 5]);
const n = value => finiteNumber(value);
const list = value => Array.isArray(value) ? value : [];
const metric = value => value === null || !Number.isFinite(value) ? null :
  Math.round(value * 100) / 100;
const mean = values => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

function parseDailyBars(raw) {
  const rows = Array.isArray(raw)
    ? raw : raw?.data?.klines ?? raw?.klines ?? raw?.rows ?? raw?.bars ?? [];
  return rows.map(row => {
    const fields = typeof row === 'string' ? row.split(',') : row;
    const array = Array.isArray(fields);
    return {
      date: String(array ? fields?.[0] ?? '' : row?.date ?? row?.time ?? ''),
      close: n(array ? fields?.[2] : row?.close ?? row?.price),
      high: n(array ? fields?.[3] : row?.high),
      low: n(array ? fields?.[4] : row?.low)
    };
  }).filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && row.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function asOfDate(asOf) {
  return normalizeAsOfDate(asOf);
}

function forwardBars(bars, cutoff) {
  if (!cutoff) return [];
  return list(bars).filter(row => row.date > cutoff);
}

function sourceRows(source, industry) {
  if (!source) return [];
  if (Array.isArray(source)) return source;
  if (industry && Array.isArray(source[industry])) return source[industry];
  return source?.bars ?? source?.history ?? source?.data?.bars ?? source?.data?.klines ?? [];
}

function benchmarkReturn(source, cutoff, horizon, industry) {
  const bars = parseDailyBars(sourceRows(source, industry));
  const before = bars.filter(row => row.date <= cutoff).at(-1);
  const future = forwardBars(bars, cutoff);
  const exit = future[horizon - 1];
  if (!before || !exit || !(before.close > 0)) return null;
  return (exit.close / before.close - 1) * 100;
}

function selectionScoreOf(signal = {}) {
  return n(signal?.selectionScore ?? signal?.scores?.v12SelectionRaw ??
    signal?.scores?.v12Selection ?? signal?.scores?.v12TradeRaw ??
    signal?.scores?.v12Trade);
}

function pathMetric(future, entry, horizon, field, direction) {
  const path = future.slice(0, horizon);
  if (!(entry > 0) || path.length < horizon ||
      path.some(row => n(row[field]) === null)) return null;
  const values = path.map(row => (row[field] / entry - 1) * 100);
  return direction === 'max' ? Math.max(...values) : Math.min(...values);
}

function patternFor(profile) {
  const values = HORIZONS.map(h => profile['t' + h]?.returnPct)
    .filter(value => Number.isFinite(value));
  if (!values.length) return 'no-persistence';
  const best = values.indexOf(Math.max(...values)) + 1;
  const first = values[0], last = values.at(-1);
  const mfe = profile['t' + best]?.mfePct;
  const reversal = first > 0 && last < first && (mfe ?? first) > first * 1.5;
  if (reversal) return 'fast-spike-reversal';
  if (best === 1 && values.length >= 2) return 'overnight-type';
  if (best <= 3 && last >= first) return 'two-three-day-burst';
  if (best >= 4 && last > 0) return 'three-five-day-trend';
  if (first <= 0 && last > first && last > 0) return 'slow-start';
  return 'no-persistence';
}

function evaluateOne(signal = {}, bars = [], options = {}) {
  const entryPrice = n(signal?.price);
  const cutoff = asOfDate(signal?.asOf);
  const future = forwardBars(bars, cutoff).slice(0, 5);
  const industry = signal?.industry ?? signal?.sector?.industry ?? null;
  const marketSource = options.marketHistory ?? options.marketBars ??
    signal?.marketHistory ?? signal?.marketBars ??
    options.snapshot?.marketHistory ?? options.snapshot?.marketBars ??
    options.snapshot?.inputs?.marketHistory ?? options.snapshot?.inputs?.marketBars ??
    options.snapshot?.indexHistory ?? options.snapshot?.indicesHistory ??
    options.snapshot?.inputs?.indexHistory ?? options.snapshot?.inputs?.indicesHistory;
  const sectorSource = options.sectorHistories ?? options.sectorHistory ??
    signal?.sectorHistories ?? signal?.sectorHistory ??
    options.snapshot?.sectorHistories ?? options.snapshot?.sectorHistory ??
    options.snapshot?.inputs?.sectorHistories ?? options.snapshot?.inputs?.sectorHistory;
  const profile = {};
  const result = {
    symbol:String(signal?.symbol ?? signal?.code ?? ''),
    name:String(signal?.name ?? ''),
    industry,
    tradeRank:n(signal?.tradeRank ?? signal?.rank),
    selectionScore:selectionScoreOf(signal),
    asOf:signal?.asOf ?? null,
    entryPrice,
    cutoffDate:cutoff,
    availableForwardBars:future.length,
    horizons:profile,
    horizonProfile:profile,
    bestHorizon:null,
    bestHorizonBasis:null,
    shortPattern:null,
    maxFavorableReturn5d:null,
    maxAdverseReturn5d:null,
    outcomeStatus:entryPrice > 0 && future.length > 0 ? 'partial' : 'pending'
  };
  for (const horizon of HORIZONS) {
    const bar = future[horizon - 1];
    const absolute = bar && entryPrice > 0
      ? (bar.close / entryPrice - 1) * 100 : null;
    const market = cutoff ? benchmarkReturn(marketSource, cutoff, horizon) : null;
    const sector = cutoff ? benchmarkReturn(sectorSource, cutoff, horizon, industry) : null;
    const marketExcess = absolute === null || market === null ? null : absolute - market;
    const sectorExcess = absolute === null || sector === null ? null : absolute - sector;
    const item = {
      date:bar?.date ?? null, close:bar?.close ?? null,
      returnPct:metric(absolute),
      marketExcessReturnPct:metric(marketExcess),
      sectorExcessReturnPct:metric(sectorExcess),
      marketReturnPct:metric(market),
      sectorReturnPct:metric(sector),
      mfePct:metric(pathMetric(future, entryPrice, horizon, 'high', 'max')),
      maePct:metric(pathMetric(future, entryPrice, horizon, 'low', 'min')),
      winLoss:absolute === null ? null : absolute > 0 ? 'win' : absolute < 0 ? 'loss' : 'flat',
      win:absolute === null ? null : absolute > 0
    };
    profile['t' + horizon] = item;
    result['return_' + horizon + 'd'] = item.returnPct;
    result['market_excess_return_' + horizon + 'd'] = item.marketExcessReturnPct;
    result['sector_excess_return_' + horizon + 'd'] = item.sectorExcessReturnPct;
    result['MFE_' + horizon + 'd'] = item.mfePct;
    result['MAE_' + horizon + 'd'] = item.maePct;
  }
  const basisValues = HORIZONS.map(h => {
    const item = profile['t' + h];
    const value = item?.marketExcessReturnPct ?? item?.returnPct;
    return {h, value};
  }).filter(item => Number.isFinite(item.value));
  if (basisValues.length) {
    const best = basisValues.reduce((current, item) =>
      item.value > current.value ? item : current);
    result.bestHorizon = 'T+' + best.h;
    result.bestHorizonBasis = profile['t' + best.h]?.marketExcessReturnPct !== null &&
      profile['t' + best.h]?.marketExcessReturnPct !== undefined
      ? 'market-excess-return' : 'absolute-return';
  }
  result.shortPattern = patternFor(profile);
  result.maxFavorableReturn5d = result.MFE_5d;
  result.maxAdverseReturn5d = result.MAE_5d;
  if (future.length >= 5 && entryPrice > 0) result.outcomeStatus = 'complete';
  return result;
}

function quantileRows(rows, fraction, direction = 'top') {
  const valid = rows.filter(row => Number.isFinite(row.selectionScore));
  if (!valid.length) return [];
  const count = Math.max(1, Math.ceil(valid.length * fraction));
  return [...valid].sort((a, b) => direction === 'top'
    ? b.selectionScore - a.selectionScore : a.selectionScore - b.selectionScore).slice(0, count);
}

function outcomeSummary(rows, horizon) {
  const values = rows.map(row => row.horizons?.['t' + horizon]?.returnPct)
    .filter(value => Number.isFinite(value));
  const excess = rows.map(row => row.horizons?.['t' + horizon]?.marketExcessReturnPct)
    .filter(value => Number.isFinite(value));
  const sector = rows.map(row => row.horizons?.['t' + horizon]?.sectorExcessReturnPct)
    .filter(value => Number.isFinite(value));
  const mfe = rows.map(row => row.horizons?.['t' + horizon]?.mfePct)
    .filter(value => Number.isFinite(value));
  const mae = rows.map(row => row.horizons?.['t' + horizon]?.maePct)
    .filter(value => Number.isFinite(value));
  return {
    n:values.length,
    avgReturnPct:metric(mean(values)),
    avgMarketExcessReturnPct:metric(mean(excess)),
    avgSectorExcessReturnPct:metric(mean(sector)),
    winRatePct:values.length ? metric(values.filter(value => value > 0).length / values.length * 100) : null,
    mfeAvgPct:metric(mean(mfe)), maeAvgPct:metric(mean(mae))
  };
}

function aggregate(rows) {
  const usable = rows.filter(row => row.entryPrice > 0);
  const summary = {count:usable.length, horizons:{}, quantiles:{}};
  for (const horizon of HORIZONS) summary.horizons['t' + horizon] = outcomeSummary(usable, horizon);
  for (const [name, fraction] of [['top1pct',0.01],['top5pct',0.05],['top10pct',0.10],['top20pct',0.20]]) {
    const top = quantileRows(usable, fraction);
    const bottom = quantileRows(usable, fraction, 'bottom');
    const bottomSummary = HORIZONS.reduce((out,h) => {
      const metricTop = outcomeSummary(top, h);
      const metricBottom = outcomeSummary(bottom, h);
      out['t' + h] = {
        ...metricBottom,
        topBottomSpreadPct:metric(metricTop.avgReturnPct === null || metricBottom.avgReturnPct === null
          ? null : metricTop.avgReturnPct - metricBottom.avgReturnPct)
      };
      return out;
    }, {});
    summary.quantiles[name] = {
      n:top.length,
      horizons:Object.fromEntries(HORIZONS.map(h => ['t' + h, outcomeSummary(top, h)])),
      bottom:bottomSummary,
      // Retain the old alias while making the bottom sample match this quantile.
      bottom20:bottomSummary
    };
  }
  const maxFav = usable.map(row => row.maxFavorableReturn5d).filter(value => value !== null);
  const maxAdv = usable.map(row => row.maxAdverseReturn5d).filter(value => value !== null);
  summary.mfe5dAvgPct = metric(mean(maxFav));
  summary.mae5dAvgPct = metric(mean(maxAdv));
  return summary;
}

export { parseDailyBars, asOfDate, forwardBars, evaluateOne, aggregate,
  selectionScoreOf, outcomeSummary };

async function main() {
  const inputFile = process.argv[2];
  if (!inputFile) throw new Error('usage: node evaluate_v12_snapshot.js <snapshot.json> [output.json]');
  const snapshot = JSON.parse(await readFile(resolve(inputFile), 'utf8'));
  const signals = list(snapshot?.decision?.datasetCandidates ??
    snapshot?.decision?.ranking ?? snapshot?.decision?.candidates ??
    snapshot?.decision?.tradeRanking);
  if (!signals.length) throw new Error('snapshot contains no dataset candidates');
  const codes = [...new Set(signals.map(row => String(row?.symbol ?? '')).filter(code => /^\d{6}$/.test(code)))];
  const response = await invoke(marketHandler, '/api/market?action=deep_batch&codes=' +
    encodeURIComponent(codes.join(',')));
  if (response.statusCode !== 200) throw new Error('deep_batch returned HTTP ' + response.statusCode);
  const payload = JSON.parse(response.body);
  const byCode = new Map((payload?.items ?? []).map(item => [String(item?.code ?? ''), item]));
  const evaluated = signals.map(signal => evaluateOne(signal,
    parseDailyBars(byCode.get(String(signal.symbol))), {snapshot}));
  const output = {
    schema:'v12-forward-outcome-v2',
    evaluatedAt:new Date().toISOString(),
    sourceSnapshot:{capturedAt:snapshot?.capturedAt ?? null,asOf:snapshot?.asOf ?? null,schema:snapshot?.schema ?? null},
    measurementPolicy:{entry:'snapshot decision price; not broker fill',horizons:'T+1..T+5 trading sessions strictly date > Asia/Shanghai snapshot asOf',sameDayBarExcluded:true,benchmarksMissing:'market/sector excess is null; no zero fill'},
    summary:aggregate(evaluated),
    signals:evaluated
  };
  const outputFile=resolve(process.argv[3] || inputFile.replace(/\.json$/i,'-outcome.json'));
  await mkdir(dirname(outputFile),{recursive:true});
  await writeFile(outputFile,JSON.stringify(output,null,2)+'\n','utf8');
  console.log(JSON.stringify({status:'V12_FORWARD_OUTCOME_CAPTURED',outputFile,sourceAsOf:output.sourceSnapshot.asOf,completeSignals:evaluated.filter(row=>row.outcomeStatus==='complete').length},null,2));
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) await main();
