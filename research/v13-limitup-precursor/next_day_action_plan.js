'use strict';

// Decision support for next-session review. This module does not place orders and
// deliberately separates a prior-day discovery signal from a next-day entry decision.

const n = value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);

function boardForCode(code) {
  const value = String(code ?? '');
  if (/^(300|301)/.test(value)) return 'CHINEXT';
  if (/^(688|689)/.test(value)) return 'STAR';
  if (/^(4|8|92)/.test(value)) return 'BSE';
  if (/^6/.test(value)) return 'SH_MAIN';
  if (/^(00|001|002|003)/.test(value)) return 'SZ_MAIN';
  return 'UNKNOWN';
}

function priceLimitPct(code) {
  const board = boardForCode(code);
  if (board === 'CHINEXT' || board === 'STAR') return 19.0;
  if (board === 'BSE') return 28.5;
  return 9.3;
}

function entryMoveCapPct(code) {
  const board = boardForCode(code);
  if (board === 'CHINEXT' || board === 'STAR') return 15;
  if (board === 'BSE') return 22.5;
  return 7.5;
}

function chinaTradingDate(value) {
  if (!value) return '';
  const raw = String(value);
  if (/^\\d{4}-\\d{2}-\\d{2}$/.test(raw)) return raw;
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit'
  }).formatToParts(new Date(timestamp));
  const part = type => parts.find(item => item.type === type)?.value ?? '';
  return part('year') + '-' + part('month') + '-' + part('day');
}

function firstUniqueRows(groups, maxRows = 30) {
  const seen = new Set();
  const result = [];
  for (const group of groups) {
    for (const row of Array.isArray(group?.rows) ? group.rows : []) {
      const code = String(row?.code ?? '');
      if (!code || seen.has(code)) continue;
      seen.add(code);
      result.push({...row, _sourceLane:group.name});
      if (result.length >= maxRows) return result;
    }
  }
  return result;
}

function snapshotRankGroups(snapshot, previous = false) {
  const rankings = snapshot?.rankings ?? {};
  if (previous) {
    return [
      {name:'prior-core-selection', rows:(rankings.coreSelection ?? []).slice(0, 10)},
      {name:'prior-overall', rows:(rankings.overall ?? []).slice(0, 15)},
      {name:'prior-pre-breakout-watch', rows:(rankings.preBreakoutWatch ?? []).slice(0, 10)}
    ];
  }
  return [
    {name:'core-selection', rows:(rankings.coreSelection ?? []).slice(0, 5)},
    {name:'overall', rows:(rankings.overall ?? []).slice(0, 10)},
    {name:'pre-breakout-watch', rows:(rankings.preBreakoutWatch ?? []).slice(0, 10)}
  ];
}

function mergeCurrentCandidate(row, candidateByCode) {
  const audit = candidateByCode.get(String(row.code ?? '')) ?? {};
  const auditScore = audit.score && typeof audit.score === 'object' ? audit.score : {};
  const merged = {...audit, ...row,
    quote:{...(audit.quote ?? {}), ...(row.quote ?? {})},
    features:{...(audit.features ?? {}), ...(row.features ?? {})},
    source:{...(audit.source ?? {}), ...(row.source ?? {})}
  };
  merged.score = n(row.score) ?? n(row.selectionScore) ?? n(auditScore.score) ?? n(audit.score);
  merged.entryEligible = row.entryEligible === true || auditScore.entryEligible === true;
  merged.entryGateReasons = Array.isArray(row.entryGateReasons) ? row.entryGateReasons
    : Array.isArray(auditScore.entryGateReasons) ? auditScore.entryGateReasons : [];
  merged.confidence = n(row.confidence) ?? n(auditScore.confidence);
  return merged;
}

