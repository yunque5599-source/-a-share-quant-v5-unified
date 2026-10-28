'use strict';

// A separate continuation lane for stocks that may extend toward a limit-up on
// the next session. This is a heuristic watchlist, not a calibrated probability
// or an entry instruction. It intentionally does not reuse the strict pre-breakout
// entry gate, which can exclude strong first-leg momentum names.

const n = value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value))
  ? null : Number(value);
const clamp = (value, low=0, high=100) => Math.max(low, Math.min(high, Number.isFinite(value) ? value : low));
const avg = values => {
  const xs = values.filter(Number.isFinite);
  return xs.length ? xs.reduce((sum, value) => sum + value, 0) / xs.length : null;
};
const scoreBand = (value, idealLow, idealHigh, outerLow, outerHigh) => {
  if (value === null || outerHigh <= outerLow) return null;
  if (value >= idealLow && value <= idealHigh) return 100;
  if (value < idealLow) return clamp((value - outerLow) / (idealLow - outerLow) * 100);
  return clamp(100 - (value - idealHigh) / (outerHigh - idealHigh) * 100);
};

function inferBoard(code, board) {
  if (board) return String(board);
  const value = String(code ?? '');
  if (/^688|^689/.test(value)) return 'STAR';
  if (/^300|^301/.test(value)) return 'CHINEXT';
  if (/^4|^8|^92/.test(value)) return 'BSE';
  if (/^60/.test(value)) return 'SH_MAIN';
  if (/^00|^001|^002|^003/.test(value)) return 'SZ_MAIN';
  return 'UNKNOWN';
}

function limitPctForBoard(board) {
  if (board === 'CHINEXT' || board === 'STAR') return 20;
  if (board === 'BSE') return 30;
  if (board === 'SH_MAIN' || board === 'SZ_MAIN') return 10;
  return null;
}

function leaderEvidence(row) {
  const leader = row.leaderEvidence ?? {};
  const rank = n(leader.candidateRank);
  const verified = leader.isLeader === true
    || (Boolean(leader.themeName) && (
      String(leader.leaderStatus ?? '').toLowerCase() === 'leader'
      || (rank !== null && rank <= 2)
    ));
  return {
    verified,
    score: verified ? 90
      : rank !== null && rank <= 5 ? 72
        : Boolean(leader.themeName || row.psychology?.primaryTheme) ? 58 : 40,
    themeName: String(leader.themeName ?? row.psychology?.primaryTheme ?? '') || null
  };
}

