const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
const finite = v => typeof v === 'number' && Number.isFinite(v);
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const median = xs => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y), m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

export const REGIME_POLICIES = Object.freeze({
  BULL_TREND: Object.freeze({
    label: '牛市主升', legacyLabel: '强势', minScore: 74, minMainline: 55, minPersistence: 58,
    maxCrowding: 14, maxBreakoutPenalty: 12, maxPos: 0.35, riskPerTrade: 0.018,
    maxHoldingDays: 8, allowNewPositions: true, targetFloor1: 0.07, targetFloor2: 0.12,
    targetMultiple1: 1.55, targetMultiple2: 2.4,
    weights: { T: 0.24, F: 0.19, M: 0.15, E: 0.10, P: 0.22, N: 0.10 },
    stage1Weights: { flow: 0.23, liq: 0.12, rs60: 0.15, momentum: 0.13, turnover: 0.08, sector: 0.12, rank: 0.17 }
  }),
  ROTATION: Object.freeze({
    label: '震荡轮动', legacyLabel: '中性', minScore: 78, minMainline: 58, minPersistence: 60,
    maxCrowding: 12, maxBreakoutPenalty: 10, maxPos: 0.25, riskPerTrade: 0.012,
    maxHoldingDays: 5, allowNewPositions: true, targetFloor1: 0.05, targetFloor2: 0.09,
    targetMultiple1: 1.35, targetMultiple2: 2.0,
    weights: { T: 0.20, F: 0.22, M: 0.16, E: 0.12, P: 0.18, N: 0.12 },
    stage1Weights: { flow: 0.26, liq: 0.14, rs60: 0.12, momentum: 0.10, turnover: 0.10, sector: 0.14, rank: 0.14 }
  }),
  BEAR_TREND: Object.freeze({
    label: '熊市下跌', legacyLabel: '弱势', minScore: 82, minMainline: 62, minPersistence: 65,
    maxCrowding: 10, maxBreakoutPenalty: 8, maxPos: 0.12, riskPerTrade: 0.006,
    maxHoldingDays: 3, allowNewPositions: true, targetFloor1: 0.04, targetFloor2: 0.07,
    targetMultiple1: 1.15, targetMultiple2: 1.7,
    weights: { T: 0.17, F: 0.24, M: 0.16, E: 0.12, P: 0.19, N: 0.12 },
    stage1Weights: { flow: 0.28, liq: 0.14, rs60: 0.15, momentum: 0.07, turnover: 0.10, sector: 0.14, rank: 0.12 }
  }),
  RECOVERY: Object.freeze({
    label: '趋势修复', legacyLabel: '中性', minScore: 80, minMainline: 60, minPersistence: 62,
    maxCrowding: 11, maxBreakoutPenalty: 9, maxPos: 0.18, riskPerTrade: 0.008,
    maxHoldingDays: 5, allowNewPositions: true, targetFloor1: 0.05, targetFloor2: 0.09,
    targetMultiple1: 1.35, targetMultiple2: 2.0,
    weights: { T: 0.22, F: 0.22, M: 0.16, E: 0.10, P: 0.20, N: 0.10 },
    stage1Weights: { flow: 0.25, liq: 0.12, rs60: 0.16, momentum: 0.14, turnover: 0.08, sector: 0.14, rank: 0.11 }
  }),
  EXTREME_RISK: Object.freeze({
    label: '极端风险', legacyLabel: '弱势', minScore: 90, minMainline: 70, minPersistence: 72,
    maxCrowding: 6, maxBreakoutPenalty: 5, maxPos: 0, riskPerTrade: 0,
    maxHoldingDays: 2, allowNewPositions: false, targetFloor1: 0.04, targetFloor2: 0.07,
    targetMultiple1: 1.0, targetMultiple2: 1.5,
    weights: { T: 0.15, F: 0.20, M: 0.15, E: 0.15, P: 0.20, N: 0.15 },
    stage1Weights: { flow: 0.20, liq: 0.16, rs60: 0.12, momentum: 0.05, turnover: 0.15, sector: 0.15, rank: 0.17 }
  })
});

function validPctRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter(x => x && finite(x.pct));
}

function normalizeIndex(x) {
  const dailyReturn = finite(x?.dailyReturn) ? x.dailyReturn : finite(x?.pct) ? x.pct / 100 : null;
  return {
    name: String(x?.name || x?.code || 'index'),
    dailyReturn,
    ret5: finite(x?.ret5) ? x.ret5 : null,
    ret20: finite(x?.ret20) ? x.ret20 : null,
    drawdown20: finite(x?.drawdown20) ? x.drawdown20 : null,
    atrPct: finite(x?.atrPct) ? x.atrPct : null
  };
}

