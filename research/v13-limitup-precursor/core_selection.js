'use strict';

// Four-layer, research-only A-share core-leader selector.
// Strict by design: if policy, leader, sustained flow, relative strength or risk/reward
// cannot be verified, the stock is not promoted into the primary one-click shortlist.
// Scores are ranking heuristics, not calibrated probabilities or trade instructions.

const n = value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const clamp = (value, min=0, max=100) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));

function percentileRanks(rows, getter) {
  const values = (Array.isArray(rows) ? rows : [])
    .map((row, index) => ({ index, code: String(row?.code ?? ''), value: n(getter(row)) }))
    .filter(item => item.code && item.value !== null)
    .sort((a, b) => a.value - b.value);
  const out = new Map();
  if (!values.length) return out;
  if (values.length === 1) {
    out.set(values[0].code, 50);
    return out;
  }
  let start = 0;
  while (start < values.length) {
    let end = start;
    while (end + 1 < values.length && values[end + 1].value === values[start].value) end++;
    const percentile = ((start + end) / 2) / (values.length - 1) * 100;
    for (let i = start; i <= end; i++) out.set(values[i].code, Number(percentile.toFixed(1)));
    start = end + 1;
  }
  return out;
}

function resolveLeaderEvidence(row) {
  const raw = row?.leaderEvidence ?? {};
  const psychology = row?.psychology ?? {};
  const themeName = String(raw.themeName ?? psychology.primaryTheme ?? '').trim();
  const status = String(raw.leaderStatus ?? psychology.leaderStatus ?? '').trim().toLowerCase();
  const candidateRank = n(raw.candidateRank ?? psychology.candidateRank);
  const industryLeaderScore = n(raw.industryLeaderScore);
  const themeHeat = n(raw.themeHeat ?? psychology.emotionHeat);
  let themeBreadth = n(raw.themeBreadth);
  if (themeBreadth !== null && themeBreadth > 1) themeBreadth /= 100;
  const themeLimitUpCount = n(raw.themeLimitUpCount);
  const statusScore = status === 'leader' ? 100 : status === 'core' ? 88 : status === 'front' ? 68 : status === 'follower' ? 35 : null;
  const rankScore = candidateRank === null ? null
    : candidateRank <= 1 ? 100
      : candidateRank <= 2 ? 88
        : candidateRank <= 3 ? 72
          : Math.max(20, 68 - (candidateRank - 3) * 8);
  const hasTheme = Boolean(themeName);
  const directScore = hasTheme ? Math.max(statusScore ?? 0, rankScore ?? 0) : null;
  const proxyConfirmed = industryLeaderScore !== null && industryLeaderScore >= 90
    && themeHeat !== null && themeHeat >= 70
    && themeBreadth !== null && themeBreadth >= 0.60
    && themeLimitUpCount !== null && themeLimitUpCount >= 2;
  const score = directScore !== null && directScore > 0 ? directScore
    : proxyConfirmed ? clamp(0.55 * industryLeaderScore + 0.25 * themeHeat + 0.20 * themeBreadth * 100)
      : industryLeaderScore ?? 35;
  const explicitLeader = hasTheme && (status === 'leader'
    || (status === 'core' && (candidateRank === null || candidateRank <= 3))
    || (candidateRank !== null && candidateRank <= 2));
  const isLeader = explicitLeader || proxyConfirmed;
  const label = explicitLeader
    ? (status === 'leader' || candidateRank === 1 ? '题材龙头' : '题材核心/前排')
    : proxyConfirmed ? '行业强势且题材共振（代理证据）' : '龙头证据不足';
  const source = explicitLeader ? 'theme-leadership-metadata'
    : proxyConfirmed ? 'industry-relative-strength-plus-theme-confirmation'
      : industryLeaderScore !== null ? 'industry-cross-sectional-proxy-only' : 'leader-evidence-unavailable';
  return {
    themeName: themeName || null,
    leaderStatus: status || null,
    candidateRank,
    industryLeaderScore,
    themeHeat,
    themeBreadth,
    themeLimitUpCount,
    score: Number(clamp(score).toFixed(1)),
    isLeader,
    label,
    source,
    proxyConfirmed
  };
}

