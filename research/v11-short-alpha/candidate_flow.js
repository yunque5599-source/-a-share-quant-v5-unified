import { generateDecision } from '../v1040-core/decision_engine/decision_output.js';
import { normalizeMarketRisk } from '../v1040-core/adapter/market_adapter.js';
import { finiteNumber as n, clamp, round, validDate, asOfDate, createCandidateRecord } from './schema.js';
import { rankCandidates } from './alpha_score.js';

const list = value => Array.isArray(value) ? value : [];
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const usable = values => values.every(value => n(value) !== null);
const pctScore = (value, multiplier) => value === null ? null : clamp(50 + value * multiplier);
const symbolOf = row => String(row?.symbol ?? row?.code ?? row?.f12 ?? '').trim();

function rows(raw) {
  return list(Array.isArray(raw) ? raw : raw?.data?.klines ?? raw?.klines ?? raw?.rows);
}

function parseRows(raw, kind, cutoff) {
  const result = [], seen = new Set(), warnings = [], blocked = [];
  for (const input of rows(raw)) {
    const fields = typeof input === 'string' ? input.split(',') : input;
    const array = Array.isArray(fields);
    const date = validDate(array ? fields[0] : fields?.date);
    if (!date) { blocked.push(kind + ':invalid-date'); continue; }
    if (cutoff && date > cutoff) { warnings.push(kind + ':future-row-ignored'); continue; }
    if (seen.has(date)) { blocked.push(kind + ':duplicate-date'); continue; }
    seen.add(date);
    if (kind === 'kline') {
      const close = n(array ? fields[2] : fields?.close ?? fields?.price);
      if (!(close > 0)) { blocked.push('kline:invalid-close'); continue; }
      result.push({
        date, close,
        high: n(array ? fields[3] : fields?.high),
        volume: n(array ? fields[5] : fields?.volume ?? fields?.vol),
        amount: n(array ? fields[6] : fields?.amount ?? fields?.turnover)
      });
    } else {
      result.push({
        date,
        net: n(array ? fields[1] : fields?.mainNet ?? fields?.net ?? fields?.main),
        pct: n(array ? fields[6] : fields?.mainNetPct ?? fields?.netPct ?? fields?.pct)
        // Flow field[11] is price, never a turnover denominator.
      });
    }
  }
  return { data: result.sort((a, b) => a.date.localeCompare(b.date)), warnings, blocked };
}

function sectorLookup(payload) {
  const supplied = list(payload?.sectorResearch?.sectors ?? payload?.data?.sectorResearch?.sectors ?? payload?.sectors);
  const unique = new Map();
  for (const row of supplied) {
    const industry = String(row?.industry ?? '').trim();
    const pct = n(row?.medianPct ?? row?.pct ?? row?.changePct);
    if (industry && pct !== null && !unique.has(industry)) unique.set(industry, { industry, pct });
  }
  // Rank has one reproducible definition: descending sector median percentage change.
  const sorted = [...unique.values()].sort((a, b) => b.pct - a.pct || a.industry.localeCompare(b.industry));
  return new Map(sorted.map((sector, index) => [sector.industry, {
    ...sector, rank: index + 1, total: sorted.length
  }]));
}

