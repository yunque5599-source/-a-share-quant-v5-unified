const n = value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const clamp = (value, low=0, high=100) => Math.max(low, Math.min(high, Number.isFinite(value) ? value : low));
const mean = values => {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
};

function inferBoard(code, board) {
  if (board) return String(board);
  const value = String(code ?? '');
  if (/^688|^689/.test(value)) return 'STAR';
  if (/^300|^301/.test(value)) return 'CHINEXT';
  if (/^(4|8|92)/.test(value)) return 'BSE';
  if (/^60/.test(value)) return 'SH_MAIN';
  if (/^(00|001|002|003)/.test(value)) return 'SZ_MAIN';
  return 'UNKNOWN';
}

function limitPctForBoard(board) {
  if (board === 'CHINEXT' || board === 'STAR') return 20;
  if (board === 'BSE') return 30;
  if (board === 'SH_MAIN' || board === 'SZ_MAIN') return 10;
  return null;
}

function band(value, idealLow, idealHigh, outerLow, outerHigh) {
  if (value === null || outerHigh <= outerLow) return null;
  if (value >= idealLow && value <= idealHigh) return 100;
  if (value < idealLow) return clamp((value - outerLow) / (idealLow - outerLow) * 100);
  return clamp(100 - (value - idealHigh) / (outerHigh - idealHigh) * 100);
}

function trendScore(features) {
  return mean([
    band(n(features.r3Pct), 1.5, 7, -7, 16),
    band(n(features.r5Pct), 2.5, 12, -10, 26),
    band(n(features.r10Pct), 3, 18, -15, 38)
  ]);
}

function flowScore(row) {
  const f = row.features ?? {};
  const components = row.components ?? {};
  const flowCount = n(f.flowCount);
  const share = n(f.flowPositiveShare);
  const mainNet5 = n(f.mainNet5);
  const evidence = [];
  if (flowCount !== null && flowCount > 0 && share !== null) evidence.push(clamp(share * 100));
  if (flowCount !== null && flowCount > 0 && mainNet5 !== null) evidence.push(mainNet5 > 0 ? 82 : mainNet5 === 0 ? 48 : 12);
  if (n(components.flow) !== null) evidence.push(n(components.flow));
  return mean(evidence);
}

function sectorScore(row) {
  return mean([n(row.components?.sector), n(row.components?.marketFit), n(row.features?.industryUpRatio) === null ? null : clamp(n(row.features.industryUpRatio) * 100)]);
}

function leaderScore(row) {
  const evidence = row.leaderEvidence ?? {};
  const status = String(evidence.leaderStatus ?? '').toLowerCase();
  const statusScore = ({leader:100,core:88,front:72,follower:42})[status] ?? null;
  const rank = n(evidence.candidateRank);
  const rankScore = rank !== null && rank > 0 ? clamp(100 - (rank - 1) * 15) : null;
  const direct = mean([statusScore, rankScore]);
  const proxy = mean([n(evidence.industryLeaderScore), n(evidence.themeHeat)]);
  // An industry-relative proxy is not equivalent to verified theme leadership.
  if (direct === null) return proxy === null ? null : Math.min(55, proxy);
  return mean([direct, proxy, proxy]);
}

function impulsePotentialScore(row, priorLimitUpScore) {
  const f = row.features ?? {};
  const turnover = n(f.turnoverRate ?? row.quote?.turnoverRate);
  const volume = n(f.volumeExpansion);
  const recent = n(f.recentLimitUp10Count ?? f.recentLimitUp5Count);
  const turnoverScore = turnover === null ? null
    : turnover >= 8 ? 100 : turnover >= 5 ? 88 : turnover >= 3 ? 75
      : turnover >= 1.5 ? 58 : turnover >= 0.8 ? 40 : 24;
  const volumePotential = volume === null ? null
    : volume >= 2.5 ? 95 : volume >= 1.8 ? 82 : volume >= 1.3 ? 65 : volume >= 1.0 ? 45 : 28;
  const priorPotential = recent === null ? priorLimitUpScore
    : recent >= 2 ? 95 : recent === 1 ? 78 : 34;
  return mean([turnoverScore, volumePotential, priorPotential]);
}

function catalystScore(row) {
  const psychology = row.psychology ?? {};
  const fallback = psychology.stockNewsFallback ?? {};
  const direction = String(fallback.headlineCatalystDirection ?? psychology.headlineCatalystDirection ?? '').toLowerCase();
  const raw = n(fallback.headlineCatalystScore ?? psychology.headlineCatalystScore);
  if (raw === null) return null;
  if (direction === 'negative') return clamp(raw * 0.35);
  if (direction === 'positive') return clamp(raw);
  return clamp(raw * 0.7);
}

