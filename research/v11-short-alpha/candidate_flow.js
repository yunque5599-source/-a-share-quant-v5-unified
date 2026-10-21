import { generateDecision } from '../v1040-core/decision_engine/decision_output.js';
import { normalizeMarketRisk, inferMarketRisk } from '../v1040-core/adapter/market_adapter.js';
import { finiteNumber as n, clamp, round, validDate, asOfDate, createCandidateRecord } from './schema.js';
import { rankCandidates } from './alpha_score.js';
import { withPsychology } from './psychology_score.js';
import { withV12TradeScore } from './v12_trade_score.js';
import { withV12SelectionScore } from './v12_selection_score.js';
import { buildMarketEmotion } from './market_emotion.js';
import { computeTrendStructure } from './trend_structure.js';
import { computeEarlyOpportunity, withEarlyOpportunityPsychology } from './early_opportunity.js';

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
        date, open: n(array ? fields[1] : fields?.open),
        close,
        high: n(array ? fields[3] : fields?.high),
        low: n(array ? fields[4] : fields?.low),
        volume: n(array ? fields[5] : fields?.volume ?? fields?.vol),
        amount: n(array ? fields[6] : fields?.amount ?? fields?.turnover)
      });
    } else {
      // Eastmoney fflow daily schema after f51(date):
      // f52 main, f53 small, f54 medium, f55 large, f56 super-large,
      // f57 main %, f58 small %, f59 medium %, f60 large %, f61 super-large %,
      // f62 price, f63 change %. Keep the order-bucket amounts for V12 psychology.
      result.push({
        date,
        net: n(array ? fields[1] : fields?.mainNet ?? fields?.net ?? fields?.main),
        pct: n(array ? fields[6] : fields?.mainNetPct ?? fields?.netPct ?? fields?.pct),
        smallNet: n(array ? fields[2] : fields?.smallNet ?? fields?.small),
        mediumNet: n(array ? fields[3] : fields?.mediumNet ?? fields?.mediumNetCny ?? fields?.medium),
        largeNet: n(array ? fields[4] : fields?.largeNet ?? fields?.largeNetCny ?? fields?.large),
        superLargeNet: n(array ? fields[5] :
          fields?.superLargeNet ?? fields?.superLargeNetCny ?? fields?.super_large ?? fields?.superLarge)
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
  const prior5Return = bars.length >= 11
    ? (bars.at(-6).close / bars.at(-11).close - 1) * 100 : null;
  const accelerationPct = usable([r5, prior5Return]) ? r5 - prior5Return : null;
  const highs = bars.slice(-21, -1).map(bar => bar.high);
  const breakout = highs.length === 20 && usable(highs) && highs.every(high => high > 0)
    ? (last.close / Math.max(...highs) - 1) * 100 : null;
  const overboughtRisk = usable([r5, r10, breakout])
    ? r5 >= 15 || r10 >= 30 || breakout >= 10 ? 'high'
      : r5 >= 10 || r10 >= 20 || breakout >= 6 ? 'elevated' : 'normal'
    : 'unknown';
  const overboughtPenalty = overboughtRisk === 'high' ? 22
    : overboughtRisk === 'elevated' ? 10 : 0;
  const trendStage = overboughtRisk === 'high' ? 'high-risk'
    : r5 === null || r10 === null ? 'unknown'
      : r5 > 0.5 && r10 <= 8 && (accelerationPct ?? 0) >= -0.5 ? 'startup'
        : r10 >= 5 && ((accelerationPct ?? 0) >= -1 || breakout >= 0) ? 'acceleration'
          : r10 > 0 ? 'mature' : 'range';
  const stageScore = {
    startup: 84, acceleration: 88, mature: 62, range: 50, 'high-risk': 25
  }[trendStage] ?? null;
  const baseMomentumScore = usable([r5, r10, breakout])
    ? pctScore(r5, 5) * 0.35 + pctScore(r10, 5) * 0.35 + pctScore(breakout, 10) * 0.30
    : null;
  const momentumScore = baseMomentumScore === null ? null
    : clamp((stageScore === null ? baseMomentumScore
      : baseMomentumScore * 0.70 + stageScore * 0.30) - overboughtPenalty);
  const momentum = {
    return5dPct: r5, return10dPct: r10, prior5dReturnPct: prior5Return,
    accelerationPct, breakoutStrengthPct: breakout, trendStage,
    trendStageScore: stageScore, overboughtRisk, overboughtPenalty,
    score: momentumScore
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
  // Intraday snapshots often have today's price bar while the daily fund-flow endpoint
  // still ends on the previous completed session. Match the latest five available flow
  // observations instead of requiring an exact same-day join.
  const usableFlows = flows.filter(flow => flow && flow.date && n(flow.net) !== null);
  const recentFlows = usableFlows.slice(-5);
  const priorFlows = usableFlows.slice(-10, -5);
  const flowComplete = recentFlows.length === 5;
  const priorFlowComplete = priorFlows.length === 5;
  const recentNet = flowComplete ? recentFlows.reduce((sum, flow) => sum + flow.net, 0) : null;
  const priorNet = priorFlowComplete ? priorFlows.reduce((sum, flow) => sum + flow.net, 0) : null;
  const recentLargeNet = flowComplete && recentFlows.every(flow => n(flow.largeNet) !== null)
    ? recentFlows.reduce((sum, flow) => sum + flow.largeNet, 0) : null;
  const recentSuperLargeNet = flowComplete && recentFlows.every(flow => n(flow.superLargeNet) !== null)
    ? recentFlows.reduce((sum, flow) => sum + flow.superLargeNet, 0) : null;
  const priorLargeNet = priorFlowComplete && priorFlows.every(flow => n(flow.largeNet) !== null)
    ? priorFlows.reduce((sum, flow) => sum + flow.largeNet, 0) : null;
  const priorSuperLargeNet = priorFlowComplete && priorFlows.every(flow => n(flow.superLargeNet) !== null)
    ? priorFlows.reduce((sum, flow) => sum + flow.superLargeNet, 0) : null;
  const recentLargeOrderNet = recentLargeNet !== null && recentSuperLargeNet !== null
    ? recentLargeNet + recentSuperLargeNet : null;
  const priorLargeOrderNet = priorLargeNet !== null && priorSuperLargeNet !== null
    ? priorLargeNet + priorSuperLargeNet : null;
  const recentLargeOrderPositiveRatio = flowComplete &&
    recentFlows.every(flow => n(flow.largeNet) !== null && n(flow.superLargeNet) !== null)
    ? recentFlows.filter(flow => flow.largeNet + flow.superLargeNet > 0).length / 5 : null;
  const earlyPositiveRatio = priorFlowComplete
    ? priorFlows.filter(flow => flow.net > 0).length / 5 : null;
  const recentAmount5d = bars.length >= 5
    ? bars.slice(-5).map(bar => bar.amount).filter(value => n(value) !== null && value > 0)
      .reduce((sum, value) => sum + value, 0) : null;
  const largeOrderNetPct5d = recentLargeOrderNet !== null && recentAmount5d > 0
    ? recentLargeOrderNet / recentAmount5d * 100 : null;
  const priorAmount5d = bars.length >= 10
    ? bars.slice(-10, -5).map(bar => bar.amount).filter(value => n(value) !== null && value > 0)
      .reduce((sum, value) => sum + value, 0) : null;
  const priorLargeOrderNetPct5d = priorLargeOrderNet !== null && priorAmount5d > 0
    ? priorLargeOrderNet / priorAmount5d * 100 : null;
  const currentFlow = last ? (flowByDate.get(last.date) ?? usableFlows.at(-1)) : usableFlows.at(-1);
  const flowLagDays = currentFlow?.date && last?.date
    ? Math.max(0, (Date.parse(last.date) - Date.parse(currentFlow.date)) / 86400000) : null;
  const flowFreshEnough = flowLagDays === null || flowLagDays <= 4;
  const mainNet = flowDegraded || !flowFreshEnough ? null :
    n(raw?.f62 ?? raw?.mainNet) ?? currentFlow?.net ?? null;
  const mainPct = flowDegraded || !flowFreshEnough ? null :
    n(raw?.f184 ?? raw?.mainPct) ?? currentFlow?.pct ??
    (mainNet !== null && last?.amount > 0 ? mainNet / last.amount * 100 : null);
  const positiveRatio = !flowDegraded && flowFreshEnough && flowComplete
    ? recentFlows.filter(flow => flow.net > 0).length / 5 : null;
  const netStrength = mainNet === null ? null
    : clamp(50 + Math.sign(mainNet) * 10 * Math.log10(1 + Math.abs(mainNet) / 1e6));
  const highPriceFlow = recentNet !== null && recentNet > 0 &&
    ((r5 !== null && r5 >= 10) || (breakout !== null && breakout >= 6) || overboughtRisk === 'high');
  const flowTiming = !flowComplete ? 'unknown'
    : highPriceFlow ? 'late-high-inflow'
      : priorNet !== null && priorNet > 0 && earlyPositiveRatio >= 0.6 ? 'early-inflow'
        : recentNet > 0 ? 'recent-inflow' : 'outflow';
  const timingScore = {
    'early-inflow': 86, 'recent-inflow': 62, 'late-high-inflow': 28, outflow: 24
  }[flowTiming] ?? null;
  const lateFlowPenalty = flowTiming === 'late-high-inflow' ? 18 : 0;
  const baseCapitalScore = usable([mainNet, mainPct, positiveRatio])
    ? pctScore(mainPct, 5) * 0.50 + netStrength * 0.25 + positiveRatio * 100 * 0.25 : null;
  const capital = {
    mainNetCny: mainNet, mainNetPct: mainPct, positiveFlowRatio5d: positiveRatio,
    earlyNetCny: priorNet, recentNetCny: recentNet,
    largeOrderNet5dCny: recentLargeOrderNet,
    superLargeOrderNet5dCny: recentSuperLargeNet,
    largeOrderNetPct5d, priorLargeOrderNetPct5d,
    largeOrderPositiveRatio5d: recentLargeOrderPositiveRatio,
    priorLargeOrderNetCny: priorLargeOrderNet,
    priorSuperLargeOrderNetCny: priorSuperLargeNet,
    earlyPositiveFlowRatio5d: earlyPositiveRatio, flowTiming, lateFlowPenalty,
    amountCny: last?.amount ?? n(raw?.f6 ?? raw?.amount),
    score: baseCapitalScore === null || timingScore === null ? null
      : clamp(baseCapitalScore * 0.75 + timingScore * 0.25 - lateFlowPenalty)
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
  const marketEmotion = buildMarketEmotion(
    root.indices ?? input?.indices ?? [],
    candidates
  );
  const diagnostics = { inputCount: candidates.length, duplicateCandidates: 0,
    rejectedCandidates: 0, psychologyComplete: 0, v12Eligible: 0,
    marketEmotionScore:marketEmotion.score };
  const hasExplicitMarket = options.market !== undefined ||
    input?.market !== undefined || root.marketRisk !== undefined;
  const explicitMarket = options.market ?? input?.market ?? root.marketRisk;
  let marketRisk = normalizeMarketRisk(explicitMarket);
  if (marketRisk === 'unknown' && !hasExplicitMarket) {
    marketRisk = inferMarketRisk(root.indices ?? input?.indices ?? [], explicitMarket);
  }
  if (marketRisk === 'unknown' && !hasExplicitMarket) {
    const marketRows = candidates.slice(0, 120)
      .map(row => n(row?.f3 ?? row?.pct ?? row?.changePct))
      .filter(value => value !== null);
    if (marketRows.length >= 20) {
      const averagePct = mean(marketRows);
      const positiveRatio = marketRows.filter(value => value > 0).length / marketRows.length;
      marketRisk = averagePct <= -1.5 || positiveRatio < 0.35 ? 'weak'
        : averagePct < 0 || positiveRatio < 0.45 ? 'elevated' : 'normal';
    }
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
    const baseFeatures = features(raw, parsedBars.data, parsedFlows.data, sectors.get(industry), flowDegraded);
    const frame = {
      ...baseFeatures,
      trendStructure:computeTrendStructure({bars:parsedBars.data, asOf}, {
        asOf,
        barComplete:raw?.barComplete ?? item?.barComplete
      }),
      earlyOpportunity:computeEarlyOpportunity({
        bars:parsedBars.data, asOf,
        barComplete:raw?.barComplete ?? item?.barComplete,
        features:baseFeatures
      })
    };
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
  const alphaRanking = rankCandidates(records);
  const psychologyContext = options.psychology ??
    input?.psychology ?? discovery?.psychology ?? discovery?.themeResearch ?? null;
  const ranking = alphaRanking.map(record => {
    const psychologyInput = psychologyContext && typeof psychologyContext === 'object'
      ? {...psychologyContext, marketEmotion}
      : {marketEmotion};
    const withPsych = withPsychology({
      ...record,
      marketEmotion
    }, psychologyInput);
    const withV12 = withV12TradeScore(withPsych);
    const withSelection = withV12SelectionScore(withV12);
    const withEarly = withEarlyOpportunityPsychology(withSelection);
    if (withPsych.psychology?.complete === true) diagnostics.psychologyComplete += 1;
    if (withSelection.scores?.v12SelectionRaw !== null && record.quality.complete &&
        withPsych.psychology?.complete === true) diagnostics.v12Eligible += 1;
    return withEarly;
  });
  const earlyOpportunityRanking = ranking
    .filter(record => record.quality.complete && record.features?.earlyOpportunity?.score !== null &&
      Number.isFinite(record.features?.earlyOpportunity?.score))
    .sort((a, b) => b.features.earlyOpportunity.score - a.features.earlyOpportunity.score ||
      (b.features.trendStructure?.score ?? -1) - (a.features.trendStructure?.score ?? -1) ||
      a.symbol.localeCompare(b.symbol))
    .map((record, index) => ({...record, earlyOpportunityRank:index + 1}));
  diagnostics.earlyOpportunityScored = ranking.filter(record =>
    Number.isFinite(record.features?.earlyOpportunity?.score)).length;
  diagnostics.earlyOpportunityEligible = earlyOpportunityRanking.length;
  const tradeRanking = ranking
    .filter(record => record.quality.complete &&
      record.psychology?.complete === true &&
      record.scores?.v12TradeRaw !== null)
    .sort((a, b) =>
      b.scores.v12TradeRaw - a.scores.v12TradeRaw ||
      b.scores.alphaRaw - a.scores.alphaRaw ||
      a.symbol.localeCompare(b.symbol))
    .map((record, index) => ({...record, tradeRank:index + 1}));
  // V11/V12 research layers replace selection ranking only. Keep the existing CORE decision thresholds.
  const decision = generateDecision(ranking.map(record => ({
    ...record, adjustedScore: record.scores.alphaRaw,
    dataComplete: record.quality.complete
  })), marketRisk);
  return {
    version: 'V11 Short Alpha Phase 1', schema: 'v11-short-alpha-flow-v1',
    asOf, market: { marketRisk, emotion:marketEmotion }, ranking, candidates: ranking, tradeRanking,
    earlyOpportunityRanking,
    diagnostics, ...decision
  };
}

export const evaluateV11 = integrateCandidateFlow;