function features(raw, bars, flows, sector, flowDegraded) {
  const last = bars.at(-1);
  const closes = bars.map(bar => bar.close);
  const r5 = bars.length >= 6 ? (last.close / bars.at(-6).close - 1) * 100 : null;
  const r10 = bars.length >= 11 ? (last.close / bars.at(-11).close - 1) * 100 : null;
  const highs = bars.slice(-21, -1).map(bar => bar.high);
  const breakout = highs.length === 20 && usable(highs) && highs.every(high => high > 0)
    ? (last.close / Math.max(...highs) - 1) * 100 : null;
  const momentum = {
    return5dPct: r5, return10dPct: r10, breakoutStrengthPct: breakout,
    score: usable([r5, r10, breakout])
      ? pctScore(r5, 5) * 0.35 + pctScore(r10, 5) * 0.35 + pctScore(breakout, 10) * 0.30 : null
  };

  const priorVolumes = bars.slice(-21, -1).map(bar => bar.volume);
  const completeVolumes = priorVolumes.length === 20 && usable(priorVolumes) &&
    priorVolumes.every(volume => volume > 0) && last.volume > 0;
  const providerRatio = n(raw?.f10 ?? raw?.vr ?? raw?.volumeRatio);
  const ratio = providerRatio !== null && providerRatio >= 0 ? providerRatio
    : completeVolumes ? last.volume / mean(priorVolumes.slice(-5)) : null;
  const expansion = completeVolumes ? last.volume / mean(priorVolumes) : null;
  const volume = {
    volumeRatio: ratio, ratioSource: providerRatio !== null ? 'provider' : 'last-vs-prior-5',
    volumeExpansionRatio: expansion,
    score: usable([ratio, expansion])
      ? clamp(50 + (ratio - 1) * 25) * 0.5 + clamp(50 + (expansion - 1) * 35) * 0.5 : null
  };

  const flowByDate = new Map(flows.map(flow => [flow.date, flow]));
  const expectedFlowDates = bars.slice(-5).map(bar => bar.date);
  const recentFlows = expectedFlowDates.map(date => flowByDate.get(date));
  const flowComplete = expectedFlowDates.length === 5 && recentFlows.every(flow => flow && n(flow.net) !== null);
  const currentFlow = last ? flowByDate.get(last.date) : null;
  const mainNet = flowDegraded ? null : n(raw?.f62 ?? raw?.mainNet) ?? currentFlow?.net ?? null;
  const mainPct = flowDegraded ? null : n(raw?.f184 ?? raw?.mainPct) ?? currentFlow?.pct ??
    (mainNet !== null && last?.amount > 0 ? mainNet / last.amount * 100 : null);
  const positiveRatio = !flowDegraded && flowComplete ? recentFlows.filter(flow => flow.net > 0).length / 5 : null;
  const netStrength = mainNet === null ? null
    : clamp(50 + Math.sign(mainNet) * 10 * Math.log10(1 + Math.abs(mainNet) / 1e6));
  const capital = {
    mainNetCny: mainNet, mainNetPct: mainPct, positiveFlowRatio5d: positiveRatio,
    amountCny: last?.amount ?? n(raw?.f6 ?? raw?.amount),
    score: usable([mainNet, mainPct, positiveRatio])
      ? pctScore(mainPct, 5) * 0.50 + netStrength * 0.25 + positiveRatio * 100 * 0.25 : null
  };

  const sectorRankScore = sector?.total >= 2
    ? 100 * (1 - (sector.rank - 1) / (sector.total - 1)) : null;
  const sectorFeature = {
    changePct: sector?.pct ?? null, rank: sector?.rank ?? null, total: sector?.total ?? null,
    hotspotScore: pctScore(sector?.pct ?? null, 5),
    rankingBasis: 'sector-median-pct-desc',
    score: usable([sector?.pct ?? null, sectorRankScore])
      ? pctScore(sector.pct, 5) * 0.60 + sectorRankScore * 0.40 : null
  };

  const recent = closes.slice(-21);
  const returns = recent.slice(1).map((close, index) => (close / recent[index] - 1) * 100);
  const averageReturn = mean(returns);
  const volatility = returns.length === 20
    ? Math.sqrt(mean(returns.map(value => (value - averageReturn) ** 2))) : null;
  let maxDrawdown = null, currentDrawdown = null;
  if (bars.length >= 20) {
    const window = closes.slice(-20);
    let peak = window[0]; maxDrawdown = 0;
    for (const close of window) {
      peak = Math.max(peak, close);
      maxDrawdown = Math.max(maxDrawdown, (peak - close) / peak * 100);
    }
    currentDrawdown = (peak - last.close) / peak * 100;
  }
  const amounts = bars.slice(-20).map(bar => bar.amount);
  const avgAmount = amounts.length === 20 && usable(amounts) && amounts.every(amount => amount > 0)
    ? mean(amounts) : null;
  const risk = {
    volatility20dPct: volatility, maxDrawdown20dPct: maxDrawdown,
    currentDrawdownPct: currentDrawdown, averageAmount20dCny: avgAmount,
    score: usable([volatility, maxDrawdown])
      ? clamp(100 - volatility * 10) * 0.60 + clamp(100 - maxDrawdown * 4) * 0.40 : null
  };
  return { capital, momentum, sector: sectorFeature, volume, risk };
}

function unpack(input) {
  if (Array.isArray(input)) return { root: {}, ranked: input, candidates: input, deep: {}, discovery: {} };
  const envelope = input && typeof input === 'object' ? input : {};
  const ranked = envelope.ranked ?? envelope;
  const root = ranked?.data && typeof ranked.data === 'object' ? ranked.data : ranked;
  return {
    root: root ?? {}, ranked,
    candidates: list(root?.candidates ?? root?.records),
    deep: envelope.deep ?? envelope.deepBatch ?? {},
    discovery: envelope.discovery ?? envelope
  };
}

/**
 * Offline integration point for existing ranked_candidates + deep_batch + discovery
 * responses, legacy CORE history maps, and enriched frontend candidate arrays.
 */
