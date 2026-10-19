import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { asOfDate } from './schema.js';

export const FACTOR_VALIDATION_VERSION = 'V12 Factor Validation v2';
export const SAMPLE_POLICY = Object.freeze({
  minPairs:30, minTradingDates:20, minCorrelationSnapshots:10,
  minCrossSection:5, highThreshold:70
});
export const ML_READINESS_REQUIREMENTS = Object.freeze({
  realTradingDates:120, completeCandidateOutcomes:10000
});
export const FACTOR_NAMES = Object.freeze([
  'trendStructure', 'momentum', 'capitalFlow', 'volume', 'sector',
  'psychology', 'leader', 'imagination', 'timing', 'risk'
]);
const HORIZONS = [1, 2, 3, 4, 5];
const BANDS = ['90_100', '80_90', '70_80', '60_70', 'below_60', 'missing'];
const list = value => Array.isArray(value) ? value : [];
const n = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const score = value => n(value) !== null && value >= 0 && value <= 100 ? value : null;
const metric = value => n(value) === null ? null : Math.round(value * 1e6) / 1e6;
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const distinct = values => [...new Set(values)];
const finite = values => values.filter(value => n(value) !== null);
const groups = (rows, key = row => row.__snapshotId) => {
  const result = new Map();
  for (const row of rows) {
    const value = key(row);
    if (!result.has(value)) result.set(value, []);
    result.get(value).push(row);
  }
  return result;
};

export function pearson(left, right) {
  if (left.length < 3 || left.length !== right.length) return null;
  const lm = mean(left), rm = mean(right);
  const numerator = left.reduce((sum, value, index) => sum + (value - lm) * (right[index] - rm), 0);
  const denominator = Math.sqrt(left.reduce((sum, value) => sum + (value - lm) ** 2, 0) *
    right.reduce((sum, value) => sum + (value - rm) ** 2, 0));
  return denominator > 0 ? numerator / denominator : null;
}

export function ranks(values) {
  const indexed = values.map((value, index) => ({value, index})).sort((a, b) => a.value - b.value);
  const result = Array(values.length);
  for (let start = 0; start < indexed.length;) {
    let end = start + 1;
    while (end < indexed.length && indexed[end].value === indexed[start].value) end += 1;
    for (let k = start; k < end; k += 1) result[indexed[k].index] = (start + end + 1) / 2;
    start = end;
  }
  return result;
}