function weightedScore(parts) {
  let weighted = 0, availableWeight = 0, evidenceCount = 0;
  for (const [value, weight] of parts) {
    if (value === null || !Number.isFinite(value)) continue;
    weighted += clamp(value) * weight;
    availableWeight += weight;
    evidenceCount += 1;
  }
  return {
    score: availableWeight > 0 ? weighted / availableWeight : null,
    evidenceCount,
    evidenceWeightPct: Number((availableWeight * 100).toFixed(1))
  };
}

function isRestricted(row) {
  const name = String(row.name ?? row.code ?? '');
  return /^(?:\*?ST|S\*ST|PT|退)/i.test(name) || /退市|终止上市|暂停上市/i.test(name);
}

/**
 * A distinct next-session limit-up observation rank. It intentionally uses two
 * paths: continuation after a strong session and early breakout near resistance.
 * It is not a calibrated probability, buy signal, or execution authorization.
 */
export function assessNextDayLimitUpCandidate(row = {}) {
  const code = String(row.code ?? '');
  const name = String(row.name ?? code);
  const board = inferBoard(code, row.board);
  const limitPct = limitPctForBoard(board);
  const pct = n(row.quote?.pct ?? row.currentPct);
  const atDailyLimit = pct !== null && limitPct !== null
    && pct >= limitPct - 0.4 && pct <= limitPct + 0.4;
  const f = row.features ?? {};
  const c = row.components ?? {};
  const failures = [];

  if (!/^\d{6}$/.test(code) || limitPct === null) failures.push('unsupported-board-or-code');
  if (isRestricted(row)) failures.push('restricted-listing-name');
  if (pct === null) failures.push('missing-current-session-return');

  const r3 = n(f.r3Pct), r5 = n(f.r5Pct), r10 = n(f.r10Pct);
  const closeLocation = n(f.closeLocation);
  const volumeExpansion = n(f.volumeExpansion);
  const distHigh20 = n(f.distHigh20Pct);
  const recentLimitUp5 = n(f.recentLimitUp5Count);
  const recentLimitUp10 = n(f.recentLimitUp10Count);
  const sector = sectorScore(row);
  const flow = flowScore(row);
  const leader = leaderScore(row);
  const catalyst = catalystScore(row);
  const catalystDirection = String(
    (row.psychology?.stockNewsFallback ?? {}).headlineCatalystDirection
      ?? row.psychology?.headlineCatalystDirection ?? ''
  ).toLowerCase();
  const leaderStatus = String(row.leaderEvidence?.leaderStatus ?? '').toLowerCase();
  const leaderVerified = row.leaderEvidence?.isLeader === true || ['leader','core'].includes(leaderStatus);
  const trend = trendScore(f);

  const moveRatio = pct !== null && limitPct ? pct / limitPct : null;
  const continuationMove = moveRatio === null ? null : band(moveRatio, 0.22, 0.68, -0.08, 0.97);
  const breakoutMove = moveRatio === null ? null : band(moveRatio, 0.02, 0.24, -0.12, 0.52);
  const closeScore = closeLocation === null ? null : clamp(closeLocation * 100);
  const volumeScore = band(volumeExpansion, 1.15, 2.6, 0.45, 4.5);
  const proximityScore = distHigh20 === null ? null : band(distHigh20, -5, 1.5, -22, 10);
  const historicalLimitUpScore = recentLimitUp5 !== null
    ? clamp(45 + Math.min(Math.max(recentLimitUp5, 0), 2) * 20
      + Math.min(Math.max((recentLimitUp10 ?? recentLimitUp5) - recentLimitUp5, 0), 3) * 5
      - Math.max(recentLimitUp5 - 3, 0) * 12)
    : recentLimitUp10 !== null ? clamp(45 + Math.min(Math.max(recentLimitUp10, 0), 3) * 9) : null;
  // Today's confirmed limit-up is itself a continuation event, even if the
  // historical feature window has not yet incorporated the current session.
  const priorLimitUpScore = atDailyLimit
    ? Math.max(historicalLimitUpScore ?? 0, 82)
    : historicalLimitUpScore;
  const impulsePotential = impulsePotentialScore(row, priorLimitUpScore);

  const continuation = weightedScore([
    [continuationMove,0.14],[closeScore,0.09],[volumeScore,0.11],
    [trend,0.11],[priorLimitUpScore,0.16],[sector,0.11],
    [flow,0.10],[leader,0.06],[catalyst,0.04],[impulsePotential,0.08]
  ]);
  const breakout = weightedScore([
    [proximityScore,0.16],[volumeScore,0.15],[closeScore,0.10],
    [trend,0.14],[breakoutMove,0.08],[sector,0.11],
    [flow,0.10],[leader,0.03],[catalyst,0.05],[impulsePotential,0.08]
  ]);
  // A stock already locked at its board limit cannot be bought as a same-day
  // breakout, but is a material candidate for a next-session continuation.
  const lockedContinuation = weightedScore([
    [priorLimitUpScore,0.18],[closeScore,0.12],[volumeScore,0.12],
    [trend,0.12],[sector,0.12],[flow,0.12],
    [leader,0.10],[catalyst,0.06],[impulsePotential,0.06]
  ]);
  const chosen = atDailyLimit
    ? {...lockedContinuation, path:'LIMITUP_CONTINUATION'}
    : (breakout.score ?? -Infinity) > (continuation.score ?? -Infinity)
      ? {...breakout, path:'PREBREAKOUT'}
      : {...continuation, path:'CONTINUATION'};
  let score = chosen.score;
  if (score === null) score = 0;
  const riskFlags = [];
  if (atDailyLimit) riskFlags.push('当日已触及涨停区间；此路径仅评估次日连板/延续，不代表可在封板价买入，需警惕一字板、炸板和次日分歧');
  else if (pct !== null && limitPct !== null && pct / limitPct >= 0.78) riskFlags.push('当日涨幅已接近涨停区间，次日高开与追涨风险偏高');
  if (r5 !== null && r5 > 18) riskFlags.push('近5日涨幅偏大，存在短线过热风险');
  if (r3 !== null && r5 !== null && r3 < -3 && r5 < -5) {
    score = Math.max(0, score - 14);
    riskFlags.push('短线趋势仍偏弱，已施加逆势风险扣分');
  }
  if (flow === null) riskFlags.push('资金流证据缺失，不能确认持续流入');
  else if (flow < 45) {
    score = Math.max(0, score - 9);
    riskFlags.push('资金证据偏弱，已施加涨停目标风险扣分');
  }
  if (sector !== null && sector < 45) {
    score = Math.max(0, score - 8);
    riskFlags.push('板块强度不足，已施加风险扣分');
  }
  const hasRecentLimitUp = (recentLimitUp5 ?? 0) > 0 || (recentLimitUp10 ?? 0) > 0;
  const positiveCatalyst = catalyst !== null && catalystDirection === 'positive' && catalyst >= 65;
  if (!leaderVerified && !hasRecentLimitUp && !positiveCatalyst) {
    score = Math.max(0, score - 7);
    riskFlags.push('缺少已验证龙头、近期涨停或强正面催化，已降低爆发性先验');
  }
  const turnover = n(f.turnoverRate ?? row.quote?.turnoverRate);
  if (!hasRecentLimitUp && !leaderVerified && !positiveCatalyst
      && turnover !== null && turnover < 1.2
      && (volumeExpansion === null || volumeExpansion < 1.4)) {
    score = Math.max(0, score - 10);
    riskFlags.push('换手和量能扩张均弱，次日涨停爆发性偏低');
  }
  if (leader === null) riskFlags.push('题材龙头证据不足');
  if (catalyst !== null && catalystDirection === 'negative') {
    score = Math.max(0, score - 8);
    riskFlags.push('检测到负面催化证据，已施加风险扣分');
  }

  const evidenceCount = [
    pct,closeLocation,volumeExpansion,trend,proximityScore,priorLimitUpScore,
    sector,flow,leader,catalyst,impulsePotential
  ].filter(value => value !== null && Number.isFinite(value)).length;
  const confidence = clamp(18 + evidenceCount * 6 + Math.min(8, chosen.evidenceWeightPct * 0.08)
    - (leaderVerified ? 0 : 7) - (flow !== null && flow < 45 ? 5 : 0)
    - (!hasRecentLimitUp && !positiveCatalyst ? 4 : 0));
  const minScore = 45;
  const independentContinuationEvidenceCount = [
    closeScore,volumeScore,trend,sector,flow,leader,catalyst
  ].filter(value => value !== null && Number.isFinite(value)).length;
  if (atDailyLimit && independentContinuationEvidenceCount < 2) {
    failures.push('insufficient-limitup-continuation-evidence');
  }
  const passed = failures.length === 0 && score >= minScore;
  const stage = chosen.path === 'LIMITUP_CONTINUATION'
    ? 'NEXT_DAY_LIMITUP_CONTINUATION_WATCH'
    : chosen.path === 'CONTINUATION'
      ? 'NEXT_DAY_CONTINUATION_WATCH'
      : 'NEXT_DAY_PREBREAKOUT_WATCH';

  return {
    code,name,board,asOf:row.asOf??null,
    themeName:row.leaderEvidence?.themeName??row.psychology?.primaryTheme??null,
    currentPct:pct,
    atDailyLimit,
    forecastHorizon:'NEXT_SESSION',
    score:Number(score.toFixed(1)),
    confidence:Number(confidence.toFixed(1)),
    stage,path:chosen.path,passed,leaderVerified,
    components:{
      continuationScore:continuation.score===null?null:Number(continuation.score.toFixed(1)),
      limitUpContinuationScore:lockedContinuation.score===null?null:Number(lockedContinuation.score.toFixed(1)),
      prebreakoutScore:breakout.score===null?null:Number(breakout.score.toFixed(1)),
      dailyMove:moveRatio===null?null:Number((clamp(moveRatio*100)).toFixed(1)),
      closeStrength:closeScore===null?null:Number(closeScore.toFixed(1)),
      volumeExpansion:volumeScore===null?null:Number(volumeScore.toFixed(1)),
      shortTrend:trend===null?null:Number(trend.toFixed(1)),
      priorLimitUpActivity:priorLimitUpScore===null?null:Number(priorLimitUpScore.toFixed(1)),
      resistanceProximity:proximityScore===null?null:Number(proximityScore.toFixed(1)),
      impulsePotential:impulsePotential===null?null:Number(impulsePotential.toFixed(1)),
      sectorStrength:sector===null?null:Number(sector.toFixed(1)),
      capitalFlow:flow===null?null:Number(flow.toFixed(1)),
      leaderEvidence:leader===null?null:Number(leader.toFixed(1)),
      catalystEvidence:catalyst===null?null:Number(catalyst.toFixed(1))
    },
    evidence:{
      r3Pct:r3,r5Pct:r5,r10Pct:r10,closeLocation,volumeExpansion,distHigh20Pct:distHigh20,
      recentLimitUp5Count:recentLimitUp5,recentLimitUp10Count:recentLimitUp10,
      flowCount:n(f.flowCount),flowPositiveShare:n(f.flowPositiveShare),mainNet5:n(f.mainNet5),
      sectorScore:sector,leaderScore:leader,catalystScore:catalyst,
      evidenceWeightPct:chosen.evidenceWeightPct
    },
    failedGates:failures,riskFlags,
    action:passed?'WATCH_NEXT_SESSION_CONFIRMATION':'DO_NOT_PROMOTE',
    method:'dual-path-next-session-limit-up-ranking-not-a-calibrated-probability'
  };
}