export function integrateCandidateFlow(input = {}, options = {}) {
  const { root, ranked, candidates, deep, discovery } = unpack(input);
  const sectors = sectorLookup(discovery);
  const deepMap = new Map(), duplicateDeep = new Set();
  for (const item of list(Array.isArray(deep) ? deep : deep?.items).concat(list(input?.items))) {
    const symbol = symbolOf(item);
    if (!symbol) continue;
    if (deepMap.has(symbol)) duplicateDeep.add(symbol);
    else deepMap.set(symbol, item);
  }
  const diagnostics = { inputCount: candidates.length, duplicateCandidates: 0, rejectedCandidates: 0 };
  const explicitMarket = options.market ?? input?.market ?? root.marketRisk;
  let marketRisk = normalizeMarketRisk(explicitMarket);
  if (marketRisk === 'unknown' && explicitMarket === undefined) {
    const values = list(root.indices ?? input?.indices).map(index => n(index?.pct)).filter(value => value !== null);
    if (values.length >= 2) marketRisk = mean(values) <= -1.5 ? 'weak' : mean(values) < 0 ? 'elevated' : 'normal';
  }
  const asOf = options.asOf ?? root.generatedAt ?? input?.asOf?.collectionFinishedAt ?? input?.asOf ?? null;
  const cutoff = asOfDate(asOf);
  const seen = new Set();
  const records = [];
  for (const raw of candidates) {
    const symbol = symbolOf(raw);
    if (!/^\d{6}$/.test(symbol)) { diagnostics.rejectedCandidates += 1; continue; }
    if (seen.has(symbol)) { diagnostics.duplicateCandidates += 1; continue; }
    seen.add(symbol);
    const item = deepMap.get(symbol) ?? {};
    const history = item.kline ?? root.historyBySymbol?.[symbol] ?? input?.historyBySymbol?.[symbol] ??
      raw?.history ?? raw?.kline ?? raw?.k;
    const flow = item.flow ?? root.flowBySymbol?.[symbol] ?? input?.flowBySymbol?.[symbol] ??
      raw?.flows ?? raw?.flow ?? raw?.f;
    const parsedBars = parseRows(history, 'kline', cutoff);
    const parsedFlows = parseRows(flow, 'flow', cutoff);
    const industry = String(raw?.f100 ?? raw?.industry ?? '').trim() || null;
    const stale = root.serverStale === true || item.serverStale === true;
    const flowDegraded = item?.dataQuality?.flowSource === 'neutral' ||
      flow?.degraded === true || flow?.source === 'neutral-flow-fallback';
    const degraded = flowDegraded || item?.dataQuality?.degraded === true ||
      history?.source === 'tencent-kline-fallback';
    const frame = features(raw, parsedBars.data, parsedFlows.data, sectors.get(industry), flowDegraded);
    const price = n(raw?.f2 ?? raw?.price) ?? parsedBars.data.at(-1)?.close ?? null;
    const blockedReasons = [...parsedBars.blocked, ...parsedFlows.blocked];
    if (!cutoff) blockedReasons.push('snapshot-asof-missing-or-invalid');
    if (!/^((00)|(60))\d{4}$/.test(symbol)) blockedReasons.push('board-not-allowed');
    if (raw?.specialTreatment === true || /ST|退/i.test(String(raw?.name ?? raw?.f14 ?? ''))) blockedReasons.push('special-treatment');
    if (!(price > 0)) blockedReasons.push('price-missing-or-invalid');
    if (frame.risk.averageAmount20dCny === null) blockedReasons.push('liquidity-history-incomplete');
    else if (frame.risk.averageAmount20dCny < 8e7) blockedReasons.push('liquidity-below-minimum');
    if (frame.risk.maxDrawdown20dPct >= 15 || frame.risk.volatility20dPct >= 8) blockedReasons.push('risk-limit');
    if (duplicateDeep.has(symbol)) blockedReasons.push('duplicate-deep-response');
    if (item.error) blockedReasons.push('deep-source-error');
    if (discovery?.qualifiedForDiscovery === false || discovery?.quality?.qualified === false || discovery?.status === 'SOURCE_FAILED') blockedReasons.push('sector-source-unqualified');
    if (stale) blockedReasons.push('stale-ranked-source');
    if (degraded) blockedReasons.push('degraded-deep-source');
    if (raw?.barComplete === false || item?.barComplete === false) blockedReasons.push('unfinished-daily-bar');
    if (marketRisk === 'unknown') blockedReasons.push('market-risk-unknown');
    const warnings = [...parsedBars.warnings, ...parsedFlows.warnings];
    if (!raw?.quoteAt && !raw?.f124) warnings.push('individual-quote-time-unavailable');
    records.push(createCandidateRecord({
      asOf, symbol, name: raw?.f14 ?? raw?.name ?? symbol, industry, price, marketRisk,
      source: { rankedMethod: root.method ?? null, deep: deepMap.has(symbol),
        klineSource: item?.dataQuality?.klineSource ?? history?.source ?? null,
        flowSource: item?.dataQuality?.flowSource ?? flow?.source ?? null,
        quoteAt: raw?.quoteAt ?? null, quoteTimestamp: n(raw?.f124),
        sectorQuality: discovery?.quality ?? null },
      features: frame, quality: { blockedReasons: [...new Set(blockedReasons)],
        warnings: [...new Set(warnings)], degraded, stale, historyRows: parsedBars.data.length }
    }));
  }
  const ranking = rankCandidates(records);
  // V11 phase 1 replaces scoring only. Keep the existing CORE decision thresholds.
  const decision = generateDecision(ranking.map(record => ({
    ...record, adjustedScore: record.scores.alphaRaw,
    dataComplete: record.quality.complete
  })), marketRisk);
  return {
    version: 'V11 Short Alpha Phase 1', schema: 'v11-short-alpha-flow-v1',
    asOf, market: { marketRisk }, ranking, candidates: ranking, diagnostics, ...decision
  };
}

export const evaluateV11 = integrateCandidateFlow;