function estimateRiskReward(row, values, marketRegime, leaderEvidence) {
  const { currentPct, r3Pct, r5Pct, distHigh20Pct, atrProxyPct, closeLocation, gapPct } = values;
  const psychology = row?.psychology ?? {};
  const stockNews = psychology.stockNewsFallback ?? psychology;
  const positiveNews = n(stockNews.positiveHeadlineCount) ?? 0;
  const negativeNews = n(stockNews.negativeHeadlineCount) ?? 0;

  const stopDistancePct = atrProxyPct !== null && atrProxyPct > 0
    ? clamp(atrProxyPct * 1.35, 3, 6.5)
    : null;
  const continuationRoom = clamp(
    3.5 + 0.16 * Math.max(0, r5Pct ?? 0) + 0.02 * Math.max(0, leaderEvidence.score - 70),
    3.5, 8.5
  );
  const roomToRecentHigh = distHigh20Pct !== null && distHigh20Pct < 0
    ? Math.min(12, Math.max(0, -distHigh20Pct))
    : 0;
  const targetPotentialPct = Math.max(continuationRoom, roomToRecentHigh);
  const rewardRiskRatio = stopDistancePct !== null && stopDistancePct > 0
    ? targetPotentialPct / stopDistancePct
    : null;

  let overnightRiskScore = 10;
  if (currentPct !== null && currentPct > 7.5) overnightRiskScore += 35;
  else if (currentPct !== null && currentPct > 6.5) overnightRiskScore += 28;
  else if (currentPct !== null && currentPct > 4.5) overnightRiskScore += 16;
  else if (currentPct !== null && currentPct > 3.5) overnightRiskScore += 8;
  if (gapPct !== null && gapPct > 5) overnightRiskScore += 25;
  else if (gapPct !== null && gapPct > 3) overnightRiskScore += 15;
  if (atrProxyPct !== null && atrProxyPct > 6) overnightRiskScore += 22;
  else if (atrProxyPct !== null && atrProxyPct > 4.5) overnightRiskScore += 12;
  if (closeLocation !== null && closeLocation < 0.25) overnightRiskScore += 15;
  else if (closeLocation !== null && closeLocation < 0.40) overnightRiskScore += 8;
  if (negativeNews > positiveNews && negativeNews > 0) overnightRiskScore += 20;
  if (String(marketRegime?.regime ?? 'neutral') === 'risk-off') overnightRiskScore += 8;
  overnightRiskScore = clamp(overnightRiskScore);

  return {
    targetPotentialPct: Number(targetPotentialPct.toFixed(2)),
    stopDistancePct: stopDistancePct === null ? null : Number(stopDistancePct.toFixed(2)),
    rewardRiskRatio: rewardRiskRatio === null ? null : Number(rewardRiskRatio.toFixed(2)),
    overnightRiskScore: Number(overnightRiskScore.toFixed(1)),
    overnightRiskLabel: overnightRiskScore >= 55 ? '偏高'
      : overnightRiskScore >= 35 ? '中等' : '相对可控',
    method: 'heuristic-range-and-volatility-proxy-not-a-calibrated-return-forecast'
  };
}