function confidenceScore({ indices, hasTrend, breadthN, fullBreadth, stateAgreement }) {
  let c = 24 + Math.min(4, indices.length) * 5 + (hasTrend ? 15 : 0) + stateAgreement * 8;
  c += fullBreadth ? (breadthN >= 800 ? 22 : 16) : breadthN >= 200 ? 6 : 0;
  if (indices.length < 3) c -= 10;
  return Math.round(clamp(c, 20, fullBreadth ? 88 : hasTrend ? 65 : 52));
}

export function classifyMarketRegime({ indices = [], candidates = [], fullUniverse = null, now = new Date().toISOString() } = {}) {
  const ix = (Array.isArray(indices) ? indices : []).map(normalizeIndex).filter(x => finite(x.dailyReturn));
  const broadRows = validPctRows(fullUniverse);
  const candidateRows = validPctRows(candidates);
  const useFull = broadRows.length >= 200;
  const breadthRows = useFull ? broadRows : candidateRows;
  const breadthSource = useFull ? 'independent-main-board-universe' : 'ranked-candidate-proxy';
  const n = breadthRows.length;
  const dailyReturns = ix.map(x => x.dailyReturn);
  const trend5s = ix.map(x => x.ret5).filter(finite);
  const trend20s = ix.map(x => x.ret20).filter(finite);
  const drawdowns = ix.map(x => x.drawdown20).filter(finite);
  const atrs = ix.map(x => x.atrPct).filter(finite);
  const dailyMedian = median(dailyReturns) ?? 0;
  const dailyMean = mean(dailyReturns) ?? 0;
  const indexUpRatio = dailyReturns.length ? dailyReturns.filter(x => x > 0).length / dailyReturns.length : 0.5;
  const trend5 = median(trend5s);
  const trend20 = median(trend20s);
  const drawdown20 = median(drawdowns);
  const volatility = median(atrs);
  const breadthUp = n ? breadthRows.filter(x => x.pct > 0).length / n : 0.5;
  const breadthDown = n ? breadthRows.filter(x => x.pct <= -2).length / n : 0;
  const breadthStrong = n ? breadthRows.filter(x => x.pct >= 3).length / n : 0;
  const deepLossRatio = n ? breadthRows.filter(x => x.pct <= -7).length / n : 0;
  const hasTrend = trend5s.length >= 2 && trend20s.length >= 2;
  const enoughIndices = ix.length >= 2;

  let state = 'ROTATION';
  const evidence = [];
  if (n < 80) evidence.push('市场广度样本不足，状态置信度受限');
  if (!hasTrend) evidence.push('指数历史趋势数据不足，主要依据当日指数与广度代理');
  if (!useFull) evidence.push('广度来自多因子候选池代理，不代表全A股上涨/下跌比例');
  if (!enoughIndices) evidence.push('有效指数不足两个，分类可信度较低');

  const extreme = enoughIndices && (
    (dailyMedian <= -0.022 && breadthDown >= 0.55) ||
    (breadthDown >= 0.72 && dailyMedian <= -0.008) ||
    (deepLossRatio >= 0.05 && breadthUp <= 0.25) ||
    (finite(volatility) && volatility >= 0.065 && breadthDown >= 0.55)
  );
  const bear = (finite(trend20) && trend20 <= -0.055 && breadthUp < 0.45) ||
    (finite(drawdown20) && drawdown20 <= -0.12 && breadthUp < 0.40) ||
    (dailyMedian <= -0.012 && breadthUp < 0.35) ||
    (!hasTrend && dailyMedian <= -0.008 && breadthUp < 0.34);
  const bull = (finite(trend20) && trend20 >= 0.045 && breadthUp >= 0.57 && breadthStrong >= 0.12 && dailyMedian > -0.008) ||
    (finite(trend5) && trend5 >= 0.025 && breadthUp >= 0.65 && breadthStrong >= 0.16 && (trend20 ?? 0) >= 0);
  const recovery = (finite(trend20) && finite(trend5) && trend20 < 0.025 && trend5 >= 0.018 && breadthUp >= 0.55 && dailyMedian >= -0.005) ||
    (finite(trend20) && finite(trend5) && trend20 <= -0.035 && trend5 >= 0.02 && breadthUp >= 0.58) ||
    (!hasTrend && dailyMedian >= 0.005 && breadthUp >= 0.58 && indexUpRatio >= 0.75);

  if (extreme) state = 'EXTREME_RISK';
  else if (bear) state = 'BEAR_TREND';
  else if (bull) state = 'BULL_TREND';
  else if (recovery) state = 'RECOVERY';

  if (state === 'EXTREME_RISK') evidence.push('下跌广度、指数跌幅或波动指标触发极端风险条件');
  if (state === 'BEAR_TREND') evidence.push('指数中期趋势/回撤与市场广度共同偏弱');
  if (state === 'BULL_TREND') evidence.push('中期指数趋势与上涨广度共同偏强');
  if (state === 'RECOVERY') evidence.push('短期广度和指数动能改善，但中期趋势尚未充分确认');
  if (state === 'ROTATION') evidence.push('强势或弱势条件未同时满足，按震荡轮动处理');

  const policy = REGIME_POLICIES[state];
  const agreement = [extreme, bear, bull, recovery].filter(Boolean).length > 0 ? 1 : 0;
  const confidence = confidenceScore({ indices: ix, hasTrend, breadthN: n, fullBreadth: useFull, stateAgreement: agreement });
  const proxyFactor = useFull ? 1 : 0.75;
  const dataQuality = useFull ? 'BROAD_UNIVERSE' : n >= 80 ? 'CANDIDATE_PROXY' : 'LOW_COVERAGE';
  return {
    ...policy,
    state,
    confidence,
    dataQuality,
    breadthSource,
    asOf: now,
    basis: `${ix.length}个指数${hasTrend ? '历史趋势' : '当日涨跌'} + ${useFull ? '独立主板广度' : '候选池广度代理'}`,
    features: {
      indexCount: ix.length, indexDailyMedian: dailyMedian, indexDailyMean: dailyMean,
      indexUpRatio, trend5, trend20, drawdown20, volatility,
      breadthN: n, breadthUp, breadthDown, breadthStrong, deepLossRatio
    },
    evidence,
    maxPos: policy.maxPos * proxyFactor,
    riskPerTrade: policy.riskPerTrade * proxyFactor,
    allowNewPositions: policy.allowNewPositions && !(state === 'EXTREME_RISK'),
    weights: { ...policy.weights },
    stage1Weights: { ...policy.stage1Weights }
  };
}

