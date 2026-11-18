const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const num = value => finite(value) ? Number(value) : null;
const ratio = value => {
  const n = num(value);
  return n === null ? null : clamp(n > 1 ? n / 100 : n, 0, 1);
};
const mean = values => {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
};

function persistenceScore(row, market = {}) {
  const parts = [];
  const marketD1 = num(market.d1Pct);
  const d1 = num(row.d1Pct ?? row.return1dPct);
  const d3 = num(row.d3Pct ?? row.return3dPct);
  const d5 = num(row.d5Pct ?? row.return5dPct);
  if (d1 !== null && marketD1 !== null) parts.push(clamp(50 + (d1 - marketD1) * 5));
  if (d3 !== null) parts.push(clamp(50 + d3 * 2.5));
  if (d5 !== null) parts.push(clamp(50 + d5 * 1.5));
  const breadth = ratio(row.advancersRatio ?? row.breadthRatio);
  if (breadth !== null) parts.push(breadth * 100);
  const flow = ratio(row.positiveFlowRatio);
  if (flow !== null) parts.push(flow * 100);
  const leader = num(row.leaderRelativeStrengthPct);
  if (leader !== null) parts.push(clamp(50 + leader * 5));
  const repeat = num(row.topSectorRepeatDays);
  if (repeat !== null) parts.push(clamp(repeat / 4 * 100));
  return parts.length ? Number(mean(parts).toFixed(2)) : null;
}

function accelerationScore(row, previous) {
  if (!previous) return {score: null, changes: {}, measurable: false};
  const changes = {};
  const parts = [];
  const rank = num(row.rankToday);
  const priorRank = num(previous.rankToday ?? previous.rank);
  if (rank !== null && priorRank !== null) {
    changes.rankImprovement = priorRank - rank;
    parts.push(clamp(50 + changes.rankImprovement * 4));
  }
  const breadth = ratio(row.advancersRatio ?? row.breadthRatio);
  const priorBreadth = ratio(previous.advancersRatio ?? previous.breadthRatio);
  if (breadth !== null && priorBreadth !== null) {
    changes.breadthDeltaPct = (breadth - priorBreadth) * 100;
    parts.push(clamp(50 + changes.breadthDeltaPct * 1.5));
  }
  const flow = ratio(row.positiveFlowRatio);
  const priorFlow = ratio(previous.positiveFlowRatio);
  if (flow !== null && priorFlow !== null) {
    changes.flowBreadthDeltaPct = (flow - priorFlow) * 100;
    parts.push(clamp(50 + changes.flowBreadthDeltaPct * 1.5));
  }
  const relative = num(row.leaderRelativeStrengthPct);
  const priorRelative = num(previous.leaderRelativeStrengthPct);
  if (relative !== null && priorRelative !== null) {
    changes.leaderRelativeStrengthDelta = relative - priorRelative;
    parts.push(clamp(50 + changes.leaderRelativeStrengthDelta * 3));
  }
  return {
    score: parts.length ? Number(mean(parts).toFixed(2)) : null,
    changes,
    measurable: parts.length > 0
  };
}

function profitTakingRisk(row) {
  const priorReturn = num(row.previousDayReturnPct);
  const currentReturn = num(row.d1Pct ?? row.return1dPct);
  const broken = ratio(row.brokenBoardRate);
  const parts = [];
  if (priorReturn !== null) parts.push(clamp(Math.max(0, priorReturn - 2) * 8));
  if (priorReturn !== null && currentReturn !== null && priorReturn >= 3 && currentReturn < 0) {
    parts.push(clamp(65 + Math.abs(currentReturn) * 4));
  }
  if (broken !== null) parts.push(broken * 100);
  const nearLimit = num(row.nearLimitUpCount);
  if (nearLimit !== null && priorReturn !== null && priorReturn >= 4) {
    parts.push(clamp(nearLimit * 5));
  }
  return parts.length ? Number(mean(parts).toFixed(2)) : null;
}

