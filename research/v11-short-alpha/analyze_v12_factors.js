import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const FACTOR_VALIDATION_VERSION = 'V12 Factor Validation v1';
export const MIN_SAMPLE = 30;
export const ML_READINESS_REQUIREMENTS = Object.freeze({
  snapshots:20,
  candidateOutcomes:1000
});
const HORIZONS = Object.freeze([1, 2, 3, 4, 5]);
const FACTOR_NAMES = Object.freeze([
  'trendStructure', 'momentum', 'capitalFlow', 'volume', 'sector',
  'psychology', 'leader', 'imagination', 'timing', 'risk'
]);
const list = value => Array.isArray(value) ? value : [];
const n = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const metric = value => value === null || !Number.isFinite(value)
  ? null : Math.round(value * 10000) / 10000;
const mean = values => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const statusFor = count => count < MIN_SAMPLE ? 'INSUFFICIENT_SAMPLE' : 'OK';

function pearson(left, right) {
  if (left.length < 3 || left.length !== right.length) return null;
  const leftMean = mean(left), rightMean = mean(right);
  const numerator = left.reduce((sum, value, index) =>
    sum + (value - leftMean) * (right[index] - rightMean), 0);
  const leftDenom = Math.sqrt(left.reduce((sum, value) =>
    sum + (value - leftMean) ** 2, 0));
  const rightDenom = Math.sqrt(right.reduce((sum, value) =>
    sum + (value - rightMean) ** 2, 0));
  return leftDenom && rightDenom ? numerator / (leftDenom * rightDenom) : null;
}

function ranks(values) {
  const indexed = values.map((value, index) => ({value, index}))
    .sort((a, b) => a.value - b.value || a.index - b.index);
  const output = Array(values.length);
  for (let start = 0; start < indexed.length;) {
    let end = start + 1;
    while (end < indexed.length && indexed[end].value === indexed[start].value) end += 1;
    const rank = (start + end - 1) / 2 + 1;
    for (let index = start; index < end; index += 1) output[indexed[index].index] = rank;
    start = end;
  }
  return output;
}

function signalsOf(snapshot) {
  if (Array.isArray(snapshot?.signals)) return snapshot.signals;
  if (Array.isArray(snapshot?.evaluated)) return snapshot.evaluated;
  if (Array.isArray(snapshot?.decision?.datasetCandidates)) return snapshot.decision.datasetCandidates;
  if (Array.isArray(snapshot?.decision?.tradeRanking)) return snapshot.decision.tradeRanking;
  return [];
}

function outcomeOf(row, horizon) {
  return row?.horizons?.['t' + horizon] ?? null;
}

function themeMatch(row) {
  const psychology = row?.psychology ?? {};
  const primary = psychology.primaryTheme;
  const themes = list(psychology.themes);
  const code = primary?.code ?? primary?.themeCode ?? primary?.id;
  return themes.find(theme => code && (theme.themeCode === code || theme.code === code)) ??
    themes[0] ?? null;
}

function componentScore(row, name) {
  const psychology = row?.psychology ?? {};
  const theme = themeMatch(row);
  return n(psychology?.[name]?.score ?? psychology?.[name]) ??
    n(theme?.components?.[name]?.score ?? theme?.[name]?.score);
}

function themeScore(row) {
  const theme = themeMatch(row);
  return n(theme?.score ?? row?.psychology?.primaryTheme?.score);
}

const FACTOR_GETTERS = Object.freeze({
  trendStructure:row => n(row?.features?.trendStructure?.score ?? row?.trendStructure?.score),
  momentum:row => n(row?.features?.momentum?.score),
  capitalFlow:row => n(row?.features?.capital?.score),
  volume:row => n(row?.features?.volume?.score),
  sector:row => n(row?.features?.sector?.score),
  psychology:row => n(row?.psychology?.score ?? row?.scores?.psychologyRaw ?? row?.scores?.psychology),
  leader:row => componentScore(row, 'leader'),
  imagination:row => componentScore(row, 'imagination'),
  timing:row => n(row?.timing?.score ?? row?.scores?.timingRaw ?? row?.scores?.timing),
  risk:row => n(row?.features?.risk?.score)
});