export function rankNextDayLimitUpCandidates(rows = [], options = {}) {
  const maxResults = Math.max(1, Math.min(50, Number(options.maxResults) || 30));
  const minScore = Number.isFinite(Number(options.minScore)) ? Number(options.minScore) : 45;
  const assessed = (Array.isArray(rows) ? rows : []).map(assessNextDayLimitUpCandidate);
  const eligible = assessed.filter(row => row.passed && row.score >= minScore)
    .sort((a,b) => b.score-a.score || b.confidence-a.confidence || (Number(b.currentPct)||0)-(Number(a.currentPct)||0));
  const ranking = eligible.slice(0,maxResults).map((row,index)=>({...row,rank:index+1}));
  return {
    ranking,assessed,
    summary:{
      version:'v13-next-day-limitup-dual-path-v1',
      assessedCount:assessed.length,
      passedGateCount:eligible.length,
      returnedCount:ranking.length,
      continuationCount:ranking.filter(row=>row.path==='CONTINUATION').length,
      limitUpContinuationCount:ranking.filter(row=>row.path==='LIMITUP_CONTINUATION').length,
      prebreakoutCount:ranking.filter(row=>row.path==='PREBREAKOUT').length,
      atLimitAssessedCount:assessed.filter(row=>row.atDailyLimit).length,
      atLimitPassedGateCount:assessed.filter(row=>row.atDailyLimit&&row.passed).length,
      failedGateCounts:Object.fromEntries(assessed.flatMap(row=>row.failedGates).reduce((map,key)=>map.set(key,(map.get(key)??0)+1),new Map())),
      scoreRejectedCount:assessed.filter(row=>row.failedGates.length===0&&row.score<minScore).length,
      observationOnly:true,
      calibratedProbability:false,
      entrySignal:false
    }
  };
}