function assessAction(row, sourceAvailable = true) {
  const code = String(row?.code ?? '');
  const pct = n(row?.quote?.pct ?? row?.currentPct ?? row?.features?.currentPct);
  const score = n(row?.score ?? row?.selectionScore);
  const entryEligible = row?.entryEligible === true;
  const gateReasons = Array.isArray(row?.entryGateReasons) ? row.entryGateReasons.slice(0, 8) : [];
  const limit = priceLimitPct(code);
  const cap = entryMoveCapPct(code);
  if (!sourceAvailable) {
    return {action:'SOURCE_UNAVAILABLE', label:'数据未通过质量门槛', reason:'当前快照不可用于生成交易候选', currentPct:pct};
  }
  if (pct !== null && pct >= limit - 0.4) {
    return {action:'MOVE_MATERIALIZED_NO_CHASE', label:'强势兑现，不追高', reason:'当日涨幅已接近或达到涨停阈值；记录信号兑现，等待下一交易日重新评估', currentPct:pct};
  }
  if (pct !== null && pct > cap) {
    return {action:'EXTENDED_WAIT_PULLBACK', label:'涨幅偏大，等待回踩', reason:'超过模型的当日入场涨幅上限，不因排名靠前而追价', currentPct:pct};
  }
  if (pct !== null && pct < -2) {
    return {action:'WEAKENED_REASSESS_RISK', label:'走势转弱，重新评估', reason:'当日跌幅超过2%；检查题材、资金、支撑位与原始交易假设，不自动补仓', currentPct:pct};
  }
  if (entryEligible && score !== null && score >= 60) {
    return {action:'ENTRY_TRIGGER_WATCH', label:'等待入场触发条件', reason:'评分和入场门槛通过，但仍需核验实时价格、盘口、流动性及预设止损；不是自动买入指令', currentPct:pct};
  }
  return {
    action:'WATCH_ONLY',
    label:'继续观察，不直接买入',
    reason:gateReasons.length ? '入场门槛未全部通过：' + gateReasons.join(', ') : '缺少足够的入场确认；候选排名不等于买入信号',
    currentPct:pct
  };
}

function assessPriorCandidate(priorRow, currentRow, sourceAvailable) {
  const code = String(priorRow?.code ?? '');
  if (!sourceAvailable) {
    return {code, name:priorRow?.name ?? code, priorRank:priorRow?.rank ?? null,
      priorScore:n(priorRow?.score), priorLane:priorRow?._sourceLane,
      followThrough:'CURRENT_SOURCE_UNAVAILABLE', label:'今日数据不可用', action:'NO_ACTION',
      reason:'当前快照未通过数据质量门槛，不能判断昨日信号是否兑现'};
  }
  if (!currentRow) {
    return {code, name:priorRow?.name ?? code, priorRank:priorRow?.rank ?? null,
      priorScore:n(priorRow?.score), priorLane:priorRow?._sourceLane,
      followThrough:'NOT_REASSESSED', label:'今日未重新评估', action:'NO_ACTION',
      reason:'当前候选池未覆盖该股票；不能据此认定信号失效'};
  }
  const assessed = assessAction(currentRow, true);
  const pct = assessed.currentPct;
  let followThrough = 'STILL_UNRESOLVED';
  let label = '信号仍需观察';
  let action = 'REASSESS';
  let reason = '重新检查题材强度、个股相对强度、资金和风险条件';
  if (pct !== null && pct >= priceLimitPct(code) - 0.4) {
    followThrough = 'LIMIT_UP_OR_NEAR_LIMIT';
    label = '昨日信号已明显兑现';
    action = 'NO_CHASE';
    reason = '若今日已接近或达到涨停，不能把昨日候选等同于今日可买；等待次日重新评估';
  } else if (pct !== null && pct < -2) {
    followThrough = 'WEAKENED';
    label = '走势明显转弱';
    action = 'REASSESS_RISK';
    reason = '检查原始逻辑是否破坏，不自动补仓，也不因昨日入选而继续持有';
  } else if (assessed.action === 'ENTRY_TRIGGER_WATCH') {
    followThrough = 'REMAINS_ENTRY_WATCH';
    label = '仍满足观察门槛';
    action = 'CHECK_ENTRY_TRIGGER';
    reason = '仍需实时入场触发确认；不根据昨日排名直接下单';
  } else if (assessed.action === 'EXTENDED_WAIT_PULLBACK') {
    followThrough = 'EXTENDED';
    label = '仍然偏高，不追价';
    action = 'WAIT_PULLBACK';
    reason = assessed.reason;
  } else if (pct !== null && pct >= 0) {
    followThrough = 'STABLE_OR_POSITIVE';
    label = '走势尚未明显转弱';
    action = 'KEEP_ON_WATCHLIST';
    reason = '保留观察但重新核验当前证据，不等于买入指令';
  }
  return {
    code, name:currentRow.name ?? priorRow.name ?? code,
    priorRank:priorRow.rank ?? null, priorScore:n(priorRow.score),
    currentRank:currentRow.rank ?? null, currentScore:n(currentRow.score),
    priorLane:priorRow._sourceLane, followThrough, label, action,
    currentPct:pct, entryAction:assessed.action, reason
  };
}

