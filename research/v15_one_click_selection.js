const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const n = value => finite(value) ? Number(value) : null;
const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
const mean = values => {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
};
const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const laneLabels = Object.freeze({
  'early-breakout': '趋势/突破观察',
  'limit-up-approach': '涨停前强度观察',
  'capital-flow': '资金异动观察',
  'reversal-watch': '超跌反转观察',
  'low-turnover-breakout': '低换手突破观察',
  'industry-strength': '行业共振观察',
  'sector-leader-proxy': '行业领涨代理观察',
  'liquidity-volume': '成交活跃观察'
});
const laneOrder = Object.keys(laneLabels);

function rankTable(rows, field) {
  return rows.map(row => n(row[field])).filter(value => value !== null).sort((a, b) => a - b);
}
function percentile(value, sorted) {
  if (value === null || !sorted.length) return null;
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  let upper = lo;
  hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  const lower = upper;
  const lastEqual = lo - 1;
  const averageIndex = (lower + lastEqual) / 2;
  return sorted.length === 1 ? 50 : clamp(averageIndex / (sorted.length - 1) * 100);
}
function limitPctForCode(code) {
  const value = String(code ?? '');
  if (/^(300|301|688|689)/.test(value)) return 20;
  if (/^(4|8|92)/.test(value)) return 30;
  return 10;
}
function isValidObservationRow(row) {
  const code = String(row?.code ?? '');
  const name = String(row?.name ?? '');
  // Match the production execution universe: Shanghai/Shenzhen main board only.
  // ChiNext, STAR Market, Beijing Stock Exchange, ST and delisting-risk names
  // must not enter the observation funnel either.
  return /^(00|60)\d{4}$/.test(code)
    && !/(?:ST|退)/i.test(name)
    && finite(row?.price) && Number(row.price) > 0
    && finite(row?.amount) && Number(row.amount) >= 0
    && finite(row?.pct);
}
function makeIndustryStats(rows) {
  const groups = new Map();
  for (const row of rows) {
    const industry = String(row?.industry ?? '').trim();
    if (!industry || industry === '未知' || industry === '-') continue;
    if (!groups.has(industry)) groups.set(industry, []);
    groups.get(industry).push(row);
  }
  const result = new Map();
  for (const [industry, industryRows] of groups) {
    const returns = industryRows.map(row => n(row.pct)).filter(value => value !== null);
    const breadth = returns.filter(value => value > 0).length / Math.max(1, returns.length);
    const strongShare = returns.filter(value => value >= 3).length / Math.max(1, returns.length);
    const nearLimitShare = industryRows.filter(row => {
      const pct = n(row.pct);
      return pct !== null && pct >= limitPctForCode(row.code) * 0.85;
    }).length / Math.max(1, industryRows.length);
    const flowEvidence = industryRows.map(row => {
      const mainNet = n(row.mainNet), mainPct = n(row.mainPct);
      if (mainNet === null && mainPct === null) return null;
      return (mainNet !== null && mainNet > 0) || (mainPct !== null && mainPct > 0);
    }).filter(value => value !== null);
    const flowBreadth = flowEvidence.length
      ? flowEvidence.filter(Boolean).length / flowEvidence.length
      : 0.5;
    const medianPct = median(returns) ?? 0;
    const leaderPct = returns.length ? Math.max(...returns) : 0;
    const sortedIndustryReturns = returns.slice().sort((a,b)=>a-b);
    const returnRankByCode = new Map();
    for (const row of industryRows) {
      const rowPct = n(row.pct);
      if (rowPct !== null) returnRankByCode.set(String(row.code), percentile(rowPct, sortedIndustryReturns) ?? 50);
    }
    // These are candidate-pool proxies, not complete-industry breadth statistics.
    const score = clamp(
      45 + medianPct * 2 + (breadth - 0.5) * 20 + strongShare * 15
      + nearLimitShare * 15 + (flowBreadth - 0.5) * 15
      + Math.min(Math.max(leaderPct, 0), 10) * 0.7
    );
    result.set(industry, {
      industry,
      count: returns.length,
      breadth,
      strongShare,
      nearLimitShare,
      flowBreadth,
      medianPct,
      leaderPct,
      returnRankByCode,
      score
    });
  }
  return result;
}
function makeObservationContext(rows) {
  const valid = rows.filter(row => n(row.pct) !== null);
  const count = valid.length;
  const upRatio = valid.filter(row => Number(row.pct) > 0).length / Math.max(1, count);
  const strongShare = valid.filter(row => Number(row.pct) >= 3).length / Math.max(1, count);
  const nearLimitShare = valid.filter(row => Number(row.pct) >= limitPctForCode(row.code) * 0.85).length / Math.max(1, count);
  const flowRows = valid.filter(row => n(row.mainNet) !== null || n(row.mainPct) !== null);
  const positiveFlowShare = flowRows.length
    ? flowRows.filter(row => (n(row.mainNet) !== null && n(row.mainNet) > 0) || (n(row.mainPct) !== null && n(row.mainPct) > 0)).length / flowRows.length
    : 0.5;
  const score = clamp(45 + (upRatio - 0.5) * 35 + (strongShare - 0.15) * 45 + nearLimitShare * 75 + (positiveFlowShare - 0.5) * 25);
  const label = score >= 70 ? '情绪升温' : score >= 58 ? '偏强' : score >= 43 ? '分化' : '偏弱';
  return {
    count, upRatio, strongShare, nearLimitShare, positiveFlowShare,
    score:Number(score.toFixed(1)), label,
    scope:'observed-candidate-pool-not-full-market'
  };
}
function candidateReasons(laneScores, flowPositive, industryStats, row) {
  const reasons = [];
  if (laneScores['early-breakout'] !== undefined) reasons.push('趋势或突破类信号命中；仍需通过历史K线核验结构');
  if (laneScores['limit-up-approach'] !== undefined) reasons.push('涨幅已进入本板块日涨停幅度的观察区间，尚非涨停前预测证明');
  if (laneScores['capital-flow'] !== undefined) reasons.push('当前资金流指标为正；需核验来源、时间戳和持续性');
  if (laneScores['reversal-watch'] !== undefined) reasons.push('中期回撤背景下出现当日资金转强，仍需防范持续下跌');
  if (laneScores['low-turnover-breakout'] !== undefined) reasons.push('低换手与正向价格/资金信号组合');
  if (laneScores['industry-strength'] !== undefined) reasons.push('所属行业截面表现偏强；不等同于题材催化确认');
  if (laneScores['sector-leader-proxy'] !== undefined) reasons.push('行业内相对领涨代理：综合价格强度、成交、资金与行业共振；不是已验证的题材龙头识别');
  if (laneScores['liquidity-volume'] !== undefined) reasons.push('成交活跃度较高，便于进一步核验量价结构');
  if (row?.independentDiscovery) {
    const factors = Array.isArray(row.discoveryFactors) ? row.discoveryFactors.join('/') : '';
    reasons.push('独立主板多因子观察源命中' + (factors ? '：' + factors : ''));
  }
  if (!flowPositive) reasons.push('未确认正向资金证据');
  const industry = industryStats.get(String(row?.industry ?? ''));
  if (industry && industry.count >= 5) {
    reasons.push(
      '行业观察样本 ' + industry.count + ' 只，上涨宽度 ' + Math.round(industry.breadth * 100)
      + '%，强势股 ' + Math.round(industry.strongShare * 100)
      + '%，涨停幅度附近 ' + Math.round(industry.nearLimitShare * 100)
      + '%，正向资金 ' + Math.round(industry.flowBreadth * 100) + '%'
    );
  }
  // Keep the scarce explanatory slots focused on leader/sector evidence before generic lane labels.
  const priority = reasons.filter(reason =>
    reason.includes('行业内相对领涨代理')
    || reason.includes('行业观察样本')
    || reason.includes('独立主板多因子观察源')
  );
  const remaining = reasons.filter(reason => !priority.includes(reason));
  return [...priority, ...remaining];
}