function factorValue(row, factor) {
  return FACTOR_GETTERS[factor]?.(row) ?? null;
}

function marketRegimeOf(snapshot) {
  const raw = snapshot?.marketRegime ?? snapshot?.market?.regime ??
    snapshot?.decision?.market?.regime ?? snapshot?.decision?.market?.marketRegime ??
    snapshot?.decision?.market?.marketRisk ?? snapshot?.regime;
  const value = String(raw ?? '').toLowerCase();
  if (value === 'bull' || value === 'bullish' || value.includes('牛')) return 'bull';
  if (value === 'bear' || value === 'bearish' || value === 'weak' || value.includes('熊')) return 'bear';
  if (value === 'sideways' || value === 'neutral' || value === 'normal' ||
      value === 'elevated' || value.includes('震荡')) return 'neutral';
  return 'unknown';
}

function emotionOf(snapshot) {
  const value = String(snapshot?.marketEmotion?.label ??
    snapshot?.market?.emotion?.label ??
    snapshot?.decision?.market?.emotion?.label ??
    snapshot?.emotion?.label ?? '').toUpperCase();
  if (['FEVER', 'RISING'].includes(value)) return 'high';
  if (value === 'NEUTRAL') return 'normal';
  if (['FADING', 'PANIC'].includes(value)) return 'low';
  return 'unknown';
}

function timeBucketOf(snapshot) {
  const asOf = snapshot?.asOf ?? snapshot?.sourceSnapshot?.asOf ??
    snapshot?.decision?.asOf ?? null;
  if (!asOf) return 'unknown';
  const date = new Date(asOf);
  if (!Number.isFinite(date.getTime())) return 'unknown';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone:'Asia/Shanghai', hour:'2-digit', minute:'2-digit', hourCycle:'h23'
  }).formatToParts(date);
  const hour = parts.find(part => part.type === 'hour')?.value;
  const minute = parts.find(part => part.type === 'minute')?.value;
  const time = hour && minute ? hour + ':' + minute : null;
  return time === '11:15' ? 'morning_1115'
    : time === '13:30' ? 'afternoon_1330'
    : time === '14:45' ? 'close_1445' : 'unknown';
}

function metricBlock(rows, horizon) {
  const outcomes = rows.map(row => outcomeOf(row, horizon)).filter(Boolean);
  const returns = outcomes.map(item => n(item.returnPct)).filter(value => value !== null);
  const market = outcomes.map(item => n(item.marketExcessReturnPct)).filter(value => value !== null);
  const sector = outcomes.map(item => n(item.sectorExcessReturnPct)).filter(value => value !== null);
  const mfe = outcomes.map(item => n(item.mfePct)).filter(value => value !== null);
  const mae = outcomes.map(item => n(item.maePct)).filter(value => value !== null);
  const riskAdjusted = outcomes.map(item => {
    const value = n(item.returnPct);
    const adverse = n(item.maePct);
    return value === null ? null : value / Math.max(1, Math.abs(adverse ?? 0));
  }).filter(value => value !== null);
  return {
    sampleCount:returns.length,
    status:statusFor(returns.length),
    averageReturnPct:metric(mean(returns)),
    averageMarketExcessReturnPct:metric(mean(market)),
    averageSectorExcessReturnPct:metric(mean(sector)),
    riskAdjustedReturnPct:metric(mean(riskAdjusted)),
    winRatePct:returns.length ? metric(returns.filter(value => value > 0).length / returns.length * 100) : null,
    mfeAvgPct:metric(mean(mfe)),
    maeAvgPct:metric(mean(mae)),
    unavailableMarketExcess:outcomes.filter(item => item.marketExcessReturnPct === null).length,
    unavailableSectorExcess:outcomes.filter(item => item.sectorExcessReturnPct === null).length
  };
}