function themeOf(row) {
  const psych = row.psychology ?? {};
  const primary = psych.primaryTheme;
  const themes = list(psych.themes);
  if (primary?.code) return themes.find(theme => (theme.themeCode ?? theme.code) === primary.code) ?? null;
  return themes.find(theme => theme.primary === true) ?? null;
}
function component(row, name) {
  return score(row.psychology?.components?.[name]?.score ?? themeOf(row)?.components?.[name]?.score);
}
const GETTERS = {
  trendStructure:row => row.features?.trendStructure?.score,
  momentum:row => row.features?.momentum?.score,
  capitalFlow:row => row.features?.capital?.score,
  volume:row => row.features?.volume?.score,
  sector:row => row.features?.sector?.score,
  psychology:row => row.psychology?.scoreRaw ?? row.psychology?.score ??
    row.scores?.psychologyRaw ?? row.scores?.psychology,
  leader:row => component(row, 'leader'),
  imagination:row => component(row, 'imagination'),
  timing:row => row.scores?.timingRaw ?? row.scores?.timing ?? row.timing?.scoreRaw ?? row.timing?.score,
  risk:row => row.features?.risk?.score,
  theme:row => themeOf(row)?.scoreRaw ?? themeOf(row)?.score
};
export function factorValue(row, factor) {
  return score(GETTERS[factor]?.(row));
}
function snapshotAsOf(snapshot) {
  return snapshot.asOf ?? snapshot.sourceSnapshot?.asOf ?? snapshot.decision?.asOf ?? null;
}
function metaOf(snapshot) {
  return snapshot.decision?.market ?? snapshot.market ?? snapshot.sourceSnapshot?.market ?? {};
}
function regimeOf(snapshot) {
  const value = String(snapshot.marketRegime ?? metaOf(snapshot).regime ??
    metaOf(snapshot).marketRegime ?? metaOf(snapshot).marketRisk ??
    snapshot.sourceSnapshot?.marketRegime ?? '').toLowerCase();
  if (['bull', 'bullish', 'strong'].includes(value)) return 'bull';
  if (['bear', 'bearish', 'weak'].includes(value)) return 'bear';
  if (['neutral', 'sideways', 'normal', 'elevated'].includes(value)) return 'neutral';
  return 'unknown';
}
function emotionOf(snapshot) {
  const label = String(snapshot.marketEmotion?.label ?? metaOf(snapshot).emotion?.label ?? '').toUpperCase();
  if (['HIGH', 'FEVER', 'RISING'].includes(label)) return 'high';
  if (['NORMAL', 'NEUTRAL'].includes(label)) return 'normal';
  if (['LOW', 'FADING', 'PANIC'].includes(label)) return 'low';
  return 'unknown';
}
function timeOf(asOf) {
  if (typeof asOf !== 'string' || !asOf.includes('T') || !asOfDate(asOf)) return 'unknown';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone:'Asia/Shanghai', hour:'2-digit', minute:'2-digit', hourCycle:'h23'
  }).formatToParts(new Date(asOf));
  const get = type => parts.find(part => part.type === type)?.value;
  const time = get('hour') + ':' + get('minute');
  return ['11:15', '13:30', '14:45'].includes(time) ? time : 'unknown';
}
function signalsOf(snapshot) {
  return list(snapshot.decision?.datasetCandidates ?? snapshot.signals ??
    snapshot.evaluated ?? snapshot.decision?.tradeRanking);
}
function sampleProvenance(snapshot) {
  if (snapshot.dataKind === 'synthetic' || snapshot.synthetic === true ||
      String(snapshot.source ?? '').includes('fixture')) return 'synthetic';
  return isReal(snapshot) ? 'real' : 'unknown';
}
function isReal(snapshot) {
  if (snapshot.dataKind === 'synthetic' || snapshot.synthetic === true) return false;
  const schema = snapshot.schema ?? '';
  const source = snapshot.sourceSnapshot ?? {};
  return (schema.startsWith('v12-live-snapshot') && !!snapshot.capturedAt &&
    snapshot.sourcePolicy?.pointInTime === 'captured-at-source') ||
    (source.schema?.startsWith('v12-live-snapshot') && !!source.capturedAt) ||
    snapshot.dataKind === 'real';
}
function canonicalTime(value) {
  return value?.includes('T') ? new Date(value).toISOString() : value;
}
function futureStamp(value, cutoff) {
  if (!value) return false;
  const day = asOfDate(value);
  if (!day || day > asOfDate(cutoff)) return true;
  if (value.includes('T') && cutoff.includes('T')) return Date.parse(value) > Date.parse(cutoff);
  return false;
}
function featureStamp(row, factor) {
  const field = factor === 'capitalFlow' ? 'capital' : factor;
  const block = ['leader', 'imagination', 'theme'].includes(factor)
    ? themeOf(row) : factor === 'psychology' ? row.psychology :
      factor === 'timing' ? row.timing : row.features?.[field];
  return block?.asOf ?? block?.generatedAt ?? block?.producedAt ?? null;
}

/** Join by the original snapshot timestamp and symbol, never by current rank.
 * Original snapshot features always win over outcome-file features.
 */