export function scoreSectorRotation({sectors = [], previousSectors = [], market = {}} = {}) {
  const previousByKey = new Map((Array.isArray(previousSectors) ? previousSectors : [])
    .map(row => [String(row.key ?? row.industry ?? row.name ?? ''), row]));
  const rows = (Array.isArray(sectors) ? sectors : []).map(row => {
    const key = String(row.key ?? row.industry ?? row.name ?? '');
    const previous = previousByKey.get(key) ?? null;
    const persistence = persistenceScore(row, market);
    const acceleration = accelerationScore(row, previous);
    const profitRisk = profitTakingRisk(row);
    const relative = num(row.d1Pct ?? row.return1dPct);
    const marketD1 = num(market.d1Pct);
    const relativeStrength = relative !== null && marketD1 !== null ? relative - marketD1 : null;
    const available = [
      [persistence, 0.55],
      [acceleration.score, 0.25],
      [relativeStrength === null ? null : clamp(50 + relativeStrength * 5), 0.20]
    ].filter(([value]) => Number.isFinite(value));
    const totalWeight = available.reduce((sum, [, weight]) => sum + weight, 0);
    const rawOpportunity = totalWeight
      ? available.reduce((sum, [value, weight]) => sum + value * weight, 0) / totalWeight
      : null;
    const opportunity = rawOpportunity === null ? null
      : clamp(rawOpportunity - (Number.isFinite(profitRisk) ? profitRisk * 0.20 : 0));
    return {
      key,
      label: row.label ?? row.industry ?? row.name ?? key,
      sector_persistence_score: persistence,
      sector_rotation_acceleration_score: acceleration.score,
      profit_taking_risk_score: profitRisk,
      relative_strength_pct: relativeStrength === null ? null : Number(relativeStrength.toFixed(2)),
      opportunity_score: opportunity === null ? null : Number(opportunity.toFixed(2)),
      acceleration_changes: acceleration.changes,
      previous_snapshot_available: Boolean(previous),
      data_coverage: Number((available.reduce((sum, [, weight]) => sum + weight, 0)).toFixed(3)),
      evidence: {
        d1Pct: num(row.d1Pct ?? row.return1dPct),
        d3Pct: num(row.d3Pct ?? row.return3dPct),
        d5Pct: num(row.d5Pct ?? row.return5dPct),
        advancersRatio: ratio(row.advancersRatio ?? row.breadthRatio),
        positiveFlowRatio: ratio(row.positiveFlowRatio),
        topSectorRepeatDays: num(row.topSectorRepeatDays)
      }
    };
  }).sort((a, b) => (b.opportunity_score ?? -1) - (a.opportunity_score ?? -1));
  return {
    schema: 'ashare-v16-sector-rotation-v1',
    sector_count: rows.length,
    previous_snapshot_available: previousByKey.size > 0,
    sectors: rows,
    limitations: [
      'Sector acceleration requires a prior point-in-time sector snapshot; without it the acceleration score is NOT_MEASURABLE.',
      'Candidate-pool breadth must not be labelled as whole-market or official industry breadth.',
      'Profit-taking risk is a risk overlay, not a forecast of next-session selling.'
    ]
  };
}

/**
 * Opportunity and entry timing are deliberately independent.
 * Missing live price/MA/ATR or intraday confirmation returns NOT_MEASURABLE,
 * never an implicit pass.
 */
export function evaluateEntryTiming(candidate = {}) {
  const price = num(candidate.price);
  const ma5 = num(candidate.ma5);
  const atrPct = num(candidate.atrPct);
  const dayPct = num(candidate.dayPct);
  const closeLocation = ratio(candidate.closeLocation);
  const priceVsVwapPct = num(candidate.priceVsVwapPct);
  const flow3 = num(candidate.flow3);
  const flow5 = num(candidate.flow5);
  const pullbackTouched = candidate.pullbackTouched === true;
  const reclaimedMa5 = candidate.reclaimedMa5 === true;
  const reasons = [];
  if (price === null || ma5 === null || atrPct === null) {
    return {
      status: 'NOT_MEASURABLE',
      entry_timing_score: null,
      pass: false,
      reasons: ['price, MA5 or ATR data missing']
    };
  }
  let score = 50;
  if (pullbackTouched) score += 12;
  else reasons.push('pullback-not-confirmed');
  if (reclaimedMa5 && price >= ma5) score += 15;
  else reasons.push('MA5-reclaim-not-confirmed');
  if (closeLocation !== null && closeLocation >= 0.60) score += 10;
  else reasons.push('close-strength-insufficient');
  if (priceVsVwapPct !== null && priceVsVwapPct >= 0) score += 8;
  else reasons.push('price-below-or-missing-VWAP');
  if (flow3 !== null && flow5 !== null && flow3 >= 0 && flow5 >= 0) score += 10;
  else if (flow3 !== null && flow5 !== null && flow3 < 0 && flow5 < 0) {
    score -= 18;
    reasons.push('three-and-five-day-flow-both-negative');
  }
  const ma5GapPct = (price / ma5 - 1) * 100;
  if (ma5GapPct >= 4.5) {
    score -= 20;
    reasons.push('price-overextended-from-MA5');
  }
  if (dayPct !== null && dayPct >= 6.5) {
    score -= 25;
    reasons.push('no-chase-daily-move');
  }
  if (atrPct >= 8.5) {
    score -= 15;
    reasons.push('ATR-volatility-too-high');
  }
  score = clamp(score);
  const pass = score >= 65 && pullbackTouched && reclaimedMa5 && price >= ma5
    && closeLocation !== null && closeLocation >= 0.55
    && priceVsVwapPct !== null && priceVsVwapPct >= 0
    && !(dayPct !== null && dayPct >= 6.5)
    && atrPct < 8.5
    && !(flow3 !== null && flow5 !== null && flow3 < 0 && flow5 < 0);
  if (pass) reasons.push('confirmed-pullback-and-reclaim');
  return {
    status: 'MEASURABLE',
    entry_timing_score: Number(score.toFixed(2)),
    pass,
    ma5_gap_pct: Number(ma5GapPct.toFixed(2)),
    reasons
  };
}

export const _internal = {persistenceScore, accelerationScore, profitTakingRisk};
