'use strict';

// V13 research-only score for finding 1–5 trading-day limit-up precursors.
// Discovery coverage is deliberately separate from execution eligibility.

const DEFAULT_ALLOWED_BOARDS = ['SH_MAIN', 'SZ_MAIN'];

function clamp(value, min = 0, max = 100) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
function finite(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}
function num(value, fallback = NaN) {
  return finite(value) ? Number(value) : fallback;
}
function mean(values) {
  const xs = values.filter(Number.isFinite);
  return xs.length ? xs.reduce((sum, value) => sum + value, 0) / xs.length : NaN;
}
function stddev(values) {
  const xs = values.filter(Number.isFinite);
  if (xs.length < 2) return NaN;
  const avg = mean(xs);
  return Math.sqrt(mean(xs.map(value => (value - avg) ** 2)));
}
function ramp(value, low, high) {
  if (!Number.isFinite(value) || high <= low) return 50;
  return clamp(((value - low) / (high - low)) * 100);
}
function bandScore(value, idealLow, idealHigh, outerLow, outerHigh) {
  if (!Number.isFinite(value)) return 50;
  if (value >= idealLow && value <= idealHigh) return 100;
  if (value < idealLow) return ramp(value, outerLow, idealLow);
  return 100 - ramp(value, idealHigh, outerHigh);
}
function boardForCode(code) {
  const c = String(code || '').trim();
  if (/^688|^689/.test(c)) return 'STAR';
  if (/^300|^301/.test(c)) return 'CHINEXT';
  if (/^[48]/.test(c) || /^92/.test(c)) return 'BSE';
  if (/^60/.test(c)) return 'SH_MAIN';
  if (/^00|^001|^002|^003/.test(c)) return 'SZ_MAIN';
  return 'UNKNOWN';
}
function limitThresholdPct(code) {
  const board = boardForCode(code);
  if (board === 'CHINEXT' || board === 'STAR') return 19.0;
  if (board === 'BSE') return 28.5;
  return 9.3;
}
function cleanDatedRows(rows, asOf, kind) {
  const cutoff = asOf ? String(asOf).slice(0, 10) : '';
  const seen = new Map();
  for (const raw of Array.isArray(rows) ? rows : []) {
    const date = String(raw?.date || '').slice(0, 10);
    if (cutoff && (!date || date > cutoff)) continue;
    const row = { ...raw, date };
    if (kind === 'bar') {
      row.open = num(raw.open, num(raw.close));
      row.high = num(raw.high, Math.max(row.open, num(raw.close)));
      row.low = num(raw.low, Math.min(row.open, num(raw.close)));
      row.close = num(raw.close);
      row.volume = num(raw.volume, num(raw.vol));
      row.amount = num(raw.amount);
      row.turnoverRate = num(raw.turnoverRate, num(raw.turn));
      if (!(row.close > 0) || !(row.high > 0) || !(row.low > 0) || row.high < row.low) continue;
    } else {
      row.mainNet = num(raw.mainNet, num(raw.main, 0));
      row.amount = num(raw.amount);
      row.mainPct = num(raw.mainPct, num(raw.pct));
    }
    seen.set(date || ('undated-' + seen.size), row);
  }
  return [...seen.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}
function returns(bars, n) {
  if (bars.length <= n) return NaN;
  const previous = bars[bars.length - 1 - n]?.close;
  const latest = bars[bars.length - 1]?.close;
  return previous > 0 ? (latest / previous - 1) * 100 : NaN;
}
function averageClose(bars) {
  return mean(bars.map(bar => bar.close));
}
function sum(values) {
  return values.filter(Number.isFinite).reduce((total, value) => total + value, 0);
}

function deriveFeatures(candidate, options = {}) {
  const asOf = options.asOf || candidate.asOf || '';
  const bars = cleanDatedRows(candidate.bars, asOf, 'bar');
  const flows = cleanDatedRows(candidate.flows, asOf, 'flow');
  if (bars.length < 25) return null;

  const latest = bars[bars.length - 1];
  const previous = bars[bars.length - 2];
  const close = latest.close;
  const ma5 = averageClose(bars.slice(-5));
  const ma10 = averageClose(bars.slice(-10));
  const ma20 = averageClose(bars.slice(-20));
  const prevMa5 = averageClose(bars.slice(-6, -1));
  const prevMa10 = averageClose(bars.slice(-11, -1));
  const previous20 = bars.slice(-21, -1);
  const previousHigh20 = Math.max(...previous20.map(bar => bar.high));
  const previousLow20 = Math.min(...previous20.map(bar => bar.low));
  const priorVol5 = mean(bars.slice(-6, -1).map(bar => bar.volume));
  const priorVol20 = mean(bars.slice(-21, -1).map(bar => bar.volume));
  const volumeExpansion = latest.volume > 0 && priorVol20 > 0 ? latest.volume / priorVol20 : NaN;
  const priorVolumeCompression = priorVol20 > 0 && Number.isFinite(priorVol5) ? priorVol5 / priorVol20 : NaN;
  const closeLocation = latest.high > latest.low ? (close - latest.low) / (latest.high - latest.low) : 0.5;
  const gapPct = previous?.close > 0 ? (latest.open / previous.close - 1) * 100 : NaN;
  const trailing21 = bars.slice(-21);
  const dailyReturns = trailing21.slice(1).map((bar, i) => {
    const prior = trailing21[i]?.close;
    return prior > 0 ? (bar.close / prior - 1) * 100 : NaN;
  });
  const atrProxyPct = stddev(dailyReturns.slice(-14));
  const flowLast5 = flows.slice(-5);
  const flowLast3 = flows.slice(-3);
  const flowPrev3 = flows.slice(-6, -3);
  const barAmounts5 = bars.slice(-5).map(bar => bar.amount).filter(value => value > 0);
  const flowAmounts5 = flowLast5.map(flow => flow.amount).filter(value => value > 0);
  const amountDenominator = flowAmounts5.length ? sum(flowAmounts5) : sum(barAmounts5);
  const mainNet5 = sum(flowLast5.map(flow => flow.mainNet));
  const mainNet3 = sum(flowLast3.map(flow => flow.mainNet));
  const previousMainNet3 = sum(flowPrev3.map(flow => flow.mainNet));
  const flowPositiveShare = flowLast5.length ? flowLast5.filter(flow => flow.mainNet > 0).length / flowLast5.length : NaN;
  const mainFlowRatioPct = amountDenominator > 0 ? mainNet5 / amountDenominator * 100 : NaN;
  const mainPctLatest = flowLast5.length ? flowLast5[flowLast5.length - 1].mainPct : NaN;
  const sector = candidate.sector || {};
  const sectorFieldsPresent = ['return3Pct', 'return5Pct', 'upRatio', 'limitUpCount', 'leaderScore', 'catalystScore', 'themeHeat']
    .filter(key => finite(sector[key])).length;
  const amount = num(latest.amount, num(candidate.amount));
  const turnoverRate = num(latest.turnoverRate, num(candidate.turnoverRate));
  const currentPct = previous?.close > 0 ? (close / previous.close - 1) * 100 : NaN;
  const priorBars = bars.slice(0, -1);
  const priorReturns = priorBars.slice(1).map((bar, i) => {
    const prior = priorBars[i]?.close;
    return prior > 0 ? (bar.close / prior - 1) * 100 : NaN;
  });
  const limitThreshold = limitThresholdPct(candidate.code);
  const recentLimitUp5Count = priorReturns.slice(-5).filter(value => value >= limitThreshold).length;
  const recentLimitUp10Count = priorReturns.slice(-10).filter(value => value >= limitThreshold).length;
  const recentStrongUp10Count = priorReturns.slice(-10).filter(value => value >= limitThreshold * 0.75).length;

  return {
    bars, flows, asOf: latest.date || asOf || null, price: close, currentPct,
    r1Pct: returns(bars, 1), r3Pct: returns(bars, 3), r5Pct: returns(bars, 5),
    r10Pct: returns(bars, 10), r20Pct: returns(bars, 20),
    ma5, ma10, ma20, prevMa5, prevMa10,
    ma5SlopePct: prevMa5 > 0 ? (ma5 / prevMa5 - 1) * 100 : NaN,
    ma10SlopePct: prevMa10 > 0 ? (ma10 / prevMa10 - 1) * 100 : NaN,
    distHigh20Pct: previousHigh20 > 0 ? (close / previousHigh20 - 1) * 100 : NaN,
    distLow20Pct: previousLow20 > 0 ? (close / previousLow20 - 1) * 100 : NaN,
    volumeExpansion, priorVolumeCompression, closeLocation: clamp(closeLocation, 0, 1),
    gapPct, atrProxyPct, amount, turnoverRate, mainNet5, mainNet3, previousMainNet3,
    flowPositiveShare, mainFlowRatioPct, mainPctLatest, flowCount: flows.length,
    recentLimitUp5Count, recentLimitUp10Count, recentStrongUp10Count,
    sectorFieldsPresent, sector
  };
}

function trendScore(f) {
  let score = 15;
  if (f.price > f.ma5) score += 12;
  if (f.ma5 > f.ma10) score += 17;
  if (f.ma10 > f.ma20) score += 13;
  if (f.price > f.ma20) score += 10;
  if (f.ma5SlopePct > 0.15) score += 12;
  else if (f.ma5SlopePct > 0) score += 6;
  if (f.ma10SlopePct > 0.05) score += 8;
  else if (f.ma10SlopePct > 0) score += 4;
  if (f.r3Pct > 0) score += 7;
  if (f.r5Pct > 0) score += 6;
  return clamp(score);
}
function volumePriceScore(f) {
  const expansion = bandScore(f.volumeExpansion, 1.25, 3.0, 0.45, 5.5);
  const compression = bandScore(f.priorVolumeCompression, 0.45, 0.90, 0.15, 1.65);
  const breakout = ramp(f.distHigh20Pct, -15, 1.5);
  return clamp(0.34 * expansion + 0.22 * f.closeLocation * 100 + 0.26 * breakout + 0.18 * compression);
}
function flowScore(f) {
  if (f.flowCount === 0) return 45;
  const positive = Number.isFinite(f.flowPositiveShare) ? f.flowPositiveShare * 100 : 50;
  const ratio = ramp(f.mainFlowRatioPct, -1.5, 4.5);
  const acceleration = f.mainNet3 > f.previousMainNet3 ? 82 : f.mainNet3 > 0 ? 62 : 25;
  const persistence = f.mainNet5 > 0 ? 78 : 24;
  const latest = f.mainPctLatest > 0 ? 65 : f.mainPctLatest < 0 ? 35 : 50;
  return clamp(0.28 * positive + 0.22 * ratio + 0.20 * acceleration + 0.18 * persistence + 0.12 * latest);
}
function sectorScore(f) {
  const s = f.sector || {};
  const parts = [];
  if (finite(s.return3Pct)) parts.push([ramp(Number(s.return3Pct), -3, 5), 0.22]);
  if (finite(s.return5Pct)) parts.push([ramp(Number(s.return5Pct), -5, 8), 0.22]);
  if (finite(s.upRatio)) parts.push([ramp(Number(s.upRatio), 0.2, 0.8), 0.18]);
  if (finite(s.limitUpCount)) parts.push([ramp(Math.log1p(Math.max(0, Number(s.limitUpCount))), 0, Math.log1p(12)), 0.12]);
  if (finite(s.leaderScore)) parts.push([clamp(Number(s.leaderScore)), 0.14]);
  if (finite(s.catalystScore)) parts.push([clamp(Number(s.catalystScore)), 0.08]);
  if (finite(s.themeHeat)) parts.push([clamp(Number(s.themeHeat)), 0.04]);
  if (!parts.length) return 45;
  const weight = sum(parts.map(part => part[1]));
  return clamp(parts.reduce((total, part) => total + part[0] * part[1], 0) / weight);
}
function momentumScore(f) {
  return clamp(0.45 * ramp(f.r3Pct, -5, 8) + 0.35 * ramp(f.r5Pct, -8, 18) + 0.20 * ramp(f.r10Pct, -12, 32));
}
function r5MomentumScore(f) {
  return clamp(ramp(f.r5Pct, -5, 15));
}
function momentumHybridScore(f) {
  // Experimental short-horizon variant: keep five-session momentum dominant,
  // then use volume/price, flow and sector as confirmation rather than replacement.
  return clamp(
    0.45 * r5MomentumScore(f)
    + 0.20 * momentumScore(f)
    + 0.15 * flowScore(f)
    + 0.10 * volumePriceScore(f)
    + 0.05 * sectorScore(f)
    + 0.05 * baseScore(f)
  );
}
function baseScore(f) {
  const lowProximity = bandScore(f.distLow20Pct, 5, 24, -2, 55);
  const nearBreakout = bandScore(f.distHigh20Pct, -9, 2, -28, 16);
  return clamp(0.55 * lowProximity + 0.45 * nearBreakout);
}
function earlyTurnScore(f) {
  // Experimental low-base transition lane: reward a rebound from a nearby base,
  // controlled volume expansion and improving participation before a full MA stack turns.
  const lowProximity = bandScore(f.distLow20Pct, 4, 22, -2, 55);
  const nearBreakout = bandScore(f.distHigh20Pct, -12, -1, -35, 6);
  const rebound = ramp(f.r3Pct, -2, 8);
  const volume = bandScore(f.volumeExpansion, 1.2, 2.6, 0.5, 5.5);
  const flow = flowScore(f);
  const sector = sectorScore(f);
  let score = 0.30 * lowProximity + 0.15 * nearBreakout
    + 0.22 * rebound + 0.18 * volume + 0.08 * flow + 0.07 * sector;
  if (f.distLow20Pct > 40) score -= 15;
  if (f.r10Pct > 30) score -= 12;
  else if (f.r10Pct > 20) score -= 6;
  if (f.currentPct > 7.5) score -= 8;
  if (f.currentPct < -3) score -= 8;
  if (f.volumeExpansion < 1.1) score -= 8;
  return clamp(score);
}
function emotionRepairScore(f) {
  // Separate high-risk observation lane: recent limit-up history followed by a
  // sharp, high-attention selloff or an early recovery. This is not a buy signal.
  const priorLimit = ramp(f.recentLimitUp10Count, 0, 2);
  const priorStrength = ramp(f.recentStrongUp10Count, 0, 3);
  const flush = f.currentPct <= -12 ? 100
    : f.currentPct <= -7 ? 85
    : f.currentPct <= -3 ? 65
    : f.currentPct < 0 ? 45 : 25;
  const volume = bandScore(f.volumeExpansion, 1.2, 3.0, 0.5, 5.5);
  const sector = sectorScore(f);
  const recovery = f.currentPct > 0 && f.r3Pct > 0 && f.closeLocation > 0.55 ? 80 : 35;
  let score = 0.27 * priorLimit + 0.18 * priorStrength + 0.22 * flush
    + 0.13 * volume + 0.10 * sector + 0.10 * recovery;
  if (f.recentLimitUp10Count === 0) score = Math.min(score, 55);
  if (f.recentLimitUp10Count > 0 && f.currentPct <= -7 && f.volumeExpansion >= 1.0) score = Math.max(score, 75);
  if (f.recentLimitUp10Count > 0 && f.currentPct > 0 && f.r3Pct > 0 && f.closeLocation > 0.55) score = Math.max(score, 68);
  return clamp(score);
}
function oversoldReversalScore(f) {
  // Research-only contrarian path: a meaningful drawdown near the recent range low,
  // short-term selling pressure, and signs of stabilization. This is not a buy signal.
  const drawdownFromHigh = bandScore(-f.distHigh20Pct, 5, 24, 0, 42);
  const nearRangeLow = bandScore(f.distLow20Pct, 2, 14, -2, 32);
  const selloff3 = bandScore(f.r3Pct, -12, -1.5, -28, 7);
  const selloff5 = bandScore(f.r5Pct, -20, -3, -42, 10);
  const selloff = 0.55 * selloff3 + 0.45 * selloff5;
  const stabilization = 0.55 * clamp(f.closeLocation * 100)
    + 0.45 * bandScore(f.currentPct, -2.5, 4.5, -12, 10);
  const volumeExhaustion = bandScore(f.volumeExpansion, 0.45, 1.45, 0.1, 4.0);
  const flowNotWorsening = f.mainNet3 > f.previousMainNet3 ? 72
    : f.mainNet3 > 0 ? 62
    : f.flowCount >= 3 ? 32 : 45;
  const score = 0.22 * drawdownFromHigh + 0.22 * nearRangeLow
    + 0.22 * selloff + 0.18 * stabilization
    + 0.10 * volumeExhaustion + 0.06 * flowNotWorsening;
  // Avoid labeling an ordinary downtrend as a reversal setup without both a pullback
  // and proximity to the range low. The remaining score is still visible for research.
  if (f.distLow20Pct > 22 || f.distHigh20Pct > -2) return Math.min(score, 58);
  return clamp(score);
}
function computeRisk(f, candidate) {
  const flags = [];
  let penalty = 0;
  if (f.currentPct > 7.5) {
    penalty += Math.min(12, (f.currentPct - 7.5) * 2);
    flags.push('当日涨幅偏高，追涨风险上升');
  }
  if (f.currentPct > 9.2) {
    penalty += 5;
    flags.push('接近当日涨停区，次日接力不确定性较高');
  }
  if (f.r5Pct > 18) {
    penalty += Math.min(8, (f.r5Pct - 18) * 0.30);
    flags.push('近5日涨幅过快');
  }
  if (f.r10Pct > 35) {
    penalty += Math.min(7, (f.r10Pct - 35) * 0.18);
    flags.push('近10日涨幅过热');
  }
  if (f.gapPct > 6) {
    penalty += 4;
    flags.push('高开幅度较大');
  }
  if (f.volumeExpansion > 5) {
    penalty += 4;
    flags.push('成交量异常放大，需警惕分歧');
  }
  if (f.atrProxyPct > 8) {
    penalty += 4;
    flags.push('近期波动率较高');
  }
  if (Number.isFinite(f.amount) && f.amount < 30000000) {
    penalty += 10;
    flags.push('成交额偏低，流动性风险较高');
  } else if (Number.isFinite(f.amount) && f.amount < 80000000) {
    penalty += 5;
    flags.push('成交额一般');
  }
  if (Number.isFinite(f.turnoverRate) && f.turnoverRate > 25) {
    penalty += 5;
    flags.push('换手率过高');
  } else if (Number.isFinite(f.turnoverRate) && f.turnoverRate < 0.5) {
    penalty += 4;
    flags.push('换手率偏低，资金参与度需确认');
  }
  if (candidate?.isST || /^(\*?ST|退)/i.test(String(candidate?.name || ''))) {
    flags.push('ST或退市风险标的');
    return { penalty: 100, flags, excluded: true, reason: 'ST_OR_DELISTING' };
  }
  return { penalty: clamp(penalty, 0, 30), flags, excluded: false, reason: null };
}
function classifySetup(f, repairScore, oversoldScore, coreScore) {
  if (repairScore >= 65 && repairScore > coreScore && repairScore >= oversoldScore) return '情绪反核观察';
  if (oversoldScore >= 65 && oversoldScore > coreScore && oversoldScore > repairScore) return '超跌修复观察';
  if (f.distHigh20Pct >= 0 && f.volumeExpansion >= 1.2) return '放量突破';
  if (f.price > f.ma5 && f.ma5 > f.prevMa5 && f.r3Pct > 0 && f.distLow20Pct <= 28 && f.currentPct <= 7.5) return '底部转强';
  if (f.priorVolumeCompression < 0.8 && f.distHigh20Pct >= -10) return '平台蓄势';
  if (f.r3Pct > 0 && f.r5Pct > 0) return '短线动量';
  return '观察';
}

function scoreCandidate(candidate, options = {}) {
  const f = deriveFeatures(candidate, options);
  if (!f) return null;
  const board = boardForCode(candidate.code);
  const allowedBoards = Array.isArray(options.allowedBoards) ? options.allowedBoards : DEFAULT_ALLOWED_BOARDS;
  const trend = trendScore(f);
  const volumePrice = volumePriceScore(f);
  const flow = flowScore(f);
  const sector = sectorScore(f);
  const momentum = momentumScore(f);
  const base = baseScore(f);
  const repair = emotionRepairScore(f);
  const oversold = oversoldReversalScore(f);
  const earlyTurn = earlyTurnScore(f);
  const momentumHybrid = momentumHybridScore(f);
  const risk = computeRisk(f, candidate);
  const coreGrossScore = 0.22 * trend + 0.20 * volumePrice + 0.20 * flow + 0.18 * sector + 0.12 * momentum + 0.08 * base;
  const modelVariant = options.modelVariant || 'v13-current';
  const grossScore = modelVariant === 'v13-core-only'
    ? coreGrossScore
    : modelVariant === 'v13-early-turn'
      ? Math.max(coreGrossScore, earlyTurn)
      : modelVariant === 'v13-momentum-hybrid'
        ? momentumHybrid
        : Math.max(coreGrossScore, repair, oversold);
  const score = clamp(grossScore - risk.penalty);
  const scorePath = modelVariant === 'v13-current'
    ? grossScore === oversold && oversold > coreGrossScore && oversold > repair
      ? 'oversold-reversal'
      : repair > coreGrossScore && repair >= oversold ? 'emotion-repair' : 'trend-transition'
    : modelVariant === 'v13-early-turn' && earlyTurn > coreGrossScore
      ? 'early-turn'
      : modelVariant === 'v13-momentum-hybrid' ? 'momentum-hybrid' : 'trend-transition';
  const confidence = clamp(30
    + (f.bars.length >= 60 ? 20 : f.bars.length >= 40 ? 12 : 5)
    + (f.flowCount >= 5 ? 20 : f.flowCount >= 3 ? 12 : 0)
    + Math.min(18, f.sectorFieldsPresent * 3)
    + (Number.isFinite(f.amount) ? 6 : 0)
    + (Number.isFinite(f.turnoverRate) ? 6 : 0));
  const discoveryEligible = !risk.excluded;
  const executionEligible = discoveryEligible && allowedBoards.includes(board) && candidate.executionEligible !== false;
  const tradeabilityReason = !discoveryEligible ? risk.reason : executionEligible ? null : 'BOARD_OR_ACCOUNT_PERMISSION:' + board;
  const setup = scorePath === 'early-turn'
    ? '底部转强候选'
    : modelVariant === 'v13-current'
      ? classifySetup(f, repair, oversold, coreGrossScore)
      : classifySetup(f, -Infinity, -Infinity, coreGrossScore);
  const riskFlags = [...risk.flags];
  if (f.flowCount < 3) riskFlags.push('资金流历史不足，资金评分置信度较低');
  if (f.sectorFieldsPresent < 2) riskFlags.push('题材/行业数据不足，板块评分为弱证据');
  if (f.bars.length < 40) riskFlags.push('K线样本少于40根');
  return {
    code: String(candidate.code || ''), name: String(candidate.name || candidate.code || ''),
    board, asOf: f.asOf, modelVariant,
    price: Number(f.price.toFixed(4)), currentPct: Number(f.currentPct.toFixed(2)),
    score: Number(score.toFixed(1)), grossScore: Number(grossScore.toFixed(1)),
    riskPenalty: Number(risk.penalty.toFixed(1)), confidence: Number(confidence.toFixed(1)),
    setup, scorePath,
    horizonTradingDays: [1, 5], discoveryEligible, executionEligible,
    tradeabilityReason,
    components: {
      trend: Number(trend.toFixed(1)), volumePrice: Number(volumePrice.toFixed(1)),
      flow: Number(flow.toFixed(1)), sector: Number(sector.toFixed(1)),
      momentum: Number(momentum.toFixed(1)), base: Number(base.toFixed(1)),
      coreComposite: Number(coreGrossScore.toFixed(1)), earlyTurn: Number(earlyTurn.toFixed(1)),
      momentumHybrid: Number(momentumHybrid.toFixed(1)),
      emotionRepair: Number(repair.toFixed(1)), oversoldReversal: Number(oversold.toFixed(1))
    },
    riskFlags,
    features: {
      r3Pct: Number(f.r3Pct.toFixed(2)), r5Pct: Number(f.r5Pct.toFixed(2)),
      r10Pct: Number(f.r10Pct.toFixed(2)), distHigh20Pct: Number(f.distHigh20Pct.toFixed(2)),
      distLow20Pct: Number(f.distLow20Pct.toFixed(2)),
      closeLocation: Number(f.closeLocation.toFixed(2)),
      recentLimitUp5Count: f.recentLimitUp5Count,
      recentLimitUp10Count: f.recentLimitUp10Count,
      recentStrongUp10Count: f.recentStrongUp10Count,
      volumeExpansion: Number.isFinite(f.volumeExpansion) ? Number(f.volumeExpansion.toFixed(2)) : null,
      priorVolumeCompression: Number.isFinite(f.priorVolumeCompression) ? Number(f.priorVolumeCompression.toFixed(2)) : null,
      mainNet5: Number(f.mainNet5.toFixed(0)),
      mainFlowRatioPct: Number.isFinite(f.mainFlowRatioPct) ? Number(f.mainFlowRatioPct.toFixed(2)) : null,
      turnoverRate: Number.isFinite(f.turnoverRate) ? Number(f.turnoverRate.toFixed(2)) : null,
      amount: Number.isFinite(f.amount) ? f.amount : null
    }
  };
}
function percentileRank(rows, getter) {
  const values = rows.map((row, index) => ({ index, value: getter(row) }))
    .filter(item => Number.isFinite(item.value))
    .sort((a, b) => a.value - b.value);
  const out = new Array(rows.length).fill(50);
  if (values.length <= 1) return out;
  let start = 0;
  while (start < values.length) {
    let end = start;
    while (end + 1 < values.length && values[end + 1].value === values[start].value) end++;
    const percentile = ((start + end) / 2) / (values.length - 1) * 100;
    for (let i = start; i <= end; i++) out[values[i].index] = percentile;
    start = end + 1;
  }
  return out;
}

function applyCrossSectionalRankEnsemble(rows) {
  const features = {
    r5: percentileRank(rows, row => row.features?.r5Pct),
    r3: percentileRank(rows, row => row.features?.r3Pct),
    r10: percentileRank(rows, row => row.features?.r10Pct),
    trend: percentileRank(rows, row => row.components?.trend),
    volumePrice: percentileRank(rows, row => row.components?.volumePrice),
    flow: percentileRank(rows, row => row.components?.flow),
    sector: percentileRank(rows, row => row.components?.sector)
  };
  return rows.map((row, index) => {
    const grossScore = 0.50 * features.r5[index]
      + 0.15 * features.r3[index]
      + 0.10 * features.r10[index]
      + 0.10 * features.trend[index]
      + 0.06 * features.volumePrice[index]
      + 0.06 * features.flow[index]
      + 0.03 * features.sector[index];
    const score = clamp(grossScore - row.riskPenalty);
    return {
      ...row,
      modelVariant: 'v13-rank-ensemble',
      score: Number(score.toFixed(2)),
      grossScore: Number(grossScore.toFixed(2)),
      scorePath: 'momentum-confirmed-rank',
      setup: row.features?.r5Pct > 0 && row.components?.trend >= 55
        ? '动量确认'
        : row.components?.volumePrice >= 65 && row.features?.r3Pct > 0
          ? '放量转强观察' : '综合观察',
      components: {
        ...row.components,
        crossSectionalMomentum: Number(features.r5[index].toFixed(1)),
        crossSectionalTrend: Number(features.trend[index].toFixed(1)),
        crossSectionalVolumePrice: Number(features.volumePrice[index].toFixed(1)),
        crossSectionalFlow: Number(features.flow[index].toFixed(1)),
        crossSectionalSector: Number(features.sector[index].toFixed(1))
      }
    };
  });
}

function technicalSetup(row) {
  if (row.features?.distHigh20Pct >= 0 && row.features?.volumeExpansion >= 1.2) return '放量突破';
  if (row.features?.r3Pct > 0 && row.features?.r5Pct > 0) return '短线动量';
  if (row.features?.priorVolumeCompression < 0.8 && row.features?.distHigh20Pct >= -10) return '平台蓄势';
  return '观察';
}

function rankScoredCandidates(scoredRows, modelVariant = 'v13-current') {
  const rows = (Array.isArray(scoredRows) ? scoredRows : [])
    .filter(result => result && result.discoveryEligible);
  if (modelVariant === 'v13-rank-ensemble') {
    return applyCrossSectionalRankEnsemble(rows)
      .sort((a, b) => b.score - a.score || b.confidence - a.confidence);
  }
  const ranked = rows.map(row => {
    const core = Number(row.components?.coreComposite ?? row.grossScore);
    const repair = Number(row.components?.emotionRepair ?? 0);
    const oversold = Number(row.components?.oversoldReversal ?? 0);
    const earlyTurn = Number(row.components?.earlyTurn ?? 0);
    const momentumHybrid = Number(row.components?.momentumHybrid ?? 0);
    let grossScore = core;
    let scorePath = 'trend-transition';
    let setup = technicalSetup(row);
    if (modelVariant === 'v13-current') {
      grossScore = Math.max(core, repair, oversold);
      scorePath = oversold > core && oversold > repair
        ? 'oversold-reversal'
        : repair > core && repair >= oversold ? 'emotion-repair' : 'trend-transition';
      setup = row.setup;
    } else if (modelVariant === 'v13-core-only') {
      grossScore = core;
    } else if (modelVariant === 'v13-early-turn') {
      grossScore = Math.max(core, earlyTurn);
      if (earlyTurn > core) {
        scorePath = 'early-turn';
        setup = '底部转强候选';
      }
    } else if (modelVariant === 'v13-momentum-hybrid') {
      grossScore = momentumHybrid;
      scorePath = 'momentum-hybrid';
      setup = row.features?.r5Pct > 0 ? '动量确认' : technicalSetup(row);
    }
    const score = clamp(grossScore - Number(row.riskPenalty || 0));
    return {
      ...row,
      modelVariant,
      score: Number(score.toFixed(1)),
      grossScore: Number(grossScore.toFixed(1)),
      scorePath,
      setup
    };
  });
  return ranked.sort((a, b) => b.score - a.score || b.confidence - a.confidence);
}

function rankCandidates(candidates, options = {}) {
  // All variants share the same raw feature pass. Only their ranking policy differs.
  const baseOptions = { ...options, modelVariant: 'v13-current' };
  const scored = (Array.isArray(candidates) ? candidates : [])
    .map(candidate => scoreCandidate(candidate, baseOptions))
    .filter(result => result && result.discoveryEligible);
  return rankScoredCandidates(scored, options.modelVariant || 'v13-current');
}
export {
  boardForCode, deriveFeatures, scoreCandidate, rankCandidates,
  trendScore, volumePriceScore, flowScore, sectorScore, momentumScore, baseScore,
  r5MomentumScore, momentumHybridScore, earlyTurnScore, emotionRepairScore, oversoldReversalScore, rankScoredCandidates
};