function prepare(input) {
  const snapshots = Array.isArray(input) ? input : list(input.snapshots ?? input.predictions ?? [input]);
  const merged = new Map();
  const diagnostics = {
    inputDocuments:snapshots.length, invalidSnapshotDocuments:0, duplicateCandidateRecords:0,
    invalidFeatureTimestamps:0, missingFeatureTimestamps:0, conflictingFeatureRecords:0,
    invalidOutcomeDates:0, outcomesMissingDate:0, missingOutcomeCount:0,
    missingOutcomeByHorizon:Object.fromEntries(HORIZONS.map(h => ['t' + h, 0])),
    missingFactorValues:{},
    provenance:'explicit snapshot/sourceSnapshot provenance; not independently certified'
  };
  const ordered = [...snapshots].sort((a, b) =>
    Number(!a?.decision?.datasetCandidates) - Number(!b?.decision?.datasetCandidates));
  for (const snapshot of ordered) {
    if (!snapshot || typeof snapshot !== 'object') continue;
    const asOf = snapshotAsOf(snapshot);
    if (!asOfDate(asOf)) { diagnostics.invalidSnapshotDocuments += 1; continue; }
    const id = canonicalTime(asOf);
    for (const signal of signalsOf(snapshot)) {
      const symbol = String(signal?.symbol ?? signal?.code ?? '').trim();
      if (!symbol || !signal || typeof signal !== 'object') continue;
      const key = id + '/' + symbol;
      const prior = merged.get(key);
      const featureAsOf = signal.asOf ?? signal.featureAsOf ?? asOf;
      if (futureStamp(featureAsOf, asOf)) {
        diagnostics.invalidFeatureTimestamps += 1;
        continue;
      }
      const valid = {...signal,
        __asOf:asOf, __snapshotId:id, __day:asOfDate(asOf), __symbol:symbol,
        __regime:regimeOf(snapshot), __emotion:emotionOf(snapshot), __time:timeOf(asOf),
        __real:isReal(snapshot),
        __provenance:sampleProvenance(snapshot),
        __outcomes:{}, __invalidFactors:[],
        __captured:!!snapshot.decision?.datasetCandidates
      };
      for (const factor of [...FACTOR_NAMES, 'theme']) {
        const stamp = featureStamp(valid, factor);
        if (!stamp) diagnostics.missingFeatureTimestamps += 1;
        if (stamp && futureStamp(stamp, asOf)) {
          valid.__invalidFactors.push(factor);
          diagnostics.invalidFeatureTimestamps += 1;
        }
      }
      for (const h of HORIZONS) {
        const outcome = signal.horizons?.['t' + h] ?? signal.horizonProfile?.['t' + h];
        if (!outcome) continue;
        const date = asOfDate(outcome.date);
        if (!date) { diagnostics.outcomesMissingDate += 1; continue; }
        if (date <= valid.__day) { diagnostics.invalidOutcomeDates += 1; continue; }
        const previous = valid.__outcomes['t' + (h - 1)]?.date;
        if (previous && date <= previous) { diagnostics.invalidOutcomeDates += 1; continue; }
        valid.__outcomes['t' + h] = {...outcome, date};
      }
      if (prior) {
        diagnostics.duplicateCandidateRecords += 1;
        if (JSON.stringify(prior.features) !== JSON.stringify(valid.features)) diagnostics.conflictingFeatureRecords += 1;
        // Do not replace frozen original features with later outcome metadata.
        prior.__outcomes = {...prior.__outcomes, ...valid.__outcomes};
        if (prior.__regime === 'unknown') prior.__regime = valid.__regime;
        if (prior.__emotion === 'unknown') prior.__emotion = valid.__emotion;
        prior.__real ||= valid.__real;
      } else merged.set(key, valid);
    }
  }
  const rows = [...merged.values()];
  for (const name of FACTOR_NAMES) diagnostics.missingFactorValues[name] = rows.filter(row => valueOf(row, name) === null).length;
  diagnostics.uniqueSnapshotCount = distinct(rows.map(row => row.__snapshotId)).length;
  diagnostics.uniqueTradingDates = distinct(rows.map(row => row.__day)).length;
  diagnostics.uniqueCandidateRows = rows.length;
  return {rows, diagnostics};
}
function valueOf(row, factor) {
  return row.__invalidFactors?.includes(factor) ? null : factorValue(row, factor);
}
function outcomeOf(row, h) { return row.__outcomes?.['t' + h] ?? null; }
function evidence(rows, count = rows.length) {
  const days = distinct(rows.map(row => row.__day)).length;
  return {sampleCount:count, snapshotCount:distinct(rows.map(row => row.__snapshotId)).length,
    tradingDateCount:days,
    status:count >= SAMPLE_POLICY.minPairs && days >= SAMPLE_POLICY.minTradingDates
      ? 'DESCRIPTIVE_ONLY' : 'INSUFFICIENT_SAMPLE'};
}
function metricBlock(rows, h) {
  const valid = rows.filter(row => n(outcomeOf(row, h)?.returnPct) !== null);
  const vals = name => finite(valid.map(row => n(outcomeOf(row, h)?.[name])));
  const returns = vals('returnPct'), market = vals('marketExcessReturnPct'),
    sector = vals('sectorExcessReturnPct'), mfe = vals('mfePct'), mae = vals('maePct');
  const adjusted = valid.filter(row => n(outcomeOf(row, h).maePct) !== null)
    .map(row => outcomeOf(row, h).returnPct / Math.max(1, Math.abs(outcomeOf(row, h).maePct)));
  return {...evidence(valid), selectedCount:rows.length,
    availableReturnCount:valid.length, missingOutcomeCount:rows.length - valid.length,
    averageReturnPct:metric(mean(returns)), winRatePct:returns.length ? metric(returns.filter(v => v > 0).length / returns.length * 100) : null,
    averageMarketExcessReturnPct:metric(mean(market)), averageSectorExcessReturnPct:metric(mean(sector)),
    mfeAvgPct:metric(mean(mfe)), maeAvgPct:metric(mean(mae)),
    riskAdjustedReturnPct:metric(mean(adjusted)),
    marketExcessCount:market.length, sectorExcessCount:sector.length, mfeCount:mfe.length, maeCount:mae.length};
}
function quantile(rows, factor, fraction, bottom = false) {
  const selected = [];
  for (const group of groups(rows).values()) {
    const valid = group.filter(row => valueOf(row, factor) !== null).sort((a, b) =>
      (bottom ? 1 : -1) * (valueOf(a, factor) - valueOf(b, factor)) || a.__symbol.localeCompare(b.__symbol));
    if (!valid.length) continue;
    const boundary = valueOf(valid[Math.ceil(valid.length * fraction) - 1], factor);
    selected.push(...valid.filter(row => bottom ? valueOf(row, factor) <= boundary : valueOf(row, factor) >= boundary));
  }
  return selected;
}
function corrSeries(rows, left, right, ranked = false) {
  const series = [];
  for (const [id, group] of groups(rows)) {
    const pairs = group.map(row => [left(row), right(row)]).filter(pair => pair.every(v => n(v) !== null));
    if (pairs.length < SAMPLE_POLICY.minCrossSection) continue;
    const x = pairs.map(pair => pair[0]), y = pairs.map(pair => pair[1]);
    const correlation = pearson(ranked ? ranks(x) : x, ranked ? ranks(y) : y);
    if (correlation !== null) series.push({snapshot:id, day:group[0].__day, value:correlation});
  }
  return series;
}
function icSummary(series) {
  // Equal-weight dates; three intraday snapshots do not triple the time evidence.
  const daily = [...groups(series, row => row.day).values()].map(group => mean(group.map(row => row.value)));
  const avg = mean(daily);
  return {value:metric(avg), validCorrelationSnapshots:series.length, validCorrelationDates:daily.length,
    dailyICStd:daily.length > 1 ? metric(Math.sqrt(mean(daily.map(v => (v - avg) ** 2)))) : null,
    positiveICDatePct:daily.length ? metric(daily.filter(v => v > 0).length / daily.length * 100) : null,
    status:daily.length >= SAMPLE_POLICY.minTradingDates && series.length >= SAMPLE_POLICY.minCorrelationSnapshots
      ? 'DESCRIPTIVE_ONLY' : 'INSUFFICIENT_SAMPLE'};
}
function spreadBySnapshot(left, right, h, field = 'returnPct') {
  const lg = groups(left), rg = groups(right), daily = [];
  for (const [id, a] of lg) {
    const b = rg.get(id);
    if (!b) continue;
    const av = finite(a.map(row => n(outcomeOf(row, h)?.[field])));
    const bv = finite(b.map(row => n(outcomeOf(row, h)?.[field])));
    if (av.length && bv.length) daily.push({day:a[0].__day, value:mean(av) - mean(bv)});
  }
  const dates = [...groups(daily, row => row.day).values()].map(values => mean(values.map(row => row.value)));
  return {spreadPct:metric(mean(dates)), matchedSnapshotCount:daily.length, matchedTradingDates:dates.length,
    status:dates.length >= SAMPLE_POLICY.minTradingDates ? 'DESCRIPTIVE_ONLY' : 'INSUFFICIENT_SAMPLE'};
}
function horizonMetrics(rows, factor, h) {
  const candidates = rows.filter(row => valueOf(row, factor) !== null);
  const left = row => valueOf(row, factor), ret = row => n(outcomeOf(row, h)?.returnPct);
  const pearsonIC = icSummary(corrSeries(candidates, left, ret));
  const rank = icSummary(corrSeries(candidates, left, ret, true));
  const top = Object.fromEntries([['top5', .05], ['top10', .1], ['top20', .2]]
    .map(([key, fraction]) => [key, metricBlock(quantile(candidates, factor, fraction), h)]));
  const topRows = quantile(candidates, factor, .2), bottomRows = quantile(candidates, factor, .2, true);
  const overlap = topRows.some(row => bottomRows.includes(row));
  const spread = spreadBySnapshot(topRows, bottomRows, h);
  const marketPearson = icSummary(corrSeries(candidates, left,
    row => n(outcomeOf(row, h)?.marketExcessReturnPct)));
  const marketRank = icSummary(corrSeries(candidates, left,
    row => n(outcomeOf(row, h)?.marketExcessReturnPct), true));
  const sectorPearson = icSummary(corrSeries(candidates, left,
    row => n(outcomeOf(row, h)?.sectorExcessReturnPct)));
  const sectorRank = icSummary(corrSeries(candidates, left,
    row => n(outcomeOf(row, h)?.sectorExcessReturnPct), true));
  return {status:rank.status, ...metricBlock(candidates, h), rankIC:pearsonIC.value,
    spearman:rank.value, pearsonIC:pearsonIC.value,
    rankICMarketExcess:marketPearson.value,
    spearmanMarketExcess:marketRank.value,
    rankICSectorExcess:sectorPearson.value,
    spearmanSectorExcess:sectorRank.value,
    icEvidence:rank, ...top, bottom20:metricBlock(bottomRows, h),
    topBottomSpreadPct:overlap ? null : spread.spreadPct,
    spreadEvidence:spread, overlappingQuantiles:overlap};
}
function allHorizons(rows, factor) {
  return Object.fromEntries(HORIZONS.map(h => ['t' + h, horizonMetrics(rows, factor, h)]));
}
function band(value) {
  return value === null ? 'missing' : value >= 90 ? '90_100' : value >= 80 ? '80_90' :
    value >= 70 ? '70_80' : value >= 60 ? '60_70' : 'below_60';
}
function bands(rows, factor) {
  return Object.fromEntries(BANDS.map(key => [key, Object.fromEntries(HORIZONS.map(h =>
    ['t' + h, metricBlock(rows.filter(row => band(valueOf(row, factor)) === key), h)]))]));
}
function split(rows, factor, field, keys) {
  return Object.fromEntries(keys.map(key => [key, allHorizons(rows.filter(row => row[field] === key), factor)]));
}
function redundancy(rows) {
  const result = {};
  for (let i = 0; i < FACTOR_NAMES.length; i += 1) for (const b of FACTOR_NAMES.slice(i + 1)) {
    const a = FACTOR_NAMES[i], x = row => valueOf(row, a), y = row => valueOf(row, b);
    const rank = icSummary(corrSeries(rows, x, y, true));
    result[a + '__' + b] = {spearman:rank.value, pearson:icSummary(corrSeries(rows, x, y)).value,
      evidence:rank, highCorrelationFlag:rank.status === 'INSUFFICIENT_SAMPLE' ? null :
        rank.value !== null && Math.abs(rank.value) >= .8,
      interpretation:'Within-snapshot association; overlap does not establish dispensability.'};
  }
  return result;
}
function conditionalIC(rows, factor) {
  // Pairwise partial rank correlation is descriptive, not a fitted selection model.
  return Object.fromEntries(FACTOR_NAMES.filter(other => other !== factor).map(other => [other,
    Object.fromEntries(HORIZONS.map(h => {
      const series = [];
      for (const [id, group] of groups(rows)) {
        const valid = group.filter(row => valueOf(row, factor) !== null && valueOf(row, other) !== null &&
          n(outcomeOf(row, h)?.returnPct) !== null);
        if (valid.length < SAMPLE_POLICY.minCrossSection) continue;
        const x = ranks(valid.map(row => valueOf(row, factor))), z = ranks(valid.map(row => valueOf(row, other))),
          y = ranks(valid.map(row => outcomeOf(row, h).returnPct));
        const xy = pearson(x, y), xz = pearson(x, z), zy = pearson(z, y);
        if ([xy, xz, zy].some(v => v === null)) continue;
        const denom = Math.sqrt(Math.max(0, (1 - xz ** 2) * (1 - zy ** 2)));
        if (denom > 1e-8) series.push({snapshot:id, day:group[0].__day,
          value:Math.max(-1, Math.min(1, (xy - xz * zy) / denom))});
      }
      return ['t' + h, icSummary(series)];
    }))]));
}
function combinations(rows) {
  return Object.fromEntries(['capitalFlow', 'psychology', 'leader', 'theme', 'imagination', 'timing'].map(partner => {
    const eligible = rows.filter(row => valueOf(row, 'trendStructure') !== null && valueOf(row, partner) !== null);
    const cell = (highTrend, highPartner) => eligible.filter(row =>
      (valueOf(row, 'trendStructure') >= SAMPLE_POLICY.highThreshold) === highTrend &&
      (valueOf(row, partner) >= SAMPLE_POLICY.highThreshold) === highPartner);
    const HH = cell(true, true), HL = cell(true, false), LH = cell(false, true), LL = cell(false, false);
    const ordinary = [...HL, ...LH, ...LL];
    return ['trend__' + partner, {threshold:SAMPLE_POLICY.highThreshold, eligibleCount:eligible.length,
      excludedMissingCount:rows.length - eligible.length,
      interpretation:'Matched snapshot descriptive contrasts; not proof of independent incremental predictability.',
      horizons:Object.fromEntries(HORIZONS.map(h => ['t' + h, {
        highHigh:metricBlock(HH, h), highLow:metricBlock(HL, h),
        lowHigh:metricBlock(LH, h), lowLow:metricBlock(LL, h), ordinary:metricBlock(ordinary, h),
        vsOrdinary:spreadBySnapshot(HH, ordinary, h),
        partnerIncrementWithinHighTrend:spreadBySnapshot(HH, HL, h),
        trendIncrementWithinHighPartner:spreadBySnapshot(HH, LH, h)
      }]))}];
  }));
}
function conclusions(factors, rows, ml) {
  const power = Object.fromEntries(FACTOR_NAMES.map(name => [name, {
    status:[1, 3, 5].some(h => factors[name].overall['t' + h].icEvidence.status === 'INSUFFICIENT_SAMPLE')
      ? 'INSUFFICIENT_SAMPLE' : 'REQUIRES_INDEPENDENT_VALIDATION',
    independentPredictivePower:'NOT_ESTABLISHED',
    explanation:'Univariate and pairwise partial IC are descriptive; overlapping labels and multiple comparisons require independent time validation.'
  }]));
  return {factorPredictivePower:power,
    redundancy:'See factorRedundancy; no automatic deletion of correlated factors.',
    incrementalInformation:'See matched combinations and conditionalRankIC; no score feedback.',
    marketSpecificity:'INSUFFICIENT_SAMPLE',
    bestSnapshotTime:'INSUFFICIENT_SAMPLE',
    ml:ml.status,
    sufficientForProfitabilityClaim:false};
}