export function buildNextDayActionPlan(currentSnapshot = {}, previousSnapshot = null) {
  const sourceAvailable = currentSnapshot.recommendationsAvailable === true;
  const candidateByCode = new Map((Array.isArray(currentSnapshot.candidates) ? currentSnapshot.candidates : [])
    .filter(row => row?.code).map(row => [String(row.code), row]));
  const currentRows = firstUniqueRows(snapshotRankGroups(currentSnapshot), 30)
    .map(row => mergeCurrentCandidate(row, candidateByCode));
  const currentActions = currentRows.slice(0, 12).map((row, index) => ({
    rank:index + 1,
    code:String(row.code),
    name:String(row.name ?? row.code),
    score:n(row.score ?? row.selectionScore),
    confidence:n(row.confidence),
    lane:row._sourceLane,
    entryEligible:row.entryEligible === true,
    entryGateReasons:Array.isArray(row.entryGateReasons) ? row.entryGateReasons.slice(0, 8) : [],
    ...assessAction(row, sourceAvailable)
  }));

  const currentTradingDate = chinaTradingDate(currentSnapshot.asOf ?? currentSnapshot.capturedAt);
  const previousTradingDate = chinaTradingDate(previousSnapshot?.asOf ?? previousSnapshot?.capturedAt);
  const priorSnapshotAvailable = Boolean(previousSnapshot)
    && previousSnapshot.recommendationsAvailable === true
    && Boolean(currentTradingDate && previousTradingDate && previousTradingDate < currentTradingDate);
  const priorRows = priorSnapshotAvailable
    ? firstUniqueRows(snapshotRankGroups(previousSnapshot, true), 25)
    : [];
  const currentByCode = new Map([...candidateByCode.entries()].map(([code, row]) =>
    [code, mergeCurrentCandidate(row, candidateByCode)]));
  for (const row of currentRows) currentByCode.set(String(row.code), row);
  const followThrough = priorRows.map(row =>
    assessPriorCandidate(row, currentByCode.get(String(row.code)), sourceAvailable));

  return {
    schema:'v13-next-day-action-plan-v1',
    generatedAt:currentSnapshot.capturedAt ?? new Date().toISOString(),
    currentSnapshotId:currentSnapshot.snapshotId ?? null,
    previousSnapshotId:priorSnapshotAvailable ? previousSnapshot.snapshotId ?? null : null,
    status:!sourceAvailable ? 'SOURCE_UNAVAILABLE'
      : priorSnapshotAvailable ? 'CURRENT_AND_PRIOR_REVIEW'
        : 'CURRENT_ONLY_NO_PRIOR_SNAPSHOT',
    sourceAvailable,
    priorSnapshotAvailable,
    policy:'decision-support-only-no-order-placement',
    summary:{
      currentCandidates:currentActions.length,
      entryTriggerWatch:currentActions.filter(row => row.action === 'ENTRY_TRIGGER_WATCH').length,
      noChase:currentActions.filter(row => row.action === 'MOVE_MATERIALIZED_NO_CHASE').length,
      weakened:currentActions.filter(row => row.action === 'WEAKENED_REASSESS_RISK').length,
      priorCandidatesReviewed:followThrough.length,
      priorLimitUpOrNearLimit:followThrough.filter(row => row.followThrough === 'LIMIT_UP_OR_NEAR_LIMIT').length,
      priorWeakened:followThrough.filter(row => row.followThrough === 'WEAKENED').length,
      priorNotReassessed:followThrough.filter(row => row.followThrough === 'NOT_REASSESSED').length
    },
    currentActions,
    priorDayFollowThrough:followThrough,
    limitations:[
      '候选排名不等于买入信号。',
      '今日接近涨停的股票只记录信号兑现，不生成追高动作。',
      '未进入今日候选池不代表股票下跌或昨日信号失效。',
      '只有提供前一交易日且通过质量门槛的快照，才能评估昨日候选的后续表现。',
      '同一交易日内的多个快照不会被误当成隔日跟踪记录。'
    ]
  };
}
