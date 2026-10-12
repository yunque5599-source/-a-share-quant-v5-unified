import { clamp, finiteNumber } from './candidate_adapter.js';

const ALIASES = Object.freeze({
  normal: new Set(['normal', '正常', 'low', '低', 'healthy', 'bull', 'safe']),
  elevated: new Set(['elevated', '中', 'medium', 'caution']),
  weak: new Set(['weak', '弱', 'bear', 'crash', 'extreme', 'very_high', 'high', '高']),
  unknown: new Set(['', 'unknown', '未知', 'n/a', 'na', 'null', 'undefined'])
});

function firstFinite(source, keys) {
  for (const key of keys) {
    const value = finiteNumber(source?.[key]);
    if (value !== null) return value;
  }
  return null;
}

function average(values) {
  const valid = values.map(finiteNumber).filter(value => value !== null);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function normalizePercent(value, center = 0, multiplier = 5) {
  const number = finiteNumber(value);
  return number === null ? null : clamp(50 + (number - center) * multiplier);
}

function amountScore(value) {
  const amount = finiteNumber(value);
  if (amount === null || amount <= 0) return null;
  return clamp((Math.log10(amount) - 6) * 25);
}

function weighted(parts) {
  return parts.reduce((sum, part) => sum + (part.value === null ? 0 : part.value * part.weight), 0);
}

function rowList(raw) {
  if (Array.isArray(raw)) return raw;
  return raw?.data?.klines ?? raw?.klines ?? raw?.data?.rows ?? raw?.rows ?? [];
}

function parseKlineRows(raw) {
  return rowList(raw).map((row, index) => {
    if (typeof row === 'string') {
      const fields = row.split(/[~,]/);
      return {
        date: fields[0] ?? String(index),
        open: finiteNumber(fields[1]),
        close: finiteNumber(fields[2]),
        high: finiteNumber(fields[3]),
        low: finiteNumber(fields[4]),
        volume: finiteNumber(fields[5]),
        amount: finiteNumber(fields[6]),
        index
      };
    }
    return {
      date: String(row?.date ?? row?.time ?? row?.[0] ?? index),
      open: firstFinite(row, ['open', 'o', 'f52', 1]),
      close: firstFinite(row, ['close', 'price', 'c', 'f53', 2]),
      high: firstFinite(row, ['high', 'h', 'f54', 3]),
      low: firstFinite(row, ['low', 'l', 'f55', 4]),
      volume: firstFinite(row, ['volume', 'vol', 'v', 'f56', 5]),
      amount: firstFinite(row, ['amount', 'turnover', 'f57', 6]),
      index
    };
  }).filter(row => row.close !== null && row.close > 0)
    .sort((left, right) => {
      const a = Date.parse(left.date.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'));
      const b = Date.parse(right.date.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'));
      return (Number.isFinite(a) && Number.isFinite(b) ? a - b : left.index - right.index);
    });
}

function parseFlowRows(raw) {
  return rowList(raw).map((row, index) => {
    if (typeof row === 'string') {
      const fields = row.split(/[~,]/);
      return {
        date: fields[0] ?? String(index),
        net: finiteNumber(fields[1]),
        netPct: finiteNumber(fields[6]),
        amount: finiteNumber(fields[11]),
        index
      };
    }
    return {
      date: String(row?.date ?? row?.time ?? row?.[0] ?? index),
      net: firstFinite(row, ['mainNet', 'mainNetInflow', 'net', 'inflow', 'f52', 1]),
      netPct: firstFinite(row, ['mainNetPct', 'netPct', 'inflowPct', 'f57', 6]),
      amount: firstFinite(row, ['amount', 'turnover', 'f62', 11]),
      index
    };
  }).filter(row => row.net !== null || row.netPct !== null)
    .sort((left, right) => left.index - right.index);
}

function movingAverage(values, length) {
  return values.length < length ? null : average(values.slice(-length));
}

function standardDeviation(values) {
  const valid = values.filter(value => value !== null);
  if (valid.length < 2) return null;
  const mean = average(valid);
  return Math.sqrt(average(valid.map(value => (value - mean) ** 2)));
}

function historyMetrics(rawHistory) {
  const rows = parseKlineRows(rawHistory);
  const closes = rows.map(row => row.close);
  const amounts = rows.map(row => row.amount);
  const volumes = rows.map(row => row.volume);
  const lastClose = closes.at(-1) ?? null;
  const gain5Pct = closes.length >= 6 ? (lastClose / closes.at(-6) - 1) * 100 : null;
  const trend20Pct = closes.length >= 21 ? (lastClose / closes.at(-21) - 1) * 100 : null;
  const ma5 = movingAverage(closes, 5);
  const ma10 = movingAverage(closes, 10);
  const ma20 = movingAverage(closes, 20);
  const maAligned = ma5 !== null && ma10 !== null && ma20 !== null
    ? ma5 > ma10 && ma10 > ma20
    : null;
  const priceAboveMa20 = ma20 === null ? null : lastClose > ma20;
  const maStructureScore = maAligned === null ? null : maAligned && priceAboveMa20
    ? 100
    : priceAboveMa20 ? 70 : 30;
  const returns = closes.slice(1).map((close, index) => (close / closes[index] - 1) * 100).slice(-20);
  const volatilityPct = returns.length >= 3 ? standardDeviation(returns) : null;
  const priorHighs = rows.slice(0, -1).map(row => row.high ?? row.close).filter(value => value !== null).slice(-20);
  const breakout = priorHighs.length >= 10 && lastClose > Math.max(...priorHighs);
  const priorVolumes = volumes.slice(0, -1).filter(value => value !== null).slice(-20);
  const lastVolume = volumes.at(-1) ?? null;
  const volumeExpansionRatio = lastVolume !== null && priorVolumes.length >= 10
    ? lastVolume / (average(priorVolumes) || 1)
    : null;
  const volumeExpansionScore = volumeExpansionRatio === null
    ? null
    : clamp(50 + (volumeExpansionRatio - 1) * 50);
  const breakoutScore = priorHighs.length < 10 ? null : breakout ? 100 : 30;
  const strongSignals = [
    gain5Pct === null ? null : normalizePercent(gain5Pct, 0, 5),
    trend20Pct === null ? null : normalizePercent(trend20Pct, 0, 3),
    maStructureScore
  ];
  const strongStockScore = strongSignals.some(value => value === null) ? null : average(strongSignals);
  const shortTermScore = weighted([
    { value: volumeExpansionScore, weight: 0.35 },
    { value: breakoutScore, weight: 0.35 },
    { value: strongStockScore, weight: 0.30 }
  ]);
  const amountWindow = amounts.slice(-20).filter(value => value !== null);
  return {
    rows,
    observations: rows.length,
    gain5Pct,
    trend20Pct,
    ma5,
    ma10,
    ma20,
    maAligned,
    priceAboveMa20,
    maStructureScore,
    volatilityPct,
    avgTurnover20dCny: amountWindow.length >= 20 ? average(amountWindow) : null,
    volumeExpansionRatio,
    volumeExpansionScore,
    breakout,
    breakoutScore,
    strongStockScore,
    shortTermScore,
    trendScore: weighted([
      { value: gain5Pct === null ? null : normalizePercent(gain5Pct, 0, 5), weight: 0.35 },
      { value: trend20Pct === null ? null : normalizePercent(trend20Pct, 0, 3), weight: 0.35 },
      { value: maStructureScore, weight: 0.30 }
    ])
  };
}

function fundingMetrics(rawFlows, currentNet, currentNetPct, averageAmount) {
  const rows = parseFlowRows(rawFlows);
  if (!rows.length && (currentNet !== null || currentNetPct !== null)) {
    rows.push({ net: currentNet, netPct: currentNetPct, amount: averageAmount, index: 0 });
  }
  const netPctValues = rows.map(row => row.netPct).filter(value => value !== null);
  const derivedNetPct = rows.map(row => {
    if (row.netPct !== null) return row.netPct;
    if (row.net !== null && row.amount > 0) return row.net / row.amount * 100;
    return null;
  }).filter(value => value !== null);
  const positiveFlags = rows.map(row => row.net !== null ? row.net > 0 : row.netPct !== null && row.netPct > 0);
  let streak = 0;
  for (let index = positiveFlags.length - 1; index >= 0 && positiveFlags[index]; index -= 1) streak += 1;
  const positiveRatio = positiveFlags.length ? positiveFlags.filter(Boolean).length / positiveFlags.length : null;
  const continuousScore = positiveRatio === null ? null :
    clamp(positiveRatio * 60 + (streak / Math.min(5, positiveFlags.length)) * 40);
  const inflowScore = derivedNetPct.length ? normalizePercent(average(derivedNetPct), 0, 5) : null;
  const amountComponent = amountScore(averageAmount);
  const capitalScore = weighted([
    { value: amountComponent, weight: 0.30 },
    { value: inflowScore, weight: 0.40 },
    { value: continuousScore, weight: 0.30 }
  ]);
  return {
    observations: rows.length,
    averageNetPct: average(derivedNetPct),
    positiveRatio,
    consecutivePositiveDays: streak,
    inflowScore,
    continuousScore,
    amountScore: amountComponent,
    capitalScore
  };
}

export function normalizeMarketRisk(input) {
  const raw = typeof input === 'string'
    ? input
    : input?.marketRisk ?? input?.riskLevel ?? input?.status ?? input?.risk ?? '';
  const value = String(raw ?? '').trim().toLowerCase();
  for (const [status, values] of Object.entries(ALIASES)) {
    if (values.has(value)) return status;
  }
  return 'unknown';
}

export function inferMarketRisk(indices = [], explicitRisk = null) {
  const explicit = normalizeMarketRisk(explicitRisk);
  if (explicit !== 'unknown') return explicit;
  const valid = (Array.isArray(indices) ? indices : [])
    .map(item => finiteNumber(item?.pct ?? item?.changePct))
    .filter(value => value !== null);
  if (!valid.length) return 'unknown';
  const averageIndexPct = average(valid);
  if (averageIndexPct <= -1.5) return 'weak';
  if (averageIndexPct < 0) return 'elevated';
  return 'normal';
}

export function normalizeMarket(input = {}) {
  const marketRisk = normalizeMarketRisk(input);
  return {
    marketRisk,
    status: marketRisk,
    known: marketRisk !== 'unknown',
    source: input && typeof input === 'object' ? input.source ?? null : null,
    reason: input && typeof input === 'object' ? input.reason ?? null : null
  };
}

export function adaptMarketCandidate(raw = {}, context = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const symbol = String(source.symbol ?? source.code ?? source.f12 ?? '').trim();
  const name = String(source.name ?? source.stockName ?? source.f14 ?? symbol).trim();
  const dayPct = firstFinite(source, ['pct', 'dayPct', 'f3']);
  const industry = String(source.industry ?? source.f100 ?? '').trim();
  const currentNet = firstFinite(source, ['mainNet', 'mainNetInflow', 'f62']);
  const currentNetPct = firstFinite(source, ['mainPct', 'mainNetPct', 'f184']);
  const rawAmount = firstFinite(source, ['amount', 'f6']);
  const rawTurn = firstFinite(source, ['turn', 'turnover', 'f8']);
  const history = historyMetrics(
    context.history ?? source.history ?? source.kline ?? source.klines ?? null
  );
  const funding = fundingMetrics(
    context.flows ?? source.flows ?? source.flow ?? source.fundFlows ?? null,
    currentNet,
    currentNetPct,
    history.avgTurnover20dCny ?? rawAmount
  );
  const sector = context.sectors?.[industry] ?? null;
  const sectorPct = firstFinite(source, ['sectorPct', 'industryPct']) ??
    firstFinite(sector, ['pct', 'medianPct', 'changePct']);
  const sectorRank = firstFinite(source, ['sectorRank', 'industryRank']) ??
    firstFinite(sector, ['rank']);
  const sectorTotal = firstFinite(source, ['sectorTotal', 'industryTotal']) ??
    firstFinite(sector, ['total']);
  const sectorPctScore = normalizePercent(sectorPct, 0, 5);
  const sectorRankScore = sectorRank !== null && sectorTotal > 1
    ? clamp(100 - ((sectorRank - 1) / (sectorTotal - 1)) * 100)
    : null;
  const sectorScore = firstFinite(source, ['sectorScore', 'industryScore']) ??
    (sectorPctScore === null && sectorRankScore === null
      ? null
      : weighted([
          { value: sectorPctScore, weight: 0.60 },
          { value: sectorRankScore, weight: 0.40 }
        ]));
  const catalystScore = firstFinite(source, ['catalystScore', 'catalyst']) ??
    finiteNumber(context.catalystScores?.[symbol]);
  const shortTermScore = firstFinite(source, ['shortTermScore', 'volumeScore', 'volumePriceScore']) ??
    history.shortTermScore;
  const capitalScore = firstFinite(source, ['capitalScore', 'fundsScore']) ?? funding.capitalScore;
  const trendScore = firstFinite(source, ['trendScore', 'trendQualityScore']) ?? history.trendScore;
  const warnings = [];
  if (!history.observations || history.observations < 21) warnings.push('kline-history-below-21-sessions');
  if (history.gain5Pct === null) warnings.push('five-day-trend-unavailable');
  if (history.trend20Pct === null) warnings.push('twenty-day-trend-unavailable');
  if (history.maStructureScore === null) warnings.push('moving-average-structure-unavailable');
  if (funding.observations < 5) warnings.push('continuous-funding-history-unavailable');
  if (sectorPctScore === null || sectorRankScore === null) warnings.push('industry-strength-partial');
  if (catalystScore === null) warnings.push('catalyst-data-unavailable');
  if (history.volatilityPct === null || history.avgTurnover20dCny === null) {
    warnings.push('risk-history-incomplete');
  }
  return {
    symbol,
    name,
    industry: industry || null,
    capitalScore,
    trendScore,
    sectorScore,
    shortTermScore,
    volumeScore: shortTermScore,
    catalystScore,
    shortTermGainPct: firstFinite(source, ['shortTermGainPct', 'gain5dPct']) ?? history.gain5Pct,
    volatilityPct: firstFinite(source, ['volatilityPct', 'vol20dPct']) ?? history.volatilityPct,
    avgTurnover20dCny: firstFinite(source, ['avgTurnover20dCny', 'averageTurnover20dCny']) ?? history.avgTurnover20dCny,
    currentPrice: firstFinite(source, ['currentPrice', 'price', 'f2']),
    providerPct: dayPct,
    providerPct60: firstFinite(source, ['pct60', 'f24']),
    providerAmount: rawAmount,
    providerTurnover: rawTurn,
    providerMainNet: currentNet,
    providerMainPct: currentNetPct,
    source: context.source ?? source.source ?? 'market-adapter',
    historyMetrics: history,
    fundingMetrics: funding,
    industryMetrics: {
      pct: sectorPct,
      rank: sectorRank,
      total: sectorTotal,
      pctScore: sectorPctScore,
      rankScore: sectorRankScore
    },
    dataQualityWarnings: warnings,
    rawProviderFields: {
      code: source.code ?? source.f12 ?? null,
      name: source.name ?? source.f14 ?? null,
      quoteAt: source.quoteAt ?? null
    }
  };
}

function payloadRoot(payload) {
  return payload?.data && typeof payload.data === 'object' ? payload.data : payload;
}

function buildSectorLookup(root, payload) {
  const sectors = root?.sectorResearch?.sectors ?? payload?.sectorResearch?.sectors ?? [];
  const list = Array.isArray(sectors) ? sectors : [];
  return Object.fromEntries(list.map((sector, index) => {
    const total = finiteNumber(sector.total) ?? list.length;
    return [String(sector.industry ?? '').trim(), { ...sector, rank: finiteNumber(sector.rank) ?? index + 1, total }];
  }).filter(([industry]) => industry));
}

function buildHistoryLookup(root, payload) {
  const history = root?.historyBySymbol ?? root?.history ?? payload?.historyBySymbol ?? payload?.history ?? {};
  const flows = root?.flowBySymbol ?? root?.flowsBySymbol ?? payload?.flowBySymbol ?? payload?.flowsBySymbol ?? {};
  const historyBySymbol = { ...(history && typeof history === 'object' ? history : {}) };
  const flowsBySymbol = { ...(flows && typeof flows === 'object' ? flows : {}) };
  for (const item of (Array.isArray(root?.items) ? root.items : [])) {
    const symbol = String(item?.code ?? item?.symbol ?? '').trim();
    if (!symbol) continue;
    if (item.kline) historyBySymbol[symbol] = item.kline;
    if (item.flow) flowsBySymbol[symbol] = item.flow;
  }
  return { historyBySymbol, flowsBySymbol };
}

export function adaptMarketPayload(payload = {}, options = {}) {
  const root = payloadRoot(payload) ?? {};
  const candidates = Array.isArray(root)
    ? root
    : root.candidates ?? root.records ?? root.items ?? [];
  const source = root.records ? 'discovery_universe.js' : 'market.js';
  const sectors = buildSectorLookup(root, payload);
  const lookups = buildHistoryLookup(root, payload);
  const marketRisk = inferMarketRisk(
    root.indices ?? payload?.indices ?? [],
    options.marketRisk ?? root.marketRisk ?? payload?.marketRisk
  );
  const market = {
    marketRisk,
    status: marketRisk,
    source,
    generatedAt: root.generatedAt ?? payload?.generatedAt ?? null,
    indices: root.indices ?? payload?.indices ?? [],
    quality: root.quality ?? payload?.quality ?? null,
    reason: marketRisk === 'unknown' ? 'No explicit market risk or usable index breadth.' : 'Derived from explicit risk or index percentage changes.'
  };
  return {
    market,
    candidates: (Array.isArray(candidates) ? candidates : [])
      .map(item => {
        const symbol = String(item?.symbol ?? item?.code ?? item?.f12 ?? '').trim();
        return adaptMarketCandidate(item, {
          ...options,
          source,
          sectors,
          history: lookups.historyBySymbol[symbol] ?? item?.kline ?? item?.klines,
          flows: lookups.flowsBySymbol[symbol] ?? item?.flow ?? item?.flows
        });
      })
      .filter(candidate => candidate.symbol),
    source,
    metadata: {
      schema: root.schema ?? null,
      method: root.method ?? null,
      generatedAt: root.generatedAt ?? null,
      candidateCount: Array.isArray(candidates) ? candidates.length : 0,
      quality: root.quality ?? null
    }
  };
}

export const adaptRealCandidate = adaptMarketCandidate;
export const adaptRealPayload = adaptMarketPayload;
