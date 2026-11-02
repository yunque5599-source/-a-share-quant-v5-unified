const isFiniteNumber = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const num = value => isFiniteNumber(value) ? Number(value) : null;
const clamp = (value, min, max) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
const roundPrice = value => Number.isFinite(value) ? Number(value.toFixed(2)) : null;

/**
 * Separates candidate strength from entry timing.
 * A high score is not permission to chase a vertical candle or a limit-up print.
 * Inputs use pct in percentage points (e.g. 9.97), and returns in decimal form (e.g. 0.12).
 */
export function evaluateEntryTiming(candidate = {}) {
  const price = num(candidate.price);
  const pct = num(candidate.pct) ?? 0;
  const ma5 = num(candidate.ma5);
  const ma10 = num(candidate.ma10);
  const r5 = num(candidate.r5);
  const r8 = num(candidate.r8);
  const atr = num(candidate.atr) ?? 0.045;
  const code = String(candidate.code ?? '');
  const bars = Array.isArray(candidate.k) ? candidate.k : [];
  const previousClose = num(bars.length >= 2 ? bars[bars.length - 2]?.close : null);
  const limitPct = /^(300|301|688|689)/.test(code) ? 20 : /^(4|8|92)/.test(code) ? 30 : 10;
  const upperLimit = previousClose !== null ? previousClose * (1 + limitPct / 100) : null;
  const nearLimitUp = pct >= limitPct * 0.85
    || (upperLimit !== null && price !== null && price >= upperLimit * 0.985);
  const reasons = [];

  if (price === null || price <= 0) reasons.push('当前价格缺失，不能形成执行计划');
  if (pct >= 6.5) reasons.push('当日涨幅达到6.5%以上，禁止追逐日内急拉');
  if (nearLimitUp) reasons.push('价格已接近涨停区，等待次日换手或回踩确认');
  if (pct <= -3) reasons.push('当日回撤较大，先等待止跌确认');
  if (ma5 !== null && ma5 > 0 && price !== null && price / ma5 - 1 >= 0.045) {
    reasons.push('价格高于5日线4.5%以上，短线乖离过大');
  }
  if (ma10 !== null && ma10 > 0 && price !== null && price / ma10 - 1 >= 0.075) {
    reasons.push('价格高于10日线7.5%以上，盈亏比恶化');
  }
  if (ma10 !== null && ma10 > 0 && price !== null && price / ma10 - 1 <= -0.015) {
    reasons.push('价格低于10日线1.5%以上，趋势尚未修复');
  }
  if (r5 !== null && r5 >= 0.18) reasons.push('近5个交易日涨幅达到18%以上，等待整理');
  if (r8 !== null && r8 >= 0.25) reasons.push('近8个交易日涨幅达到25%以上，等待整理');
  if (atr >= 0.085) reasons.push('ATR波动率达到8.5%以上，暂不提供新开仓计划');

  let pullbackZone = null;
  if (price !== null && price > 0 && atr < 0.085
      && (ma10 === null || price >= ma10 * 0.985)) {
    const anchor = ma5 !== null && ma5 > 0 && price >= ma5 * 0.985
      ? ma5
      : (ma10 !== null && ma10 > 0 ? ma10 : ma5);
    const maxPullback = clamp(atr * 0.55, 0.015, 0.03);
    const minPullback = clamp(atr * 0.18, 0.005, 0.012);
    let low = anchor !== null && anchor > 0
      ? Math.max(anchor * 0.985, price * (1 - maxPullback))
      : price * (1 - maxPullback);
    let high = anchor !== null && anchor > 0
      ? Math.min(anchor * 1.005, price * (1 - minPullback))
      : price * (1 - minPullback);
    if (!(low < high)) {
      low = price * (1 - maxPullback);
      high = price * (1 - minPullback);
    }
    if (low < high) pullbackZone = {low: roundPrice(low), high: roundPrice(high), anchor: roundPrice(anchor)};
  }

  return {
    pass: reasons.length === 0,
    reason: reasons.length ? 'entry-timing' : 'entry-ready',
    reasons,
    nearLimitUp,
    upperLimit: roundPrice(upperLimit),
    ma5Gap: ma5 !== null && ma5 > 0 && price !== null ? price / ma5 - 1 : null,
    ma10Gap: ma10 !== null && ma10 > 0 && price !== null ? price / ma10 - 1 : null,
    pullbackZone
  };
}

/**
 * Stateful position review using entry price, holding days and daily closes.
 * The trailing protection is activated only after a meaningful favorable move;
 * before that, the initial ATR stop remains the primary loss control.
 */
export function evaluateHolding({
  price,
  entry,
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
  const volatility = clamp(num(atr) ?? 0.045, 0.015, 0.20);
  const finalScore = num(score) ?? 50;
  const f3 = num(flow3) ?? 0;
  const f5 = num(flow5) ?? 0;
  const m10 = num(ma10);
  const m20 = num(ma20);

  if (current === null || cost === null || current <= 0 || cost <= 0) {
    return {action: 'HOLD', pnl: null, initialStop: null, activeStop: null, peakClose: null,
      protectionStage: 'unavailable', reasons: ['价格或成本数据缺失，无法给出可靠持仓判断']};
  }

  const pnl = current / cost - 1;
  const initialStopPct = clamp(volatility * 1.4, 0.045, 0.07);
  const initialStop = cost * (1 - initialStopPct);
  const windowSize = Math.max(1, safeDays + 1);
  const recentBars = (Array.isArray(bars) ? bars : [])
    .slice(-windowSize)
    .map(bar => num(bar?.close))
    .filter(value => value !== null && value > 0);
  const peakClose = Math.max(cost, current, ...recentBars);
  const peakGain = peakClose / cost - 1;

  let activeStop = initialStop;
  let protectionStage = 'initial-atr-stop';
  if (peakGain >= 0.06) {
    activeStop = Math.max(activeStop, cost * 1.005);
    protectionStage = 'cost-plus-protection';
  }
  if (peakGain >= 0.10) {
    const trailingDistance = clamp(volatility * 1.25, 0.04, 0.07);
    activeStop = Math.max(activeStop, peakClose * (1 - trailingDistance));
    protectionStage = 'atr-trailing-protection';
  }

  const reasons = [];
  let action = 'HOLD';
  if (newsVeto) {
    action = 'EXIT';
    reasons.push('出现立案、退市、停产、处罚等硬风险新闻，退出优先');
  } else if (current <= activeStop) {
    action = 'EXIT';
    reasons.push(protectionStage === 'initial-atr-stop'
      ? '触及初始ATR止损线，执行风险退出'
      : '触及盈利保护/ATR移动止损线，保护已有收益');
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
  if (safeDays >= 5 && pnl < 0.03 && action === 'HOLD') reasons.push('已进入第5日时间复核窗口，下一交易日仍无加速应退出');
  return {
    action,
    pnl,
    peakGain,
    peakClose,
    initialStopPct,
    initialStop: roundPrice(initialStop),
    activeStop: roundPrice(activeStop),
    protectionStage,
    reasons
  };
}
