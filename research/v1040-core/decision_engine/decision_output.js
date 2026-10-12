import { normalizeMarketRisk } from '../adapter/market_adapter.js';

function scoreOf(stock) {
  return Number.isFinite(Number(stock?.adjustedScore)) ? Number(stock.adjustedScore) : 0;
}

function compact(stock) {
  if (!stock) return null;
  return {
    symbol: stock.symbol,
    name: stock.name ?? stock.symbol,
    adjustedScore: scoreOf(stock),
    factorScore: stock.factorScore ?? null,
    riskPenalty: stock.riskPenalty ?? null,
    dataComplete: Boolean(stock.dataComplete),
    reasons: Array.isArray(stock.reasons) ? stock.reasons : []
  };
}

export function generateDecision(ranking = [], marketInput = 'unknown') {
  const marketRisk = normalizeMarketRisk(marketInput);
  const top = Array.isArray(ranking) ? ranking.slice(0, 2).map(compact).filter(Boolean) : [];
  const top1 = top[0];
  const top2 = top[1];
  const distinctTopTwo = Boolean(top1 && top2 && top1.symbol && top1.symbol !== top2.symbol);
  const buyEligible = marketRisk === 'normal' &&
    distinctTopTwo && top1.adjustedScore >= 90 && top2.adjustedScore >= 85 &&
    top1.dataComplete && top2.dataComplete;
  let action = 'WAIT';
  let reason = 'No complete candidate reached the WATCH threshold.';
  if (buyEligible) {
    action = 'BUY';
    reason = 'Normal market; TOP1 >= 90 and TOP2 >= 85 with complete data.';
  } else if (marketRisk === 'normal' || marketRisk === 'elevated') {
    const watchable = (Array.isArray(ranking) ? ranking : [])
      .some(stock => Boolean(stock?.dataComplete) && scoreOf(stock) >= 70);
    if (watchable) {
      action = 'WATCH';
      reason = marketRisk === 'elevated'
        ? 'Market risk is elevated; BUY is blocked.'
        : 'At least one complete candidate reached adjustedScore >= 70.';
    }
  } else if (marketRisk === 'weak') {
    reason = 'Weak market; decision is forced to WAIT.';
  } else {
    reason = 'Market risk is unknown; decision is forced to WAIT.';
  }
  const portfolio = action === 'BUY'
    ? [
        { symbol: top1.symbol, name: top1.name, weight: 70, score: top1.adjustedScore },
        { symbol: top2.symbol, name: top2.name, weight: 30, score: top2.adjustedScore }
      ]
    : [];
  return {
    action, decision: action, marketRisk, top, portfolio, allocations: portfolio, reason, reasons: [reason]
  };
}