export function analyzeV12Factors(input = {}) {
  const {rows, diagnostics} = prepare(input);
  const factors = Object.fromEntries(FACTOR_NAMES.map(factor => [factor, {
    overall:allHorizons(rows, factor), scoreBands:bands(rows, factor),
    byMarketRegime:split(rows, factor, '__regime', ['bull', 'neutral', 'bear', 'unknown']),
    byEmotion:split(rows, factor, '__emotion', ['high', 'normal', 'low', 'unknown']),
    byTimeBucket:split(rows, factor, '__time', ['11:15', '13:30', '14:45', 'unknown']),
    conditionalRankIC:conditionalIC(rows, factor)
  }]));
  const completeReal = rows.filter(row => row.__real &&
    HORIZONS.every(h => n(outcomeOf(row, h)?.returnPct) !== null));
  const dates = distinct(completeReal.map(row => row.__day));
  const ml = {status:dates.length >= ML_READINESS_REQUIREMENTS.realTradingDates &&
      completeReal.length >= ML_READINESS_REQUIREMENTS.completeCandidateOutcomes
      ? 'ELIGIBLE_FOR_RESEARCH_REVIEW' : 'INSUFFICIENT_SAMPLE',
    completeRealCandidateOutcomes:completeReal.length, uniqueRealTradingDates:dates.length,
    uniqueRealSnapshots:distinct(completeReal.map(row => row.__snapshotId)).length,
    requirements:ML_READINESS_REQUIREMENTS,
    note:'Quantity screen only. Coverage, leakage audit and untouched walk-forward validation are still required.',
    usesMLInDecision:false};
  const complete = rows.filter(row => HORIZONS.every(h => n(outcomeOf(row, h)?.returnPct) !== null));
  diagnostics.completeOutcomeRows = complete.length;
  diagnostics.completeT5Count = complete.length;
  diagnostics.realCompleteOutcomeRows = completeReal.length;
  diagnostics.realTradingDates = dates.length;
  const provenanceGroups = {real:[], synthetic:[], unknown:[]};
  for (const row of rows) provenanceGroups[row.__provenance ?? 'unknown'].push(row);
  const provenance = Object.fromEntries(Object.entries(provenanceGroups).map(([name, values]) => [
    name, {
      candidateRows:values.length,
      snapshots:distinct(values.map(row => row.__snapshotId)).length,
      tradingDates:distinct(values.map(row => row.__day)).length,
      completeT5:values.filter(row => HORIZONS.every(h => n(outcomeOf(row, h)?.returnPct) !== null)).length,
      status:evidence(values.filter(row => HORIZONS.every(h => n(outcomeOf(row, h)?.returnPct) !== null))).status
    }
  ]));
  const realEvidence = evidence(completeReal);
  return {schema:'v12-factor-validation-v2', version:FACTOR_VALIDATION_VERSION,
    status:realEvidence.status, samplePolicy:SAMPLE_POLICY, diagnostics, provenance,
    leakagePolicy:{featureSource:'Captured features only; no feature recomputation or outcome-to-score feedback.',
      outcomeDate:'Strictly after Asia/Shanghai snapshot date; invalid/undated labels are excluded.',
      featureTimestamps:'Future/invalid explicit timestamps excluded; absent timestamps cannot be independently certified.',
      ranking:'Per snapshot, before outcome availability filtering; boundary ties included.',
      rankIC:'Spearman within snapshot, then equal-weight trading dates. Pearson IC also reported.',
      risk:'Existing risk score is a positive safety score; high means safer.',
      inference:'Descriptive only. Repeated snapshots, overlapping horizons and multiple tests are not independent evidence.'},
    factors, combinations:combinations(rows), factorRedundancy:redundancy(rows),
    mlReadiness:ml, conclusions:conclusions(factors, rows, ml)};
}

