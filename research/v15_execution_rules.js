const isFiniteNumber = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const num = value => isFiniteNumber(value) ? Number(value) : null;
const clamp = (value, min, max) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
const roundPrice = value => Number.isFinite(value) ? Number(value.toFixed(2)) : null;

function calculateAtrPct(bars, period = 14) {
  const rows = Array.isArray(bars) ? bars.filter(bar =>
    num(bar?.high) !== null && num(bar?.low) !== null && num(bar?.close) !== null
  ) : [];
  const sample = rows.slice(-(period + 1));
  if (sample.length < 3) return null;
  const ranges = [];
  for (let index = 1; index < sample.length; index += 1) {
    const bar = sample[index];
    const previousClose = num(sample[index - 1].close);
    ranges.push(Math.max(
      num(bar.high) - num(bar.low),
      Math.abs(num(bar.high) - previousClose),
      Math.abs(num(bar.low) - previousClose)
    ));
  }
  const average = ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
  const lastClose = num(sample.at(-1)?.close);
  return lastClose > 0 ? average / lastClose : null;
}

function stopForPeak({entry, initialStop, peakHigh, atrAtEntry}) {
  const peakGain = peakHigh / entry - 1;
  let stop = initialStop;
  let stage = 'initial-atr-stop';
  if (peakGain >= 0.06) {
    stop = Math.max(stop, entry * 1.005);
    stage = 'cost-plus-protection';
  }
  if (peakGain >= 0.10) {
    const trailingDistance = clamp(atrAtEntry * 1.25, 0.04, 0.07);
    stop = Math.max(stop, peakHigh * (1 - trailingDistance));
    stage = 'atr-trailing-protection';
  }
  return {stop, stage};
}

/**
 * Separates candidate strength from actual entry timing.
 * A high score is not permission to chase a vertical candle or a limit-up print.
 * Inputs use pct in percentage points (e.g. 9.97), and returns in decimal form (e.g. 0.12).
 * A BUY-eligible result requires price to be inside the pullback zone and a live-bar
 * stabilization/reclaim confirmation. Otherwise the result is observation-only.
 */
export function evaluateEntryTiming(candidate = {}) {
  const price = num(candidate.price);
  const pct = num(candidate.pct);
  const ma5 = num(candidate.ma5);
  const ma10 = num(candidate.ma10);
  const r5 = num(candidate.r5);
  const r8 = num(candidate.r8);
  const atr = num(candidate.atr) ?? 0.045;
  const flow3 = num(candidate.flow3);
  const flow5 = num(candidate.flow5);
  const code = String(candidate.code ?? '');
  const bars = Array.isArray(candidate.k) ? candidate.k : [];
  const currentBar = bars.at(-1) || null;
  const previousClose = num(bars.length >= 2 ? bars[bars.length - 2]?.close : null);
  const limitPct = /^(300|301|688|689)/.test(code) ? 20 : /^(4|8|92)/.test(code) ? 30 : 10;
  const upperLimit = previousClose !== null ? previousClose * (1 + limitPct / 100) : null;
  const nearLimitUp = (pct !== null && pct >= limitPct * 0.85)
    || (upperLimit !== null && price !== null && price >= upperLimit * 0.985);
  const reasons = [];

  if (price === null || price <= 0) reasons.push('当前价格缺失，不能形成执行计划');
  if (pct !== null && pct >= 6.5) reasons.push('当日涨幅达到6.5%以上，禁止追逐日内急拉');
  if (nearLimitUp) reasons.push('价格已接近涨停区，等待次日换手或回踩确认');
  if (pct !== null && pct <= -3) reasons.push('当日回撤较大，先等待止跌确认');
  if (ma5 !== null && ma5 > 0 && price !== null && price / ma5 - 1 >= 0.045) {
    reasons.push('价格高于5日线4.5%以上，短线乖离过大');
  }
  if (ma10 !== null && ma10 > 0 && price !== null && price / ma10 - 1 >= 0.075) {
    reasons.push('价格高于10日线7.5%以上，盈亏比恶化');
  }
  if (ma10 !== null && ma10 > 0 && price !== null && price / ma10 - 1 <= -0.015) {
    reasons.push('价格低于10日线1.5%以上，趋势尚未修复');
  }
  if (ma5 !== null && ma10 !== null && ma5 < ma10 * 0.995) {
    reasons.push('5日线仍弱于10日线，短期趋势尚未转强');
  }
  if (r5 !== null && r5 >= 0.18) reasons.push('近5个交易日涨幅达到18%以上，等待整理');
  if (r8 !== null && r8 >= 0.25) reasons.push('近8个交易日涨幅达到25%以上，等待整理');
  if (atr >= 0.085) reasons.push('ATR波动率达到8.5%以上，暂不提供新开仓计划');

  let pullbackZone = null;
  const anchor = ma5 !== null && ma5 > 0 ? ma5 : (ma10 !== null && ma10 > 0 ? ma10 : null);
  if (anchor !== null && atr < 0.085) {
    const halfWidth = clamp(atr * 0.40, 0.01, 0.02);
    const low = anchor * (1 - halfWidth);
    const high = anchor * (1 + Math.min(0.006, halfWidth * 0.25));
    pullbackZone = {low: roundPrice(low), high: roundPrice(high), anchor: roundPrice(anchor)};
  } else {
    reasons.push('均线或波动率数据不足，无法确定有效回踩区');
  }

  if (price !== null && pullbackZone) {
    if (price > pullbackZone.high) reasons.push('当前价格仍高于回踩观察区上沿，尚未回踩，禁止按现价追入');
    if (price < pullbackZone.low) reasons.push('当前价格已跌破回踩观察区下沿，等待重新站回，不接下跌');
  }

  const barHigh = num(currentBar?.high);
  const barLow = num(currentBar?.low);
  const barClose = num(currentBar?.close);
  if (barHigh === null || barLow === null || barClose === null || barHigh <= barLow) {
    reasons.push('缺少有效日内高低收数据，不能确认回踩后的止跌形态');
  } else if (pullbackZone) {
    const closeQuality = (barClose - barLow) / (barHigh - barLow);
    if (barLow > pullbackZone.high * 1.01) reasons.push('当前交易日尚未触及回踩观察区');
    if (barLow < pullbackZone.low * 0.98) reasons.push('盘中曾明显跌穿回踩区下沿，需重新确认支撑');
    if (ma5 !== null && barClose < ma5 * 0.995) reasons.push('价格尚未重新站回5日线');
    if (closeQuality < 0.55) reasons.push('K线收盘位置偏弱，尚未确认止跌');
  }
  if (flow3 !== null && flow5 !== null && flow3 < 0 && flow5 < 0) {
    reasons.push('近3日与近5日资金均为净流出，缺少资金确认');
  }

  return {
    pass: reasons.length === 0,
    reason: reasons.length ? 'entry-timing' : 'confirmed-pullback-entry',
    reasons,
    nearLimitUp,
    upperLimit: roundPrice(upperLimit),
    ma5Gap: ma5 !== null && ma5 > 0 && price !== null ? price / ma5 - 1 : null,
    ma10Gap: ma10 !== null && ma10 > 0 && price !== null ? price / ma10 - 1 : null,
    pullbackZone,
    setup: reasons.length === 0 ? 'confirmed-pullback' : 'observation-only'
  };
}