export function assessCoreSelectionCandidate(row = {}, options = {}) {
  const components = row?.components ?? {};
  const features = row?.features ?? {};
  const policy = row?.policyAlignment ?? {};
  const marketRegime = row?.marketRegime ?? options.marketRegime ?? { regime: 'neutral' };
  const regime = String(marketRegime?.regime ?? 'neutral');
  const riskOff = regime === 'risk-off';
  const relativeStrengthPercentile = n(options.relativeStrengthPercentile);
  const currentPct = n(row?.quote?.pct) ?? n(row?.currentPct);
  const r3Pct = n(features.r3Pct);
  const r5Pct = n(features.r5Pct);
  const distHigh20Pct = n(features.distHigh20Pct);
  const atrProxyPct = n(features.atrProxyPct);
  const closeLocation = n(features.closeLocation);
  const gapPct = n(features.gapPct);
  const flowCount = n(features.flowCount) ?? n(row?.source?.historicalFlowCount) ?? 0;
  const mainNet5 = n(features.mainNet5);
  const mainFlowRatioPct = n(features.mainFlowRatioPct);
  const flowPositiveShare = n(features.flowPositiveShare);
  const amount5Avg = n(features.amount5Avg) ?? n(features.amount) ?? n(row?.quote?.amount);
  const turnoverRate = n(features.turnoverRate) ?? n(row?.quote?.turnoverRate);
  const modelScore = n(row?.score) ?? 0;
  const policyScore = n(components.policyAlignment) ?? n(policy.score);
  const trendScore = n(components.trend);
  const volumePriceScore = n(components.volumePrice);
  const flowScore = n(components.flow);
  const sectorScore = n(components.sector);
  const marketFitScore = n(components.marketFit);
  const confidence = n(row?.confidence) ?? 0;
  const barCount = n(row?.source?.barCount) ?? n(features.barCount) ?? 0;
  const leaderEvidence = resolveLeaderEvidence(row);
  const riskReward = estimateRiskReward(row, {
    currentPct, r3Pct, r5Pct, distHigh20Pct, atrProxyPct, closeLocation, gapPct
  }, marketRegime, leaderEvidence);

  const thresholds = {
    score: riskOff ? 68 : 64,
    policyScore: 70,
    trend: riskOff ? 62 : 55,
    volumePrice: 55,
    flow: riskOff ? 65 : 58,
    sector: 55,
    marketFit: riskOff ? 62 : 55,
    relativeStrengthPercentile: riskOff ? 85 : 75,
    rewardRiskRatio: 1.25,
    currentPctMax: 6.5,
    amount5AvgMin: 50000000,
    confidence: 60,
    barCount: 25,
    flowCount: 3
  };
  const passedGates = [];
  const failedGates = [];
  const gate = (key, pass, reason) => {
    if (pass) passedGates.push(key);
    else failedGates.push({ key, reason });
  };
  const eligibleCodes = options.eligibleCodes instanceof Set ? options.eligibleCodes
    : Array.isArray(options.eligibleCodes) ? new Set(options.eligibleCodes.map(String)) : null;
  const code = String(row?.code ?? '');
  gate('pre-limit-up-risk-filter', !eligibleCodes || eligibleCodes.has(code),
    '未通过前瞻过热过滤（涨幅、近5日涨幅、距20日高点或启动阶段不合适）');
  gate('policy-direction', policy.evidenceAvailable === true && policy.catalogStale !== true
    && policyScore !== null && policyScore >= thresholds.policyScore,
    policy.catalogStale === true ? '政策目录超过14天未复核，政策证据暂不作为核心入选依据'
      : policy.evidenceAvailable !== true ? '没有可验证的国家政策/产业方向匹配'
        : '政策匹配分低于核心门槛');
  gate('trend', trendScore !== null && trendScore >= thresholds.trend,
    '趋势强度不足，未确认短线趋势向上');
  gate('volume-price', volumePriceScore !== null && volumePriceScore >= thresholds.volumePrice,
    '量价结构未确认，缺少有效放量/价格配合');
  gate('relative-strength', relativeStrengthPercentile !== null
    && relativeStrengthPercentile >= thresholds.relativeStrengthPercentile
    && r5Pct !== null && r5Pct >= 0 && r3Pct !== null && r3Pct >= -1.5,
    '相对强度不在候选池前列，或近3/5日趋势尚未确认');
  gate('theme-leader', leaderEvidence.isLeader,
    '没有可靠的题材龙头/核心前排证据；仅行业涨幅靠前不足以认定龙头');
  gate('sustained-capital-flow', flowScore !== null && flowScore >= thresholds.flow
    && flowCount >= thresholds.flowCount && mainNet5 !== null && mainNet5 > 0
    && mainFlowRatioPct !== null && mainFlowRatioPct > 0
    && flowPositiveShare !== null && flowPositiveShare >= 0.4,
    '近5日主力资金净流入、净流入占比或持续性未同时通过验证');
  gate('sector-confirmation', sectorScore !== null && sectorScore >= thresholds.sector,
    '行业/题材强度不足，板块共振尚未确认');
  gate('market-regime', marketFitScore !== null && marketFitScore >= thresholds.marketFit
    && Boolean(marketRegime?.label),
    riskOff ? '弱市环境下市场适配分未达到更严格门槛' : '市场环境适配度不足或环境数据缺失');
  gate('risk-reward', riskReward.rewardRiskRatio !== null
    && riskReward.rewardRiskRatio >= thresholds.rewardRiskRatio
    && riskReward.stopDistancePct !== null && riskReward.stopDistancePct <= 6.5,
    '短线空间/止损距离不匹配，预估收益风险比低于1.25或止损距离过大');
  gate('overnight-risk', riskReward.overnightRiskScore < 55,
    '隔夜/追高风险过高，宁可等待或放弃');
  gate('chase-control', currentPct !== null && currentPct <= thresholds.currentPctMax
    && (r5Pct === null || r5Pct <= 25)
    && (distHigh20Pct === null || distHigh20Pct <= 18),
    '当日涨幅或近阶段涨幅过热，不追高');
  gate('liquidity', amount5Avg !== null && amount5Avg >= thresholds.amount5AvgMin
    && (turnoverRate === null || (turnoverRate >= 0.5 && turnoverRate <= 25)),
    '近阶段成交额或换手率不满足短线流动性要求');
  gate('data-confidence', confidence >= thresholds.confidence && barCount >= thresholds.barCount,
    '历史K线/资金/行业数据覆盖不足，无法把该股列为高置信度核心候选');
  gate('overall-score', modelScore >= thresholds.score,
    '综合模型分未达到核心入选门槛');

  const eligible = failedGates.length === 0;
  const rrScore = riskReward.rewardRiskRatio === null ? 0 : clamp(riskReward.rewardRiskRatio / 2 * 100);
  const selectionScore = clamp(
    0.35 * modelScore
    + 0.15 * (policyScore ?? 0)
    + 0.15 * leaderEvidence.score
    + 0.12 * (relativeStrengthPercentile ?? 0)
    + 0.10 * (flowScore ?? 0)
    + 0.08 * (marketFitScore ?? 0)
    + 0.05 * rrScore
    - (riskOff ? 3 : 0)
  );
  const dataLimited = !String(marketRegime?.dataQuality ?? '').includes('broad-quote-proxy');
  const decision = !eligible ? 'NO_TRADE'
    : dataLimited ? 'OBSERVE_DATA_LIMITED'
      : riskOff ? 'DEFENSIVE_OBSERVE'
        : (currentPct !== null && currentPct > 4.5) || (closeLocation !== null && closeLocation < 0.45)
          ? 'WAIT_PULLBACK' : 'CORE_WATCH';
  const decisionLabel = decision === 'NO_TRADE' ? '未通过四层硬门槛'
    : decision === 'OBSERVE_DATA_LIMITED' ? '核心条件满足·市场数据有限，仅观察'
      : decision === 'DEFENSIVE_OBSERVE' ? '弱市强势龙头·谨慎观察'
        : decision === 'WAIT_PULLBACK' ? '核心龙头·等待回踩/买点确认'
          : '核心龙头·等待交易确认';

  return {
    ...row,
    selectionScore: Number(selectionScore.toFixed(2)),
    relativeStrengthPercentile,
    leaderEvidence,
    riskReward,
    selection: {
      eligible,
      gateStatus: eligible ? 'PASS' : 'REJECT',
      decision,
      decisionLabel,
      passedGates,
      failedGates,
      failureReasons: failedGates.map(item => item.reason),
      thresholds,
      method: 'four-layer-strict-core-leader-selection-v1'
    }
  };
}