async function readInputs(path) {
  const absolute = resolve(path);
  try { return JSON.parse(await readFile(absolute, 'utf8')); }
  catch (error) {
    if (error.code !== 'EISDIR') throw error;
    const files = (await readdir(absolute, {withFileTypes:true})).filter(item => item.isFile() && item.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name));
    const result = [];
    for (const file of files) {
      const input = JSON.parse(await readFile(join(absolute, file.name), 'utf8'));
      result.push(...(Array.isArray(input) ? input : input.snapshots ?? input.predictions ?? [input]));
    }
    return result;
  }
}
export async function runCLI(args) {
  const paths = args.flatMap((arg, i) => arg === '--input' && args[i + 1] ? [args[i + 1]] : []);
  if (!paths.length) throw new Error('usage: node analyze_v12_factors.js --input FILE_OR_DIRECTORY [--input OUTCOMES] [--output FILE]');
  const snapshots = [];
  for (const path of paths) {
    const input = await readInputs(path);
    snapshots.push(...(Array.isArray(input) ? input : input.snapshots ?? input.predictions ?? [input]));
  }
  const report = analyzeV12Factors(snapshots);
  const output = args.indexOf('--output');
  if (output >= 0) {
    if (!args[output + 1]) throw new Error('--output needs a file path');
    await writeFile(resolve(args[output + 1]), JSON.stringify(report, null, 2) + '\n', 'utf8');
  }
  console.log(JSON.stringify(report, null, 2));
}
export const runV12FactorValidation = analyzeV12Factors;
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runCLI(process.argv.slice(2));