function validFactorRows(rows, factor, horizon) {
  return rows.filter(row => factorValue(row, factor) !== null &&
    n(outcomeOf(row, horizon)?.returnPct) !== null);
}

function groupedBySnapshot(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.__snapshotId ?? 'single';
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return groups;
}

function quantileRows(rows, factor, fraction, direction = 'top') {
  const selected = [];
  for (const group of groupedBySnapshot(rows).values()) {
    const valid = group.filter(row => factorValue(row, factor) !== null);
    if (!valid.length) continue;
    const count = Math.max(1, Math.ceil(valid.length * fraction));
    const sorted = [...valid].sort((left, right) => {
      const difference = factorValue(left, factor) - factorValue(right, factor);
      return direction === 'top' ? -difference : difference;
    });
    selected.push(...sorted.slice(0, count));
  }
  return selected;
}

function correlationBySnapshot(rows, factor, horizon, field) {
  const correlations = [];
  for (const group of groupedBySnapshot(rows).values()) {
    const pairs = group.map(row => ({
      score:factorValue(row, factor),
      value:n(outcomeOf(row, horizon)?.[field])
    })).filter(pair => pair.score !== null && pair.value !== null);
    if (pairs.length >= 3) {
      correlations.push(pearson(pairs.map(pair => pair.score), pairs.map(pair => pair.value)));
    }
  }
  return correlations.filter(value => value !== null);
}

function spearmanBySnapshot(rows, factor, horizon) {
  const values = [];
  for (const group of groupedBySnapshot(rows).values()) {
    const pairs = group.map(row => ({
      score:factorValue(row, factor),
      value:n(outcomeOf(row, horizon)?.returnPct)
    })).filter(pair => pair.score !== null && pair.value !== null);
    if (pairs.length >= 3) {
      values.push(pearson(
        ranks(pairs.map(pair => pair.score)),
        ranks(pairs.map(pair => pair.value))
      ));
    }
  }
  return values.filter(value => value !== null);
}

function factorHorizonMetrics(rows, factor, horizon) {
  const valid = validFactorRows(rows, factor, horizon);
  const top5 = metricBlock(quantileRows(valid, factor, 0.05), horizon);
  const top10 = metricBlock(quantileRows(valid, factor, 0.10), horizon);
  const top20 = metricBlock(quantileRows(valid, factor, 0.20), horizon);
  const bottom20 = metricBlock(quantileRows(valid, factor, 0.20, 'bottom'), horizon);
  const rankIC = correlationBySnapshot(valid, factor, horizon, 'returnPct');
  const marketIC = correlationBySnapshot(valid, factor, horizon, 'marketExcessReturnPct');
  const sectorIC = correlationBySnapshot(valid, factor, horizon, 'sectorExcessReturnPct');
  return {
    pairCount:valid.length,
    snapshotCount:new Set(valid.map(row => row.__snapshotId ?? 'single')).size,
    status:statusFor(valid.length),
    rankIC:metric(mean(rankIC)),
    spearman:metric(mean(spearmanBySnapshot(valid, factor, horizon))),
    rankICMarketExcess:metric(mean(marketIC)),
    rankICSectorExcess:metric(mean(sectorIC)),
    top5, top10, top20, bottom20,
    topBottomSpreadPct:metric(top20.averageReturnPct === null || bottom20.averageReturnPct === null
      ? null : top20.averageReturnPct - bottom20.averageReturnPct)
  };
}

function bandFor(value) {
  if (value === null) return 'missing';
  if (value >= 90) return '90_100';
  if (value >= 80) return '80_90';
  if (value >= 70) return '70_80';
  if (value >= 60) return '60_70';
  return 'below_60';
}