export function assessLimitUpIgnitionCandidate(row = {}) {
  const code = String(row.code ?? '');
  const name = String(row.name ?? code);
  const board = inferBoard(code, row.board);
  const limitPct = limitPctForBoard(board);
  const pct = n(row.quote?.pct ?? row.currentPct);
  const f = row.features ?? {};
  const c = row.components ?? {};
  const r3 = n(f.r3Pct);
  const r5 = n(f.r5Pct);
  const r10 = n(f.r10Pct);
  const recentLimitUp5 = n(f.recentLimitUp5Count);
  const recentLimitUp10 = n(f.recentLimitUp10Count);
  const closeLocation = n(f.closeLocation);
  const volumeExpansion = n(f.volumeExpansion);
  const sector = avg([n(c.sector), n(c.marketFit)]);
  const flowCount = n(f.flowCount);
  const flowShare = n(f.flowPositiveShare);
  const mainNet5 = n(f.mainNet5);
  const flowObserved = flowCount !== null && flowCount > 0;
  const flow = avg([
    flowObserved && flowShare !== null ? clamp(flowShare * 100) : null,
    flowObserved && mainNet5 !== null ? mainNet5 > 0 ? 82 : mainNet5 === 0 ? 45 : 12 : null,
    n(c.flow)
  ]);
  const leader = leaderEvidence(row);
  const failures = [];

  if (!/^\d{6}$/.test(code) || limitPct === null) failures.push('unsupported-board-or-code');
  if (/^(?:\*?ST|S\*ST|PT|退)/i.test(name) || /退市|终止上市|暂停上市/i.test(name)) failures.push('restricted-listing-name');
  const minMove = limitPct === 10 ? 1.5 : limitPct === 20 ? 3 : limitPct === 30 ? 4.5 : Infinity;
  if (pct === null || pct < minMove) failures.push('daily-move-below-ignition-band');
  if (pct !== null && limitPct !== null && pct >= limitPct - 0.05) failures.push('already-at-daily-limit');
  if (r3 !== null && r5 !== null && r3 < -2 && r5 < -3) failures.push('short-term-trend-negative');

  const moveScore = limitPct === null ? null
    : scoreBand(pct, limitPct * 0.25, limitPct * 0.72, limitPct * 0.10, limitPct * 0.985);
  const closeScore = closeLocation === null ? null : clamp(closeLocation * 100);
  const volumeScore = scoreBand(volumeExpansion, 1.15, 2.4, 0.45, 4.0);
  const trendScore = avg([
    scoreBand(r3, 1.5, 7, -5, 14),
    scoreBand(r5, 2, 14, -8, 25),
    scoreBand(r10, 3, 20, -12, 35)
  ]);
  const priorLimitUpScore = recentLimitUp5 !== null
    ? clamp(48 + Math.min(recentLimitUp5, 2) * 17
      + Math.min(Math.max(0, (recentLimitUp10 ?? recentLimitUp5) - recentLimitUp5), 3) * 5
      - Math.max(0, recentLimitUp5 - 3) * 12)
    : recentLimitUp10 !== null ? clamp(45 + Math.min(recentLimitUp10, 3) * 8) : null;
  const sectorScore = sector === null ? null : clamp(sector);
  const flowScore = flow === null ? null : clamp(flow);
  const leaderScore = leader.score;
  // A recent limit-up is a useful continuation prior, but not a hard requirement:
  // first-time leaders and catalyst-driven breakouts must remain discoverable.
  const scorePieces = [
    [moveScore, 0.18], [closeScore, 0.13], [volumeScore, 0.13],
    [trendScore, 0.17], [sectorScore, 0.13], [flowScore, 0.11],
    [leaderScore, 0.07], [priorLimitUpScore, 0.08]
  ];
  const availablePieces = scorePieces.filter(([value]) => Number.isFinite(value));
  const availableWeight = availablePieces.reduce((sum, [, weight]) => sum + weight, 0);
  const score = clamp(availableWeight > 0
    ? availablePieces.reduce((sum, [value, weight]) => sum + value * weight, 0) / availableWeight
    : 0);
  const evidenceCount = [
    moveScore, closeScore, volumeScore, trendScore,
    sector === null ? null : sectorScore,
    flow === null ? null : flowScore,
    leader.verified || leader.themeName ? leaderScore : null,
    priorLimitUpScore
  ].filter(value => value !== null).length;
  const confidence = clamp(25 + evidenceCount * 9 + (flowCount !== null && flowCount >= 3 ? 8 : 0));
  const trendPositive = (r3 !== null && r3 > 0) || (r5 !== null && r5 > 0);
  const activityPositive = (closeLocation !== null && closeLocation >= 0.68)
    || (volumeExpansion !== null && volumeExpansion >= 1.15);
  if (!trendPositive && !activityPositive) failures.push('no-trend-or-activity-confirmation');
  if (score < 52) failures.push('ignition-score-too-low');

  const passed = failures.length === 0;
  const stage = !passed ? 'REJECTED'
    : score >= 73 && (leader.verified || sectorScore >= 65) && flowScore >= 55
      ? 'LIMIT_UP_FOLLOW_THROUGH_WATCH'
      : score >= 62 ? 'IGNITION_CONTINUATION_WATCH'
        : 'IGNITION_MOMENTUM_OBSERVATION';
  const riskFlags = [];
  if (limitPct !== null && pct !== null && pct >= limitPct * 0.78) riskFlags.push('当日涨幅已高，次日高开和追涨风险增加');
  if (r5 !== null && r5 > 18) riskFlags.push('近5日涨幅较大，注意短线过热');
  if (recentLimitUp5 !== null && recentLimitUp5 >= 2) riskFlags.push('近5个交易日已有多次涨停，延续性增强但分歧与炸板风险也更高');
  if (flow !== null && flow < 45) riskFlags.push('资金证据偏弱或出现流出');
  if (!leader.verified) riskFlags.push('尚未验证为题材核心龙头');
  if (flowCount === null || flowCount < 3) riskFlags.push('历史资金流样本不足');

  return {
    code, name, board, asOf: row.asOf ?? null,
    currentPct: pct,
    score: Number(score.toFixed(1)),
    confidence: Number(confidence.toFixed(1)),
    stage, passed, leaderVerified: leader.verified,
    themeName: leader.themeName,
    components: {
      dailyMove: moveScore === null ? null : Number(moveScore.toFixed(1)),
      closeStrength: closeScore === null ? null : Number(closeScore.toFixed(1)),
      volumeExpansion: volumeScore === null ? null : Number(volumeScore.toFixed(1)),
      shortTrend: trendScore === null ? null : Number(trendScore.toFixed(1)),
      priorLimitUpActivity: priorLimitUpScore === null ? null : Number(priorLimitUpScore.toFixed(1)),
      sectorStrength: Number(sectorScore.toFixed(1)),
      capitalFlow: Number(flowScore.toFixed(1)),
      leaderEvidence: Number(leaderScore.toFixed(1))
    },
    evidence: {
      r3Pct: r3, r5Pct: r5, r10Pct: r10, closeLocation, volumeExpansion,
      recentLimitUp5Count: recentLimitUp5, recentLimitUp10Count: recentLimitUp10,
      priorLimitUpScore: priorLimitUpScore === null ? null : Number(priorLimitUpScore.toFixed(1)),
      flowCount, flowPositiveShare: flowShare, mainNet5,
      sectorScore: sector === null ? null : Number(sector.toFixed(1)),
      leaderVerified: leader.verified
    },
    failedGates: failures,
    riskFlags,
    action: passed ? 'WATCH_NEXT_SESSION_CONFIRMATION' : 'DO_NOT_PROMOTE',
    nextSessionChecklist: [
      '观察开盘后是否有持续承接，避免因大幅高开直接追入',
      '确认所属题材强度及板块内涨停扩散仍然存在',
      '确认成交量和资金行为支持，而非单日脉冲',
      '若快速跌破前一日关键支撑或板块明显退潮，取消观察'
    ],
    method: 'heuristic-continuation-ranking-not-a-calibrated-limit-up-probability'
  };
}

export function rankLimitUpIgnitionCandidates(rows = [], options = {}) {
  const maxResults = Math.max(1, Math.min(50, Number(options.maxResults) || 20));
  const minScore = Number.isFinite(Number(options.minScore)) ? Number(options.minScore) : 52;
  const assessed = (Array.isArray(rows) ? rows : []).map(assessLimitUpIgnitionCandidate);
  const eligible = assessed.filter(row => row.passed && row.score >= minScore)
    .sort((a, b) => b.score - a.score || b.confidence - a.confidence
      || (Number(b.currentPct) || 0) - (Number(a.currentPct) || 0));
  const ranking = eligible.slice(0, maxResults).map((row, index) => ({...row, rank:index + 1}));
  return {
    ranking,
    assessed,
    summary: {
      version:'v13-limitup-ignition-watch-v1',
      assessedCount:assessed.length,
      passedGateCount:eligible.length,
      returnedCount:ranking.length,
      verifiedLeaderCount:ranking.filter(row => row.stage === 'LIMIT_UP_FOLLOW_THROUGH_WATCH').length,
      observationOnly:true,
      calibratedProbability:false,
      entrySignal:false
    }
  };
}