/**
 * Position review uses the ATR known before the entry session, checks subsequent
 * daily lows against the stop that was active at that time, and uses post-entry
 * highs for trailing protection. This can identify a stop breach even if price
 * later rebounds; daily bars cannot prove the exact fill price or intraday order.
 */
export function evaluateHolding({
  price,
  entry,
  entryDate = null,
  days = 1,
  atr = 0.045,
  bars = [],
  score = 50,
  flow3 = 0,
  flow5 = 0,
  ma10 = null,
  ma20 = null,
  newsVeto = false
} = {}) {
  const current = num(price);
  const cost = num(entry);
  const safeDays = Math.max(0, Math.floor(num(days) ?? 1));
  const currentVolatility = clamp(num(atr) ?? 0.045, 0.015, 0.20);
  const finalScore = num(score) ?? 50;
  const f3 = num(flow3) ?? 0;
  const f5 = num(flow5) ?? 0;
  const m10 = num(ma10);
  const m20 = num(ma20);
  const history = Array.isArray(bars) ? bars : [];

  if (current === null || cost === null || current <= 0 || cost <= 0) {
    return {action: 'HOLD', pnl: null, initialStop: null, activeStop: null, peakHigh: null,
      protectionStage: 'unavailable', reasons: ['价格或成本数据缺失，无法给出可靠持仓判断']};
  }

  const pnl = current / cost - 1;
  const entryDateText = String(entryDate ?? '').trim();
  const firstHistoryDate = String(history[0]?.date ?? '');
  const lastHistoryDate = String(history.at(-1)?.date ?? '');
  const dateWithinHistory = !!entryDateText && !!firstHistoryDate && !!lastHistoryDate
    && entryDateText >= firstHistoryDate && entryDateText <= lastHistoryDate;
  const entryIndex = dateWithinHistory
    ? history.findIndex(bar => String(bar?.date ?? '') >= entryDateText)
    : -1;
  const entryDateFound = entryIndex >= 0;
  const atrAtEntryValue = entryDateFound ? calculateAtrPct(history.slice(0, entryIndex)) : null;
  const atrAtEntry = atrAtEntryValue ?? currentVolatility;
  const initialStopPct = clamp(atrAtEntry * 1.4, 0.045, 0.07);
  const initialStop = cost * (1 - initialStopPct);
  const windowSize = Math.max(1, safeDays + 1);
  const postEntryBars = entryDateFound
    ? history.slice(entryIndex + 1)
    : history.slice(-windowSize);

  let peakHigh = cost;
  let minLow = Infinity;
  let activeStop = initialStop;
  let protectionStage = 'initial-atr-stop';
  let stopHit = null;

  for (const bar of postEntryBars) {
    const low = num(bar?.low) ?? num(bar?.close);
    const high = num(bar?.high) ?? num(bar?.close);
    if (low !== null) minLow = Math.min(minLow, low);

    // Apply the stop calculated from information available before this session's low.
    const beforeSession = stopForPeak({entry: cost, initialStop, peakHigh, atrAtEntry});
    if (low !== null && low <= beforeSession.stop) {
      stopHit = {date: String(bar?.date ?? ''), level: roundPrice(beforeSession.stop), low: roundPrice(low)};
      activeStop = beforeSession.stop;
      protectionStage = beforeSession.stage;
      break;
    }

    if (high !== null) peakHigh = Math.max(peakHigh, high);
    const afterSession = stopForPeak({entry: cost, initialStop, peakHigh, atrAtEntry});
    activeStop = afterSession.stop;
    protectionStage = afterSession.stage;
  }

  if (!entryDateFound) {
    // Without the entry date, only estimate the peak from a short recent window;
    // do not claim that a historical stop was or was not triggered.
    for (const bar of postEntryBars) {
      const high = num(bar?.high) ?? num(bar?.close);
      const low = num(bar?.low) ?? num(bar?.close);
      if (high !== null) peakHigh = Math.max(peakHigh, high);
      if (low !== null) minLow = Math.min(minLow, low);
    }
    const protection = stopForPeak({entry: cost, initialStop, peakHigh, atrAtEntry});
    activeStop = protection.stop;
    protectionStage = protection.stage;
  }

  peakHigh = Math.max(peakHigh, current);
  const currentProtection = stopForPeak({entry: cost, initialStop, peakHigh, atrAtEntry});
  if (!stopHit) {
    activeStop = currentProtection.stop;
    protectionStage = currentProtection.stage;
  }
  const peakGain = peakHigh / cost - 1;
  const maxAdverseExcursion = Number.isFinite(minLow) ? minLow / cost - 1 : null;

  const reasons = [];
  let action = 'HOLD';
  if (newsVeto) {
    action = 'EXIT';
    reasons.push('出现立案、退市、停产、处罚等硬风险新闻，退出优先');
  } else if (stopHit) {
    action = 'EXIT';
    reasons.push('入场后' + (stopHit.date || '某交易日') + '最低价曾触及当时有效止损线 ' + stopHit.level
      + '（当日最低 ' + stopHit.low + '）；即使现价反弹，也不能把历史止损触发当作未发生');
  } else if (current <= activeStop) {
    action = 'EXIT';
    reasons.push(protectionStage === 'initial-atr-stop'
      ? '当前价格触及初始ATR止损线，执行风险退出'
      : '当前价格触及盈利保护/ATR移动止损线，保护已有收益');
  } else if ((finalScore < 55 && f5 < 0)
      || (m20 !== null && current < m20 * 0.98 && f5 < 0)) {
    action = 'EXIT';
    reasons.push('综合评分或中期结构明显转弱，且近5日资金净流出');
  } else if (safeDays >= 5 && pnl < 0.015 && finalScore < 68 && f5 <= 0) {
    action = 'EXIT';
    reasons.push('持有达到5日仍无有效收益，评分与资金未改善，触发时间止损');
  } else if ((finalScore < 64 && safeDays >= 2)
      || (f3 < 0 && pnl > 0.02)
      || (m10 !== null && current < m10 * 0.985 && f3 < 0)
      || (safeDays >= 5 && pnl < 0.03)) {
    action = 'REDUCE';
    reasons.push('短线优势下降或持有时间过长，建议降低仓位而非继续加仓');
  } else {
    reasons.push(finalScore >= 78 ? '趋势评分仍强，继续持有并按保护线管理' : '趋势尚未明确破坏，暂持并等待下一次复核');
  }

  if (peakGain >= 0.06) reasons.push('持仓曾达到6%以上浮盈，保护线已抬至成本价上方');
  if (peakGain >= 0.10) reasons.push('持仓曾达到10%以上浮盈，已启用ATR移动保护');
  if (!entryDateText) reasons.push('未填写买入日期，无法回溯入场后每个交易日是否触发过止损');
  else if (!entryDateFound) reasons.push('买入日期早于当前K线历史范围或日期无效，未能回溯历史止损触发');
  else if (atrAtEntryValue === null) reasons.push('买入日前可用K线不足，初始止损距离暂以当前ATR估算');
  if (safeDays >= 5 && pnl < 0.03 && action === 'HOLD') reasons.push('已进入第5日时间复核窗口，下一交易日仍无加速应退出');

  return {
    action,
    pnl,
    peakGain,
    peakHigh: roundPrice(peakHigh),
    maxAdverseExcursion,
    initialStopPct,
    atrAtEntry,
    atrAtEntrySource: atrAtEntryValue === null ? 'current-atr-fallback' : 'pre-entry-bars',
    initialStop: roundPrice(initialStop),
    activeStop: roundPrice(activeStop),
    protectionStage,
    entryDateFound,
    stopHit,
    reasons
  };
}
