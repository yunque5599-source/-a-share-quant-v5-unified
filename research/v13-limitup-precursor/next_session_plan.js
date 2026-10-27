'use strict';

// Research-only next-session execution checklist.
// It distinguishes a ranked candidate from a confirmed entry and never places orders.

const n = value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value))
  ? null : Number(value);

function boardOf(row = {}) {
  const board = String(row.board ?? '').toUpperCase();
  if (['SH_MAIN','SZ_MAIN','CHINEXT','STAR','BSE'].includes(board)) return board;
  const code = String(row.code ?? '');
  if (/^68[89]\d{3}$/.test(code)) return 'STAR';
  if (/^6\d{5}$/.test(code)) return 'SH_MAIN';
  if (/^00\d{4}$/.test(code)) return 'SZ_MAIN';
  if (/^3\d{5}$/.test(code)) return 'CHINEXT';
  if (/^(?:[48]\d{5}|92\d{4})$/.test(code)) return 'BSE';
  return 'UNKNOWN';
}

function dailyLimitPct(board) {
  if (board === 'CHINEXT' || board === 'STAR') return 20;
  if (board === 'BSE') return 30;
  return 10;
}

function isMainBoard(board) {
  return board === 'SH_MAIN' || board === 'SZ_MAIN';
}

function buildNextSessionPlan(row = {}, options = {}) {
  const board = boardOf(row);
  const lane = String(options.lane ?? 'unspecified');
  const currentPct = n(row.quote?.pct ?? row.currentPct);
  const score = n(row.selectionScore ?? row.score);
  const signalDate = String(options.signalDate ?? row.asOf ?? '');
  const selection = row.selection ?? {};
  const isCoreLane = lane === 'coreSelection';
  const isPreBreakoutLane = lane === 'preBreakoutWatch';
  const coreEligible = selection.eligible === true;
  const preBreakoutEligible = row.passed === true && String(row.stage ?? '').startsWith('PREBREAKOUT_');
  const dataLimited = selection.decision === 'OBSERVE_DATA_LIMITED'
    || options.sourceDegraded === true
    || row.source?.degraded === true;

  let status = 'RANKING_WATCH_ONLY';
  let label = '排名观察，不构成买入信号';
  if (!isMainBoard(board)) {
    status = 'OUT_OF_SCOPE_BOARD';
    label = '非沪深主板标的，不进入当前主选股执行清单';
  } else if (selection.eligible === false || selection.decision === 'NO_TRADE'
      || (row.passed === false && isPreBreakoutLane)) {
    status = 'REJECTED_BY_GATES';
    label = '未通过模型硬门槛';
  } else if (currentPct !== null && currentPct >= dailyLimitPct(board) - 0.7) {
    status = 'NO_CHASE_EXTENDED';
    label = '信号日已接近涨停，不追高；等待下一次结构重建';
  } else if (dataLimited) {
    status = 'OBSERVE_DATA_LIMITED';
    label = '数据质量不足，只观察，不执行';
  } else if (isCoreLane && coreEligible) {
    status = selection.decision === 'WAIT_PULLBACK'
      ? 'WAIT_PULLBACK_CONFIRMATION'
      : 'WAIT_NEXT_SESSION_CONFIRMATION';
    label = selection.decision === 'WAIT_PULLBACK'
      ? '核心候选：等待回踩企稳与盘中确认'
      : '核心候选：等待次日开盘、量价和题材确认';
  } else if (isPreBreakoutLane && preBreakoutEligible) {
    status = 'PREBREAKOUT_WATCH';
    label = '启动前观察候选；未确认买点前不追单';
  }

  return {
    version: 'v13-next-session-plan-v1',
    signalDate: signalDate || null,
    code: String(row.code ?? ''),
    name: String(row.name ?? row.code ?? ''),
    lane,
    score,
    board,
    status,
    label,
    entryRules: {
      preferredOpeningGapPct: { min: -1.5, max: 3 },
      openingGapAbove3Pct: 'WAIT_FOR_PULLBACK',
      openingGapAbove5Pct: 'NO_CHASE_UNLESS_BASE_REFORMS',
      requirePriceHoldsVwap: true,
      requireBreakoutOrRetestConfirmation: true,
      requireThemeBreadthAndFlowNotDeteriorating: true,
      requireValidQuoteAndNonDegradedSources: true
    },
    invalidationRules: [
      '跌破前一交易日低点且不能快速收回',
      '所属题材广度显著转弱或资金流证据反转',
      '行情/题材核心数据过期、缺失或来源降级'
    ],
    riskRules: {
      noChaseNearDailyLimit: true,
      requirePredefinedStopBeforeEntry: true,
      requirePositionRiskBudgetBeforeEntry: true,
      automaticOrderPlacement: false
    },
    note: 'This is a rule-based research checklist, not a calibrated probability or an automatic buy instruction.'
  };
}

function evaluateNextSessionEntry(row = {}, session = {}, options = {}) {
  const board = boardOf(row);
  const gap = n(session.openingGapPct);
  const currentPct = n(session.currentPct);
  const limit = dailyLimitPct(board);
  const plan = buildNextSessionPlan(row, options);
  const result = (status, reason) => ({
    code: String(row.code ?? ''),
    name: String(row.name ?? row.code ?? ''),
    board,
    status,
    reason,
    automaticOrderPlacement: false
  });

  if (!isMainBoard(board)) return result('OUT_OF_SCOPE_BOARD', '当前主选股执行清单仅覆盖沪深主板。');
  if (row.selection?.eligible === false || row.selection?.decision === 'NO_TRADE') {
    return result('REJECTED_BY_GATES', '候选未通过核心选股硬门槛。');
  }
  if (session.sourceDegraded === true || session.quoteValid === false || session.themeDataValid === false) {
    return result('OBSERVE_DATA_LIMITED', '实时行情或题材数据质量不合格。');
  }
  if (session.previousLowBroken === true) {
    return result('INVALIDATED', '跌破前一交易日低点，原启动假设失效。');
  }
  if (session.limitUpLocked === true || (currentPct !== null && currentPct >= limit - 0.7)) {
    return result('NO_CHASE_LIMIT_UP', '接近涨停或涨停封板，不追价。');
  }
  if (gap === null || currentPct === null
      || typeof session.priceHoldsVwap !== 'boolean'
      || typeof session.breakoutOrRetestConfirmed !== 'boolean'
      || typeof session.themeAndFlowConfirmed !== 'boolean') {
    return result('WAIT_FOR_SESSION_DATA', '缺少开盘涨幅、实时涨幅、VWAP、突破/回踩或题材资金确认数据。');
  }
  if (gap > 5) return result('NO_CHASE_GAP_TOO_HIGH', '开盘跳空超过5%，先等待回踩和新的风险收益评估。');
  if (gap > 3) return result('WAIT_PULLBACK', '开盘跳空偏高，等待回踩企稳，不直接追涨。');
  if (gap < -5) return result('WEAK_OPEN_REASSESS', '大幅低开，需重新评估题材和结构，不沿用昨日信号。');
  if (!session.priceHoldsVwap || !session.breakoutOrRetestConfirmed || !session.themeAndFlowConfirmed) {
    return result('WAIT_FOR_CONFIRMATION', '开盘条件未全部确认，继续观察，不提前当作买点。');
  }
  return result('SETUP_CONFIRMED_FOR_REVIEW', '规则条件满足；仍需人工复核止损、仓位、流动性和交易成本后决定。');
}

export { boardOf, dailyLimitPct, buildNextSessionPlan, evaluateNextSessionEntry };
