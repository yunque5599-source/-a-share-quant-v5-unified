'use strict';

// V13 pre-breakout watch lane. This ranks compressed, strengthening bases near resistance;
// it is not a calibrated probability, a buy signal, or a substitute for point-in-time evidence.

const n = value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const clamp = (value, low=0, high=100) => Math.max(low, Math.min(high, Number.isFinite(value) ? value : low));
const avg = values => {
  const xs = values.filter(Number.isFinite);
  return xs.length ? xs.reduce((sum, value) => sum + value, 0) / xs.length : null;
};
const scoreBand = (value, idealLow, idealHigh, outerLow, outerHigh) => {
  if (value === null) return null;
  if (value >= idealLow && value <= idealHigh) return 100;
  if (value < idealLow) return clamp((value - outerLow) / (idealLow - outerLow) * 100);
  return clamp(100 - (value - idealHigh) / (outerHigh - idealHigh) * 100);
};

function mainBoard(code, board) {
  const inferred = /^60\d{4}$/.test(String(code)) ? 'SH_MAIN'
    : /^00\d{4}$/.test(String(code)) ? 'SZ_MAIN' : '';
  return Boolean(inferred) && (!board || board === inferred);
}

export function assessPreBreakoutCandidate(row = {}, earlyOpportunity = null) {
  const f = row.features ?? {};
  const c = row.components ?? {};
  const metrics = earlyOpportunity?.metrics ?? row.earlyOpportunity?.metrics ?? {};
  const earlyComponents = earlyOpportunity?.components ?? row.earlyOpportunity?.components ?? {};
  const code = String(row.code ?? '');
  const board = String(row.board ?? '');
  const currentPct = n(row.quote?.pct ?? row.currentPct);
  const r3 = n(f.r3Pct ?? metrics.return3dPct);
  const r5 = n(f.r5Pct ?? metrics.return5dPct);
  const r20 = n(f.r20Pct ?? metrics.return20dPct);
  const distHigh = n(f.distHigh20Pct);
  const distMa20 = n(metrics.distanceMa20Pct);
  const range10 = n(metrics.range10dPct);
  const compression = n(metrics.volatilityCompressionRatio);
  const flowPositiveShare = n(f.flowPositiveShare);
  const mainNet5 = n(f.mainNet5);
  const mainFlowRatioPct = n(f.mainFlowRatioPct);
  const flowCount = n(f.flowCount ?? row.source?.historicalFlowCount);
  const trend = n(c.trend);
  const sector = n(c.sector);
  const marketFit = n(c.marketFit);
  const policyScore = row.policyAlignment?.evidenceAvailable === true && row.policyAlignment?.catalogStale !== true
    ? n(row.policyAlignment?.score ?? c.policyAlignment) : null;
  const leader = row.leaderEvidence ?? {};
  const leaderVerified = leader.isLeader === true
    || (String(leader.leaderStatus ?? '').toLowerCase() === 'leader' && Boolean(leader.themeName));
  const leaderScore = leaderVerified ? n(leader.score ?? leader.industryLeaderScore) : null;
  const bars = n(row.source?.barCount ?? f.barCount);

  const failedGates = [];
  if (!mainBoard(code, board)) failedGates.push('not-verified-main-board');
  if (bars === null || bars < 25) failedGates.push('insufficient-price-history');
  if (currentPct !== null && currentPct >= 6.5) failedGates.push('intraday-move-too-extended');
  if (r5 !== null && r5 > 15) failedGates.push('five-day-move-too-extended');
  if (r20 !== null && r20 < -15) failedGates.push('persistent-downtrend-risk');
  if (distHigh !== null && (distHigh > 0.5 || distHigh < -15)) failedGates.push('not-near-breakout-resistance');
  if (distMa20 !== null && distMa20 < -4) failedGates.push('below-medium-term-trend');
  if (earlyOpportunity?.stage === 'downtrend-risk' || earlyOpportunity?.stage === 'extended') {
    failedGates.push('early-opportunity-risk-stage');
  }

  const resistanceScore = distHigh === null ? null : scoreBand(-distHigh, 1, 7, -0.5, 16);
  const basePieces = [
    range10 === null ? null : scoreBand(range10, 2, 8, 0.5, 18),
    compression === null ? null : scoreBand(compression, 0.35, 0.80, 0.15, 1.8),
    n(earlyComponents.baseQuality)
  ].filter(value => value !== null);
  const baseScore = avg(basePieces);
  const trendPieces = [
    trend,
    r3 === null ? null : scoreBand(r3, 0.2, 3.5, -5, 9),
    r5 === null ? null : scoreBand(r5, 0, 8, -10, 18),
    distMa20 === null ? null : scoreBand(distMa20, 0, 5, -8, 14)
  ].filter(value => value !== null);
  const trendScore = avg(trendPieces);
  const flowPieces = [
    flowPositiveShare === null ? null : clamp(flowPositiveShare * 100),
    mainNet5 === null ? null : mainNet5 > 0 ? 80 : mainNet5 === 0 ? 45 : 10,
    mainFlowRatioPct === null ? null : scoreBand(mainFlowRatioPct, 0.15, 2.0, -2.5, 5),
    n(c.flow)
  ].filter(value => value !== null);
  const flowScore = avg(flowPieces);
  const sectorScore = avg([sector, marketFit]);
  const policyComponent = policyScore === null ? 35 : clamp(policyScore);
  const leaderComponent = leaderScore === null ? 35 : clamp(leaderScore);
  const currentMoveSafety = currentPct === null ? 55
    : currentPct <= 2.5 ? 100
      : currentPct <= 4 ? 82
        : currentPct <= 5.5 ? 58 : 20;

  const weighted = [
    [resistanceScore, 0.20], [baseScore, 0.20], [trendScore, 0.15],
    [flowScore, 0.20], [sectorScore, 0.10], [policyComponent, 0.075],
    [leaderComponent, 0.075], [currentMoveSafety, 0.025]
  ];
  const score = Number(weighted.reduce((sum, [value, weight]) => sum + (value ?? 35) * weight, 0).toFixed(1));
  const evidenceCount = [resistanceScore, baseScore, trendScore, flowScore, sectorScore,
    policyScore, leaderScore].filter(value => value !== null).length;
  const confidence = Number((evidenceCount / 7 * Math.min(1, (bars ?? 0) / 40)
    * (flowCount !== null && flowCount >= 3 ? 1 : 0.75)).toFixed(2));
  const passed = failedGates.length === 0;
  const confirmedLeader = leaderVerified && policyScore !== null && policyScore >= 65
    && flowScore !== null && flowScore >= 55 && sectorScore !== null && sectorScore >= 55;
  const stage = !passed ? 'REJECTED'
    : score >= 72 && confirmedLeader ? 'PREBREAKOUT_LEADER_WATCH'
      : score >= 65 ? 'PREBREAKOUT_SETUP_WATCH' : 'BASE_FORMING_OBSERVATION';

  return {
    code, name: String(row.name ?? code), board,
    score, confidence, stage, passed,
    leaderVerified, policyVerified: policyScore !== null,
    themeName: String(leader.themeName ?? row.psychology?.primaryTheme ?? '') || null,
    asOf: String(row.asOf ?? f.asOf ?? ''),
    components: {
      resistance: resistanceScore === null ? null : Number(resistanceScore.toFixed(1)),
      baseCompression: baseScore === null ? null : Number(baseScore.toFixed(1)),
      trendTurn: trendScore === null ? null : Number(trendScore.toFixed(1)),
      capitalAccumulation: flowScore === null ? null : Number(flowScore.toFixed(1)),
      sectorStrength: sectorScore === null ? null : Number(sectorScore.toFixed(1)),
      policyAlignment: policyScore === null ? null : Number(policyScore.toFixed(1)),
      themeLeader: leaderScore === null ? null : Number(leaderScore.toFixed(1)),
      chaseSafety: Number(currentMoveSafety.toFixed(1))
    },
    metrics: {
      currentPct, r3Pct:r3, r5Pct:r5, r20Pct:r20,
      distHigh20Pct:distHigh, distanceMa20Pct:distMa20,
      range10dPct:range10, volatilityCompressionRatio:compression,
      flowPositiveShare, mainNet5, mainFlowRatioPct, flowCount, barCount:bars
    },
    passedGates: passed ? ['main-board','history','not-extended','near-resistance','trend-risk-check'] : [],
    failedGates,
    interpretation: stage === 'PREBREAKOUT_LEADER_WATCH'
      ? '结构、趋势、资金、政策和龙头证据均达到观察门槛；等待放量确认，不构成买入指令'
      : stage === 'PREBREAKOUT_SETUP_WATCH'
        ? '存在临近压力位的蓄势结构，但政策或龙头证据尚未全部确认'
        : passed
          ? '继续观察结构演变，不列为优先启动候选'
          : '未通过启动前观察门槛',
    method:'heuristic-pre-breakout-watch-score-not-a-calibrated-probability'
  };
}

