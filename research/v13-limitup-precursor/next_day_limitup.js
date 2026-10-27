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
  const industry = n(evidence.industryLeaderScore);
  const theme = n(evidence.themeHeat);
  return mean([statusScore, rankScore, industry, theme]);
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
  const f = row.features ?? {};
  const c = row.components ?? {};
  const failures = [];

  if (!/^\d{6}$/.test(code) || limitPct === null) failures.push('unsupported-board-or-code');
  if (isRestricted(row)) failures.push('restricted-listing-name');
  if (pct === null) failures.push('missing-current-session-return');
  if (pct !== null && limitPct !== null && pct >= limitPct - 0.05) failures.push('already-at-daily-limit');

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
  const trend = trendScore(f);

  const moveRatio = pct !== null && limitPct ? pct / limitPct : null;
  const continuationMove = moveRatio === null ? null : band(moveRatio, 0.22, 0.68, -0.08, 0.97);
  const breakoutMove = moveRatio === null ? null : band(moveRatio, 0.02, 0.24, -0.12, 0.52);
  const closeScore = closeLocation === null ? null : clamp(closeLocation * 100);
  const volumeScore = band(volumeExpansion, 1.15, 2.6, 0.45, 4.5);
  const proximityScore = distHigh20 === null ? null : band(distHigh20, -5, 1.5, -22, 10);
  const priorLimitUpScore = recentLimitUp5 !== null
    ? clamp(45 + Math.min(Math.max(recentLimitUp5, 0), 2) * 20
      + Math.min(Math.max((recentLimitUp10 ?? recentLimitUp5) - recentLimitUp5, 0), 3) * 5
      - Math.max(recentLimitUp5 - 3, 0) * 12)
    : recentLimitUp10 !== null ? clamp(45 + Math.min(Math.max(recentLimitUp10, 0), 3) * 9) : null;

  const continuation = weightedScore([
    [continuationMove,0.15],[closeScore,0.10],[volumeScore,0.12],
    [trend,0.12],[priorLimitUpScore,0.16],[sector,0.12],
    [flow,0.10],[leader,0.07],[catalyst,0.06]
  ]);
  const breakout = weightedScore([
    [proximityScore,0.18],[volumeScore,0.17],[closeScore,0.12],
    [trend,0.16],[breakoutMove,0.09],[sector,0.13],
    [flow,0.10],[leader,0.03],[catalyst,0.02]
  ]);
  const chosen = (breakout.score ?? -Infinity) > (continuation.score ?? -Infinity)
    ? {...breakout, path:'PREBREAKOUT'}
    : {...continuation, path:'CONTINUATION'};
  let score = chosen.score;
  if (score === null) score = 0;
  const riskFlags = [];
  if (pct !== null && limitPct !== null && pct / limitPct >= 0.78) riskFlags.push('当日涨幅已接近涨停区间，次日高开与追涨风险偏高');
  if (r5 !== null && r5 > 18) riskFlags.push('近5日涨幅偏大，存在短线过热风险');
  if (r3 !== null && r5 !== null && r3 < -3 && r5 < -5) {
    score = Math.max(0, score - 14);
    riskFlags.push('短线趋势仍偏弱，已施加逆势风险扣分');
  }
  if (flow === null) riskFlags.push('资金流证据缺失，不能确认持续流入');
  else if (flow < 45) riskFlags.push('资金证据偏弱');
  if (leader === null) riskFlags.push('题材龙头证据不足');
  if (catalyst !== null && String((row.psychology?.stockNewsFallback ?? row.psychology ?? {}).headlineCatalystDirection ?? '').toLowerCase() === 'negative') {
    score = Math.max(0, score - 8);
    riskFlags.push('检测到负面催化证据，已施加风险扣分');
  }

  const evidenceCount = [
    pct,closeLocation,volumeExpansion,trend,proximityScore,priorLimitUpScore,
    sector,flow,leader,catalyst
  ].filter(value => value !== null && Number.isFinite(value)).length;
  const confidence = clamp(20 + evidenceCount * 7 + Math.min(9, chosen.evidenceWeightPct * 0.09));
  const minScore = 45;
  const passed = failures.length === 0 && score >= minScore;
  const stage = chosen.path === 'CONTINUATION'
    ? 'NEXT_DAY_CONTINUATION_WATCH'
    : 'NEXT_DAY_PREBREAKOUT_WATCH';

  return {
    code,name,board,asOf:row.asOf??null,
    currentPct:pct,
    score:Number(score.toFixed(1)),
    confidence:Number(confidence.toFixed(1)),
    stage,path:chosen.path,passed,
    components:{
      continuationScore:continuation.score===null?null:Number(continuation.score.toFixed(1)),
      prebreakoutScore:breakout.score===null?null:Number(breakout.score.toFixed(1)),
      dailyMove:moveRatio===null?null:Number((clamp(moveRatio*100)).toFixed(1)),
      closeStrength:closeScore===null?null:Number(closeScore.toFixed(1)),
      volumeExpansion:volumeScore===null?null:Number(volumeScore.toFixed(1)),
      shortTrend:trend===null?null:Number(trend.toFixed(1)),
      priorLimitUpActivity:priorLimitUpScore===null?null:Number(priorLimitUpScore.toFixed(1)),
      resistanceProximity:proximityScore===null?null:Number(proximityScore.toFixed(1)),
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
      prebreakoutCount:ranking.filter(row=>row.path==='PREBREAKOUT').length,
      observationOnly:true,
      calibratedProbability:false,
      entrySignal:false
    }
  };
}