export function rankCoreSelection(rows, options = {}) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const eligibleCodes = options.eligibleCodes instanceof Set ? options.eligibleCodes
    : Array.isArray(options.eligibleCodes) ? new Set(options.eligibleCodes.map(String)) : null;
  // Compare relative strength only against candidates that passed the upstream pre-limit-up/overheat filter.
  // Otherwise already-extended stocks can consume the strongest percentiles and suppress earlier setups.
  const relativeRankUniverse = eligibleCodes
    ? sourceRows.filter(row => eligibleCodes.has(String(row?.code ?? '')))
    : sourceRows;
  const relativeRanks = percentileRanks(relativeRankUniverse, row => row?.features?.r5Pct);
  const assessed = sourceRows.map(row => assessCoreSelectionCandidate(row, {
    ...options,
    relativeStrengthPercentile: relativeRanks.get(String(row?.code ?? '')) ?? null
  }));
  const ranked = assessed.sort((a, b) =>
    (b.selectionScore - a.selectionScore)
    || ((n(b.components?.flow) ?? 0) - (n(a.components?.flow) ?? 0))
    || ((n(b.components?.trend) ?? 0) - (n(a.components?.trend) ?? 0))
  );
  const eligible = ranked.filter(row => row.selection?.eligible === true);
  const rejectionCounts = {};
  for (const row of ranked) {
    for (const item of row.selection?.failedGates ?? []) rejectionCounts[item.key] = (rejectionCounts[item.key] ?? 0) + 1;
  }
  const marketRegime = options.marketRegime ?? sourceRows[0]?.marketRegime ?? {};
  const maxResults = Math.max(1, Math.min(10, Number(options.maxResults) || 5));
  const ranking = eligible.slice(0, maxResults).map((row, index) => ({ ...row, rank: index + 1 }));
  const summary = {
    version: 'four-layer-strict-core-leader-selection-v1',
    assessedCount: ranked.length,
    eligibleCount: eligible.length,
    returnedCount: ranking.length,
    leaderQualifiedCount: ranked.filter(row => row.selection?.passedGates?.includes('theme-leader')).length,
    policyQualifiedCount: ranked.filter(row => row.selection?.passedGates?.includes('policy-direction')).length,
    policyFlowQualifiedCount: ranked.filter(row => row.selection?.passedGates?.includes('policy-direction')
      && row.selection?.passedGates?.includes('sustained-capital-flow')).length,
    riskRewardQualifiedCount: ranked.filter(row => row.selection?.passedGates?.includes('risk-reward')).length,
    marketRegime: marketRegime?.label ?? '市场环境未知',
    marketRegimeCode: marketRegime?.regime ?? 'neutral',
    marketDataQuality: marketRegime?.dataQuality ?? 'unavailable',
    rejectionCounts,
    emptyListPolicy: 'never-fill-shortlist-with-failed-candidates'
  };
  return { ranking, assessed: ranked, summary };
}