export function evaluateRankingFreshness({
  generatedAt,
  quoteAts = [],
  nowMs = Date.now(),
  maxSourceAgeMs = 180000,
  minFreshQuoteRatio = 0.65,
  sourceComplete = true,
  requireFreshQuotes = true
} = {}) {
  const generatedMs = Date.parse(generatedAt ?? '');
  const sourceAgeMs = Number.isFinite(generatedMs) ? nowMs - generatedMs : null;
  const dateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit'
  });
  const today = dateFormatter.format(new Date(nowMs));
  const freshCount = (Array.isArray(quoteAts) ? quoteAts : []).filter(value => {
    const timestamp = Date.parse(value ?? '');
    if (!Number.isFinite(timestamp)) return false;
    const date = dateFormatter.format(new Date(timestamp));
    const lag = (nowMs - timestamp) / 1000;
    return date === today && lag >= -60 && lag <= 180;
  }).length;
  const totalQuoteRows = Array.isArray(quoteAts) ? quoteAts.length : 0;
  const quoteFreshRatio = freshCount / Math.max(1, totalQuoteRows);
  const reasons = [];
  if (!Number.isFinite(generatedMs)) reasons.push('ranking-source-timestamp-missing');
  else if (sourceAgeMs < -60000) reasons.push('ranking-source-timestamp-in-future');
  else if (sourceAgeMs > maxSourceAgeMs) reasons.push('ranking-source-older-than-limit');
  if (!sourceComplete) reasons.push('ranking-source-incomplete');
  if (requireFreshQuotes && quoteFreshRatio < minFreshQuoteRatio) reasons.push('fresh-quote-coverage-below-threshold');
  return {
    blocked:reasons.length > 0,
    reasons,
    sourceAgeMs,
    sourceAgeMin:Number.isFinite(sourceAgeMs) ? Math.max(0, sourceAgeMs / 60000) : null,
    freshQuoteCount:freshCount,
    quoteRowCount:totalQuoteRows,
    quoteFreshRatio,
    sourceComplete:!!sourceComplete,
    requireFreshQuotes:!!requireFreshQuotes
  };
}