export function rankPreBreakoutCandidates(rows = [], earlyByCode = new Map(), options = {}) {
  const maxResults = Math.max(1, Math.min(30, Number(options.maxResults) || 15));
  const assessed = (Array.isArray(rows) ? rows : []).map(row => {
    const early = earlyByCode instanceof Map ? earlyByCode.get(String(row.code ?? '')) : null;
    return assessPreBreakoutCandidate(row, early);
  });
  const ranking = assessed.filter(row => row.passed && row.score >= (Number(options.minScore) || 60))
    .sort((a,b) => b.score - a.score || b.confidence - a.confidence)
    .slice(0,maxResults)
    .map((row,index) => ({...row,rank:index+1}));
  return {
    ranking,
    assessed,
    summary:{
      version:'v13-pre-breakout-watch-v1',
      assessedCount:assessed.length,
      passedGateCount:assessed.filter(row=>row.passed).length,
      returnedCount:ranking.length,
      verifiedLeaderCount:ranking.filter(row=>row.stage==='PREBREAKOUT_LEADER_WATCH').length,
      unverifiedLeaderCount:ranking.filter(row=>!row.leaderVerified).length,
      policyVerifiedCount:ranking.filter(row=>row.policyVerified).length,
      emptyListPolicy:'never-fill-watchlist-with-failed-or-extended-candidates'
    }
  };
}