function factorBands(rows, factor) {
  const groups = {};
  for (const row of rows) {
    const value = factorValue(row, factor);
    const band = bandFor(value);
    groups[band] ??= [];
    groups[band].push(row);
  }
  return Object.fromEntries(Object.entries(groups).map(([band, values]) => [
    band,
    {
      sampleCount:values.length,
      status:statusFor(values.length),
      horizons:Object.fromEntries(HORIZONS.map(horizon => [
        't' + horizon, metricBlock(values, horizon)
      ]))
    }
  ]));
}

function combinationScore(row, key) {
  if (key === 'trend') return factorValue(row, 'trendStructure');
  if (key === 'capital') return factorValue(row, 'capitalFlow');
  if (key === 'psychology') return factorValue(row, 'psychology');
  if (key === 'leader') return factorValue(row, 'leader');
  if (key === 'imagination') return factorValue(row, 'imagination');
  if (key === 'timing') return factorValue(row, 'timing');
  if (key === 'theme') return themeScore(row);
  return null;
}

function combinationRows(rows) {
  const definitions = {
    highTrendHighCapital:row => combinationScore(row, 'trend') >= 70 &&
      combinationScore(row, 'capital') >= 70,
    highTrendHighPsychology:row => combinationScore(row, 'trend') >= 70 &&
      combinationScore(row, 'psychology') >= 70,
    highTrendLeader:row => combinationScore(row, 'trend') >= 70 &&
      combinationScore(row, 'leader') >= 70,
    highTrendHighTheme:row => combinationScore(row, 'trend') >= 70 &&
      combinationScore(row, 'theme') >= 70,
    highTrendHighImagination:row => combinationScore(row, 'trend') >= 70 &&
      combinationScore(row, 'imagination') >= 70,
    highTrendHighTiming:row => combinationScore(row, 'trend') >= 70 &&
      combinationScore(row, 'timing') >= 70
  };
  const all = {};
  for (const [name, predicate] of Object.entries(definitions)) {
    const selected = rows.filter(predicate);
    const ordinary = rows.filter(row => !predicate(row));
    all[name] = {
      threshold:70,
      selectedSampleCount:selected.length,
      selectedStatus:statusFor(selected.length),
      selected:Object.fromEntries(HORIZONS.map(horizon => [
        't' + horizon, metricBlock(selected, horizon)
      ])),
      ordinarySampleCount:ordinary.length,
      ordinaryStatus:statusFor(ordinary.length),
      ordinary:Object.fromEntries(HORIZONS.map(horizon => [
        't' + horizon, metricBlock(ordinary, horizon)
      ]))
    };
  }
  return all;
}

function factorCorrelation(rows) {
  const correlations = {};
  for (let leftIndex = 0; leftIndex < FACTOR_NAMES.length; leftIndex += 1) {
    const left = FACTOR_NAMES[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < FACTOR_NAMES.length; rightIndex += 1) {
      const right = FACTOR_NAMES[rightIndex];
      const pairs = rows.map(row => ({
        left:factorValue(row, left), right:factorValue(row, right)
      })).filter(pair => pair.left !== null && pair.right !== null);
      const key = left + '__' + right;
      correlations[key] = {
        sampleCount:pairs.length,
        correlation:metric(pearson(
          pairs.map(pair => pair.left), pairs.map(pair => pair.right)
        )),
        highOverlapPct:pairs.length ? metric(pairs.filter(pair => pair.left >= 70 && pair.right >= 70).length /
          pairs.length * 100) : null
      };
    }
  }
  return correlations;
}

function splitAnalysis(rows, factor) {
  const byRegime = {}, byEmotion = {}, byTime = {};
  for (const row of rows) {
    const regime = row.__marketRegime ?? 'unknown';
    const emotion = row.__emotion ?? 'unknown';
    const time = row.__timeBucket ?? 'unknown';
    byRegime[regime] ??= [];
    byRegime[regime].push(row);
    byEmotion[emotion] ??= [];
    byEmotion[emotion].push(row);
    byTime[time] ??= [];
    byTime[time].push(row);
  }
  const summarize = groups => Object.fromEntries(Object.entries(groups).map(([key, values]) => [
    key,
    {
      sampleCount:values.length,
      status:statusFor(values.length),
      horizons:Object.fromEntries(HORIZONS.map(horizon => [
        't' + horizon, factorHorizonMetrics(values, factor, horizon)
      ]))
    }
  ]));
  return {byMarketRegime:summarize(byRegime),byEmotion:summarize(byEmotion),byTimeBucket:summarize(byTime)};
}