/**
 * Build a diversified, observation-only shortlist from the ranked universe.
 * Scores are heuristic ranking aids, not calibrated probabilities or buy signals.
 */
export function selectObservationCandidates(rows = [], {
  excludeCodes = [],
  limit = 5,
  supplemental = []
} = {}) {
  const raw = Array.isArray(rows) ? rows.filter(isValidObservationRow) : [];
  const excluded = new Set(Array.from(excludeCodes ?? [], code => String(code)));
  const industries = makeIndustryStats(raw);
  const tables = {
    amount: rankTable(raw, 'amount'),
    pct: rankTable(raw, 'pct'),
    mainNet: rankTable(raw, 'mainNet'),
    mainPct: rankTable(raw, 'mainPct'),
    rankScore: rankTable(raw, 'rankScore')
  };
  const scored = new Map();

  for (const row of raw) {
    const code = String(row.code);
    const pct = n(row.pct);
    const pct60 = n(row.pct60);
    const amount = n(row.amount);
    const turn = n(row.turn);
    const mainNet = n(row.mainNet);
    const mainPct = n(row.mainPct);
    const rankScore = n(row.rankScore) ?? 0;
    const amountRank = percentile(amount, tables.amount) ?? 0;
    const flowRank = mean([
      mainNet !== null ? percentile(mainNet, tables.mainNet) : null,
      mainPct !== null ? percentile(mainPct, tables.mainPct) : null,
      rankScore
    ]) ?? rankScore;
    const pctScore = clamp(50 + pct * 4.5);
    const trendScore = pct60 === null ? null : clamp(50 + pct60 * 1.1);
    const industry = industries.get(String(row.industry ?? ''));
    const sectorScore = industry?.score ?? 50;
    const sectorResonance = industry
      ? clamp(0.55 * sectorScore + 0.25 * industry.nearLimitShare * 100 + 0.20 * industry.flowBreadth * 100)
      : 50;
    const flowPositive = (mainNet !== null && mainNet > 0) || (mainPct !== null && mainPct > 0);
    const amountOkay = amount !== null && amount >= 5e7;
    const lanes = {};

    if (amountOkay && pct >= -0.5 && pct <= 6.5 && ((pct60 !== null && pct60 >= -5) || flowPositive) && (flowPositive || rankScore >= 65)) {
      lanes['early-breakout'] = clamp(0.34 * pctScore + 0.22 * (trendScore ?? 50) + 0.24 * flowRank + 0.12 * rankScore + 0.08 * sectorResonance);
    }
    const dailyLimit = limitPctForCode(code);
    if (amountOkay && pct >= dailyLimit * 0.5 && pct < dailyLimit * 0.985) {
      lanes['limit-up-approach'] = clamp(45 + pct / dailyLimit * 22 + flowRank * 0.18 + rankScore * 0.12 + sectorResonance * 0.13);
    }
    if (amountOkay && flowPositive) {
      lanes['capital-flow'] = clamp(0.42 * flowRank + 0.22 * rankScore + 0.14 * amountRank + 0.14 * pctScore + 0.08 * sectorResonance);
    }
    if (amountOkay && pct60 !== null && pct60 <= -10 && pct >= -6 && pct <= 4 && flowPositive) {
      lanes['reversal-watch'] = clamp(0.42 * clamp(50 + Math.min(0, pct60) * -1.25) + 0.18 * pctScore + 0.25 * flowRank + 0.15 * rankScore);
    }
    if (amountOkay && turn !== null && turn >= 0.7 && turn <= 6.5 && pct >= 0 && pct <= 8 && (flowPositive || rankScore >= 55)) {
      lanes['low-turnover-breakout'] = clamp(0.30 * pctScore + 0.25 * flowRank + 0.2 * rankScore + 0.15 * amountRank + 0.1 * clamp(100 - turn * 8));
    }
    if (amountOkay && pct >= 0 && industry && industry.count >= 5 && industry.breadth >= 0.55 && industry.medianPct > 0) {
      lanes['industry-strength'] = clamp(0.45 * sectorResonance + 0.2 * pctScore + 0.2 * flowRank + 0.15 * rankScore);
    }
    const globalPctRank = percentile(pct, tables.pct) ?? 0;
    const industryPctRank = industry?.returnRankByCode?.get(code) ?? globalPctRank;
    if (amountOkay && pct >= 0 && industry && industry.count >= 5
      && industryPctRank >= 65 && globalPctRank >= 45 && amountRank >= 45
      && (flowPositive || rankScore >= 65)
      && (industry.breadth >= 0.5 || industry.nearLimitShare > 0)) {
      lanes['sector-leader-proxy'] = clamp(
        0.20 * industryPctRank + 0.08 * globalPctRank + 0.24 * flowRank
        + 0.18 * amountRank + 0.18 * sectorResonance + 0.12 * rankScore
      );
    }
    if (amountOkay && pct >= 0 && amountRank >= 65) {
      lanes['liquidity-volume'] = clamp(0.5 * amountRank + 0.2 * rankScore + 0.2 * flowRank + 0.1 * pctScore);
    }

    const activeLanes = Object.keys(lanes);
    if (!activeLanes.length) continue;
    const observationScore = Math.max(...Object.values(lanes));
    scored.set(code, {
      ...row,
      observationLanes: activeLanes,
      observationLaneLabels: activeLanes.map(lane => laneLabels[lane]),
      observationLaneScores: lanes,
      observationScore: Number(observationScore.toFixed(2)),
      industryLeaderProxyScore:lanes['sector-leader-proxy']===undefined?null:Number(lanes['sector-leader-proxy'].toFixed(2)),
      industryRelativePctRank:lanes['sector-leader-proxy']===undefined?null:Number(industryPctRank.toFixed(2)),
      shadowStage1: Number(observationScore.toFixed(2)),
      sectorScore: Number.isFinite(Number(row.sectorScore)) ? Number(row.sectorScore) : Number(sectorScore.toFixed(2)),
      observationReasons: candidateReasons(lanes, flowPositive, industries, row),
      researchOnly: true,
      entryEligible: false,
      entryGateReasons: [...new Set([...(Array.isArray(row.entryGateReasons) ? row.entryGateReasons : []), 'research-observation-only-not-a-buy-signal'])]
    });
  }

  for (const candidate of Array.isArray(supplemental) ? supplemental : []) {
    const code = String(candidate?.code ?? '');
    if (!code || !isValidObservationRow(candidate)) continue;
    const prior = scored.get(code);
    const supplementalScore = n(candidate.shadowStage1) ?? n(candidate.stage1) ?? 50;
    const base = prior ?? {
      ...candidate,
      observationLanes: [],
      observationLaneLabels: [],
      observationLaneScores: {},
      observationReasons: [],
      sectorScore: n(candidate.sectorScore) ?? 50,
      researchOnly: true,
      entryEligible: false,
      entryGateReasons: []
    };
    const laneScores = {...(base.observationLaneScores ?? {})};
    laneScores['early-breakout'] = Math.max(n(laneScores['early-breakout']) ?? 0, supplementalScore);
    const observationLanes = laneOrder.filter(lane => laneScores[lane] !== undefined);
    scored.set(code, {
      ...base,
      ...candidate,
      observationLanes,
      observationLaneLabels: observationLanes.map(lane => laneLabels[lane]),
      observationLaneScores: laneScores,
      observationScore: Number(Math.max(...Object.values(laneScores)).toFixed(2)),
      shadowStage1: Number(Math.max(...Object.values(laneScores)).toFixed(2)),
      observationReasons: [...new Set([...(base.observationReasons ?? []), '现有强势突破影子通道命中'])],
      researchOnly: true,
      entryEligible: false,
      entryGateReasons: [...new Set([...(base.entryGateReasons ?? []), 'research-observation-only-not-a-buy-signal'])]
    });
  }

  const eligible = [...scored.values()].filter(candidate => !excluded.has(String(candidate.code)));
  const laneCounts = Object.fromEntries(laneOrder.map(lane => [
    lane,
    eligible.filter(candidate => candidate.observationLaneScores?.[lane] !== undefined).length
  ]));
  const buckets = Object.fromEntries(laneOrder.map(lane => [
    lane,
    eligible.filter(candidate => candidate.observationLaneScores?.[lane] !== undefined)
      .sort((a, b) => (b.observationLaneScores[lane] - a.observationLaneScores[lane]) || String(a.code).localeCompare(String(b.code)))
  ]));
  const max = Math.max(0, Math.min(20, Math.floor(Number(limit) || 5)));
  const selected = [];
  const selectedCodes = new Set();
  const industryCounts = new Map();
  const preferredIndustryCap = Math.max(1, Math.ceil(max / 5));
  function fillShortlist(industryCap) {
    const cursors = Object.fromEntries(laneOrder.map(lane => [lane, 0]));
    while (selected.length < max) {
      let advanced = false;
      for (const lane of laneOrder) {
        if (selected.length >= max) break;
        const bucket = buckets[lane];
        while (cursors[lane] < bucket.length) {
          const candidate = bucket[cursors[lane]++];
          const code = String(candidate.code);
          if (selectedCodes.has(code)) continue;
          const rawIndustry = String(candidate.industry ?? '').trim();
          // Unknown industry labels should not collapse all otherwise-diverse candidates into one bucket.
          const industryKey = rawIndustry && rawIndustry !== '-' && rawIndustry !== '未知'
            ? rawIndustry
            : '__unknown__' + code;
          if (industryCap !== Infinity && (industryCounts.get(industryKey) || 0) >= industryCap) continue;
          selectedCodes.add(code);
          selected.push(candidate);
          industryCounts.set(industryKey, (industryCounts.get(industryKey) || 0) + 1);
          advanced = true;
          break;
        }
      }
      if (!advanced) break;
    }
  }
  // First pass limits industry concentration; a second pass fills remaining slots if the pool is narrow.
  fillShortlist(preferredIndustryCap);
  const relaxedIndustryCap = selected.length < max;
  if (relaxedIndustryCap) fillShortlist(Infinity);
  const candidates = selected.map(candidate => ({
    ...candidate,
    observationLaneLabels: (candidate.observationLanes ?? []).map(lane => laneLabels[lane] ?? lane),
    observationReasons: (candidate.observationReasons ?? []).slice(0, 4)
  }));
  return {
    schema: 'v15-one-click-observation-lanes-v1',
    method: 'eight-lane-industry-capped-research-shortlist',
    inputCount: Array.isArray(rows) ? rows.length : 0,
    validInputCount: raw.length,
    candidateCount: eligible.length,
    selectedCount: candidates.length,
    diversification: {
      preferredIndustryCap,
      relaxedIndustryCap,
      industryCounts:Object.fromEntries(industryCounts),
      unknownIndustryTreatedAsUnique:true
    },
    laneCounts,
    candidates,
    observationContext:makeObservationContext(raw),
    laneTopCandidates: Object.fromEntries(laneOrder.map(lane => [
      lane,
      buckets[lane].slice(0, 5).map(candidate => ({
        code: String(candidate.code),
        score: Number((candidate.observationLaneScores?.[lane] ?? 0).toFixed(2)),
        lanes: (candidate.observationLanes ?? []).slice(),
        reasons: (candidate.observationReasons ?? []).slice(0, 3)
      }))
    ])),
    probabilityCalibration: 'NOT_CALIBRATED',
    entryAuthorization: 'NEVER_FROM_OBSERVATION_LANE'
  };
}

export const _internal = {limitPctForCode, isValidObservationRow, makeIndustryStats, makeObservationContext, evaluateRankingFreshness, percentile};
