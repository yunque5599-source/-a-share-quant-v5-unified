import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const HORIZONS = Object.freeze([1, 2, 3, 4, 5]);
const list = value => Array.isArray(value) ? value : [];
const n = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const metric = value => value === null || !Number.isFinite(value)
  ? null : Math.round(value * 10000) / 10000;
const mean = values => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

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

function trendOf(row) {
  return row?.features?.trendStructure ?? row?.trendStructure ?? null;
}

function trendScoreOf(row) {
  return n(trendOf(row)?.score);
}

function horizonOf(row, horizon) {
  return row?.horizons?.['t' + horizon] ?? null;
}

function metricBlock(rows, horizon) {
  const outcomes = rows.map(row => horizonOf(row, horizon)).filter(Boolean);
  const field = name => outcomes.map(item => n(item[name])).filter(value => value !== null);
  const returns = field('returnPct');
  const market = field('marketExcessReturnPct');
  const sector = field('sectorExcessReturnPct');
  const mfe = field('mfePct');
  const mae = field('maePct');
  const riskAdjusted = outcomes.map(item => {
    const value = n(item.returnPct);
    const adverse = n(item.maePct);
    return value === null ? null : value / Math.max(1, Math.abs(adverse ?? 0));
  }).filter(value => value !== null);
  return {
    sampleCount:outcomes.length,
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

function validRows(rows, horizon) {
  return rows.filter(row => trendScoreOf(row) !== null && horizonOf(row, horizon) &&
    n(horizonOf(row, horizon)?.returnPct) !== null);
}

function quantileRowsBySnapshot(rows, fraction, direction = 'top') {
  const groups = new Map();
  for (const row of rows) {
    const key = row.__snapshotId ?? 'single';
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const selected = [];
  for (const group of groups.values()) {
    const valid = group.filter(row => trendScoreOf(row) !== null);
    if (!valid.length) continue;
    const count = Math.max(1, Math.ceil(valid.length * fraction));
    const sorted = [...valid].sort((left, right) => {
      const difference = trendScoreOf(left) - trendScoreOf(right);
      return direction === 'top' ? -difference : difference;
    });
    selected.push(...sorted.slice(0, count));
  }
  return selected;
}

function perSnapshotCorrelations(rows, horizon, field) {
  const groups = new Map();
  for (const row of rows) {
    const outcome = horizonOf(row, horizon);
    const score = trendScoreOf(row);
    const value = n(outcome?.[field]);
    if (score === null || value === null) continue;
    const key = row.__snapshotId ?? 'single';
    const group = groups.get(key) ?? [];
    group.push({score, value});
    groups.set(key, group);
  }
  const correlations = [];
  for (const group of groups.values()) {
    if (group.length < 3) continue;
    correlations.push(pearson(group.map(item => item.score), group.map(item => item.value)));
  }
  return correlations.filter(value => value !== null);
}

function rankMetrics(rows, horizon) {
  const pairs = validRows(rows, horizon);
  const top5 = metricBlock(quantileRowsBySnapshot(pairs, 0.05), horizon);
  const top10 = metricBlock(quantileRowsBySnapshot(pairs, 0.10), horizon);
  const top20 = metricBlock(quantileRowsBySnapshot(pairs, 0.20), horizon);
  const bottom20 = metricBlock(quantileRowsBySnapshot(pairs, 0.20, 'bottom'), horizon);
  const excessIC = field => {
    const values = perSnapshotCorrelations(pairs, horizon, field);
    return metric(mean(values));
  };
  return {
    pairCount:pairs.length,
    snapshotCount:new Set(pairs.map(row => row.__snapshotId ?? 'single')).size,
    rankIC:metric(mean(perSnapshotCorrelations(pairs, horizon, 'returnPct'))),
    spearman:null,
    rankICMarketExcess:excessIC('marketExcessReturnPct'),
    rankICSectorExcess:excessIC('sectorExcessReturnPct'),
    top5, top10, top20, bottom20,
    topBottomSpreadPct:metric(top20.averageReturnPct === null || bottom20.averageReturnPct === null
      ? null : top20.averageReturnPct - bottom20.averageReturnPct)
  };
}

function spearmanBySnapshot(rows, horizon) {
  const groups = new Map();
  for (const row of rows) {
    const score = trendScoreOf(row);
    const value = n(horizonOf(row, horizon)?.returnPct);
    if (score === null || value === null) continue;
    const key = row.__snapshotId ?? 'single';
    const group = groups.get(key) ?? [];
    group.push({score, value});
    groups.set(key, group);
  }
  const values = [];
  for (const group of groups.values()) {
    if (group.length < 3) continue;
    values.push(pearson(ranks(group.map(item => item.score)), ranks(group.map(item => item.value))));
  }
  return metric(mean(values.filter(value => value !== null)));
}

function analysisForRows(rows) {
  return Object.fromEntries(HORIZONS.map(horizon => {
    const result = rankMetrics(rows, horizon);
    result.spearman = spearmanBySnapshot(rows, horizon);
    return ['t' + horizon, result];
  }));
}

function themeMatch(row) {
  const psychology = row?.psychology ?? {};
  const primary = psychology.primaryTheme;
  const themes = list(psychology.themes);
  if (!primary && !themes.length) return null;
  const code = primary?.code ?? primary?.themeCode ?? primary?.id;
  return themes.find(theme => code && (theme.themeCode === code || theme.code === code)) ??
    themes[0] ?? null;
}

function componentScore(row, name) {
  const theme = themeMatch(row);
  const direct = n(row?.psychology?.[name]?.score ?? row?.psychology?.[name]);
  const nested = n(theme?.components?.[name]?.score ?? theme?.[name]?.score);
  return direct ?? nested;
}

function combinationRows(rows) {
  const result = {};
  const strong = rows.filter(row => {
    const score = trendScoreOf(row);
    return score !== null && score >= 70;
  });
  const stage = row => String(row?.psychology?.stage ?? '').toLowerCase();
  const capitalAccelerating = row => {
    const flow = row?.features?.capital ?? {};
    const early = n(flow.earlyNetCny);
    const recent = n(flow.recentNetCny);
    return flow.flowTiming === 'early-inflow' ||
      (early !== null && recent !== null && recent > early);
  };
  const themePresent = row => Boolean(row?.psychology?.primaryTheme ?? themeMatch(row));
  const leader = row => (componentScore(row, 'leader') ?? -1) >= 70;
  const imagination = row => (componentScore(row, 'imagination') ?? -1) >= 70;
  const fomo = row => (n(row?.psychology?.fomoRisk?.score ?? row?.psychology?.fomoRisk) ?? -1) >= 75;
  const definitions = {
    trendStrong_emotionIgnition:row => ['ignition', 'startup', 'fomentation'].includes(stage(row)),
    trendStrong_emotionAcceleration:row => stage(row) === 'acceleration',
    trendStrong_capitalEarlyOrAccelerating:capitalAccelerating,
    trendStrong_themePresent:themePresent,
    trendStrong_leader:leader,
    trendStrong_imaginationHigh:imagination,
    trendStrong_fomoHigh:fomo
  };
  for (const [name, predicate] of Object.entries(definitions)) {
    result[name] = analysisForRows(strong.filter(predicate));
  }
  return result;
}

export function analyzeTrendStructure(input = {}) {
  const snapshots = Array.isArray(input)
    ? input : list(input?.snapshots ?? input?.predictions ?? [input]);
  const diagnostics = {
    snapshotCount:snapshots.length, missingTrend:0, missingOutcome:0, missingPsychology:0
  };
  const rows = [];
  snapshots.forEach((snapshot, snapshotIndex) => {
    const signals = signalsOf(snapshot);
    for (const signal of signals) {
      if (trendScoreOf(signal) === null) diagnostics.missingTrend += 1;
      if (!HORIZONS.some(horizon => horizonOf(signal, horizon))) diagnostics.missingOutcome += 1;
      if (!signal?.psychology) diagnostics.missingPsychology += 1;
      rows.push({...signal, __snapshotId:snapshot?.asOf ?? snapshot?.sourceSnapshot?.asOf ?? snapshotIndex});
    }
  });
  return {
    schema:'trend-structure-analysis-v1',
    version:'Trend Structure cross-sectional research validation',
    scoreDefinition:'Trend Structure score is independent research evidence; it does not enter Alpha, Timing, Psychology, V12TradeScore, or V12SelectionScore',
    horizons:HORIZONS,
    diagnostics,
    overall:analysisForRows(rows),
    combinations:combinationRows(rows)
  };
}

export const runTrendStructureAnalysis = analyzeTrendStructure;

async function main(args) {
  const index = args.indexOf('--input');
  if (index < 0 || !args[index + 1]) {
    throw new Error('usage: node analyze_trend_structure.js --input FILE [--output FILE]');
  }
  const input = JSON.parse(await readFile(resolve(args[index + 1]), 'utf8'));
  const output = analyzeTrendStructure(input);
  const outputIndex = args.indexOf('--output');
  if (outputIndex >= 0 && args[outputIndex + 1]) {
    await writeFile(resolve(args[outputIndex + 1]), JSON.stringify(output, null, 2) + '\n', 'utf8');
  }
  console.log(JSON.stringify(output, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
