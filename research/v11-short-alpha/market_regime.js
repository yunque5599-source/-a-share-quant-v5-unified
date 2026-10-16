import { finiteNumber, asOfDate } from './schema.js';

export const MARKET_REGIMES = Object.freeze(['bull', 'bear', 'sideways', 'unknown']);

const n = value => finiteNumber(value);

function explicit(value) {
  const text = String(value ?? '').toLowerCase();
  if (text === 'bull' || text.includes('牛')) return 'bull';
  if (text === 'bear' || text.includes('熊')) return 'bear';
  if (text === 'sideways' || text === 'neutral' || text.includes('震荡')) return 'sideways';
  return null;
}

function historyTrend(snapshot, market) {
  const asOf = asOfDate(snapshot?.asOf ?? snapshot?.date ?? snapshot?.generatedAt);
  if (!asOf) return null;
  const raw = snapshot?.marketHistory ?? snapshot?.indexHistory ??
    market?.history ?? market?.indexHistory;
  const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.index) ? raw.index : [];
  const bars = rows.filter(row => row?.complete !== false && row?.completed !== false).map(row => ({
    date: asOfDate(row?.date ?? row?.asOf),
    close: n(row?.close ?? row?.value ?? row?.price)
  })).filter(row => row.date && row.close !== null && row.close > 0 &&
    row.date <= asOf).sort((a, b) => a.date.localeCompare(b.date));
  if (bars.length < 2) return null;
  const first = bars[Math.max(0, bars.length - 21)];
  const last = bars.at(-1);
  return (last.close / first.close - 1) * 100;
}

/**
 * Research-only grouping label. It reads only fields captured at the snapshot
 * asOf time and never changes Alpha, Timing, or V12Trade scores.
 */
export function classifyMarketRegime(snapshot = {}) {
  const market = snapshot?.market ?? {};
  const explicitRegime = explicit(snapshot?.marketRegime ?? market.regime);
  if (explicitRegime) {
    return {regime:explicitRegime, score:explicitRegime==='bull'?75:explicitRegime==='bear'?25:50,
      confidence:1, features:{}, reasons:['explicit-regime']};
  }
  const indices = Array.isArray(snapshot?.indices) ? snapshot.indices :
    Array.isArray(market?.indices) ? market.indices : [];
  const pcts = indices.map(index => n(index?.pct ?? index?.changePct))
    .filter(value => value !== null);
  const directIndexPct = n(snapshot?.indexPct ?? market?.indexPct ??
    market?.changePct ?? snapshot?.changePct);
  if (!pcts.length && directIndexPct !== null) pcts.push(directIndexPct);
  const historyPct20 = historyTrend(snapshot, market);
  const averageIndexPct = pcts.length
    ? pcts.reduce((sum, value) => sum + value, 0) / pcts.length : historyPct20;
  let breadthPct = n(snapshot?.breadthPct ?? market?.breadthPct ??
    snapshot?.breadth?.advancePct ?? market?.breadth?.advancePct);
  if (breadthPct === null) {
    const advancing = n(snapshot?.breadth?.advancers ?? market?.breadth?.advancers);
    const declining = n(snapshot?.breadth?.decliners ?? market?.breadth?.decliners);
    const total = (advancing ?? 0) + (declining ?? 0);
    if (total > 0) breadthPct = advancing / total * 100;
  }
  const trendPct20 = historyPct20 ?? n(snapshot?.trendPct20 ?? market?.trendPct20);
  const trendScore = trendPct20 !== null
    ? Math.max(0, Math.min(100, 50 + trendPct20 * 2))
    : averageIndexPct === null ? null :
      Math.max(0, Math.min(100, 50 + averageIndexPct * 12));
  const breadthScore = breadthPct === null ? null : Math.max(0, Math.min(100, breadthPct));
  const scoreParts = [trendScore, breadthScore].filter(value => value !== null);
  const score = scoreParts.length ? scoreParts.reduce((sum, value) => sum + value, 0) / scoreParts.length : null;
  const regime = score === null ? 'unknown' : score >= 65 ? 'bull' : score <= 35 ? 'bear' : 'sideways';
  return {
    regime, score, confidence: scoreParts.length / 2,
    features:{averageIndexPct,trendPct20,breadthPct,trendScore,breadthScore},
    reasons: score === null ? ['market-fields-missing'] : ['asof-index-breadth']
  };
}