export function adaptiveScore(parts, regime) {
  const w = regime?.weights || REGIME_POLICIES.ROTATION.weights;
  const base = (w.T * (parts.T || 0)) + (w.F * (parts.F || 0)) + (w.M * (parts.M || 0)) +
    (w.E * (parts.E || 0)) + (w.P * (parts.P || 0)) + (w.N * (parts.N ?? 50));
  return clamp(base - (parts.C || 0) - (parts.X || 0) - (parts.Y || 0), 0, 100);
}

export function sizePosition({ price, atrPct, score, capital, availableCash = capital, alreadyHeldValue = 0, globalRemaining = capital } = {}, regime) {
  if (!(capital > 0) || !(availableCash >= 0) || !(price > 0)) return { pass: false, reason: 'invalid-input' };
  if (!regime?.allowNewPositions || !(regime?.maxPos > 0) || !(regime?.riskPerTrade > 0)) return { pass: false, reason: 'market-risk-lock' };
  let targetPos = regime.maxPos;
  if (finite(score) && score < regime.minScore + 5) targetPos *= 0.75;
  const stopPct = clamp((finite(atrPct) ? atrPct : 0.045) * 1.4, 0.045, 0.07);
  let risk = regime.riskPerTrade;
  if (finite(score) && score < 80) risk = Math.min(risk, 0.010);
  const feeReserve = 10;
  const limit = Math.min(
    Math.max(0, capital * targetPos - alreadyHeldValue),
    capital * risk / stopPct,
    Math.max(0, availableCash - feeReserve),
    Math.max(0, globalRemaining)
  );
  const shares = Math.floor(limit / price / 100) * 100;
  const notional = shares * price;
  return {
    pass: shares >= 100,
    reason: shares >= 100 ? 'sizing-feasible' : 'cash-lot-position-or-risk',
    shares, notional, positionPct: notional / capital, targetPos, stopPct,
    stop: price * (1 - stopPct), riskPct: notional * stopPct / capital,
    requiredOneLot: 100 * price
  };
}