export function analyzeV12Factors(input = {}) {
  const snapshots = Array.isArray(input)
    ? input : list(input?.snapshots ?? input?.predictions ?? [input]);
  const rows = [];
  const diagnostics = {
    snapshotCount:snapshots.length,
    candidateCount:0,
    missingFactorValues:Object.fromEntries(FACTOR_NAMES.map(name => [name, 0])),
    missingOutcomeCount:0
  };
  snapshots.forEach((snapshot, snapshotIndex) => {
    const meta = {
      __snapshotId:snapshot?.asOf ?? snapshot?.sourceSnapshot?.asOf ?? snapshotIndex,
      __marketRegime:marketRegimeOf(snapshot),
      __emotion:emotionOf(snapshot),
      __timeBucket:timeBucketOf(snapshot)
    };
    for (const signal of signalsOf(snapshot)) {
      diagnostics.candidateCount += 1;
      for (const factor of FACTOR_NAMES) {
        if (factorValue(signal, factor) === null) diagnostics.missingFactorValues[factor] += 1;
      }
      if (!HORIZONS.some(horizon => outcomeOf(signal, horizon))) diagnostics.missingOutcomeCount += 1;
      rows.push({...signal, ...meta});
    }
  });
  const factors = Object.fromEntries(FACTOR_NAMES.map(factor => [
    factor,
    {
      overall:Object.fromEntries(HORIZONS.map(horizon => [
        't' + horizon, factorHorizonMetrics(rows, factor, horizon)
      ])),
      scoreBands:factorBands(rows, factor),
      splits:splitAnalysis(rows, factor)
    }
  ]));
  const mlReady = snapshots.length >= ML_READINESS_REQUIREMENTS.snapshots &&
    rows.length >= ML_READINESS_REQUIREMENTS.candidateOutcomes;
  return {
    schema:'v12-factor-validation-v1',
    version:FACTOR_VALIDATION_VERSION,
    status:rows.length < MIN_SAMPLE ? 'INSUFFICIENT_SAMPLE' : 'OK',
    minSample:MIN_SAMPLE,
    leakagePolicy:{
      featureFields:'snapshot-time features only',
      outcomeFields:'T+1..T+5 used only as forward outcomes',
      quantiles:'computed independently within each snapshot',
      futureFeaturesExcluded:true
    },
    factorNames:FACTOR_NAMES,
    diagnostics,
    factors,
    combinations:combinationRows(rows),
    factorRedundancy:factorCorrelation(rows),
    mlReadiness:{
      status:mlReady ? 'READY_FOR_RESEARCH_REVIEW' : 'INSUFFICIENT_SAMPLE',
      observedSnapshots:snapshots.length,
      observedCandidateRows:rows.length,
      required:ML_READINESS_REQUIREMENTS,
      usesMLInDecision:false
    }
  };
}

export const runV12FactorValidation = analyzeV12Factors;

async function main(args) {
  const index = args.indexOf('--input');
  if (index < 0 || !args[index + 1]) {
    throw new Error('usage: node analyze_v12_factors.js --input FILE [--output FILE]');
  }
  const input = JSON.parse(await readFile(resolve(args[index + 1]), 'utf8'));
  const output = analyzeV12Factors(input);
  const outputIndex = args.indexOf('--output');
  if (outputIndex >= 0 && args[outputIndex + 1]) {
    await writeFile(resolve(args[outputIndex + 1]), JSON.stringify(output, null, 2) + '\n', 'utf8');
  }
  console.log(JSON.stringify(output, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
