const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const num = value => finite(value) ? Number(value) : null;

function findSector(sectorResult, key) {
  if (!sectorResult || !Array.isArray(sectorResult.sectors)) return null;
  return sectorResult.sectors.find(row => String(row.key) === String(key))
    ?? sectorResult.sectors.find(row => String(row.label) === String(key))
    ?? null;
}

export function buildV16DecisionOverlay({market = null, overnight = null, sectorRotation = null, candidate = {}} = {}) {
  const industryKey = String(candidate.industryKey ?? candidate.industry ?? '');
  const sector = candidate.sectorOpportunity ?? findSector(sectorRotation, industryKey);
  const industryImpact = overnight?.industries?.[industryKey] ?? null;
  const candidateStrength = num(candidate.candidateScore ?? candidate.score);
  const sectorScore = num(sector?.opportunity_score);
  const overnightScore = num(industryImpact?.adjusted_impact_score ?? industryImpact?.overnight_impact_score);
  const entryTiming = candidate.entryTiming ?? {};
  const entryTimingScore = num(entryTiming.entry_timing_score ?? entryTiming.score);
  const entryPass = entryTiming.pass === true;
  const opportunityParts = [];
  if (candidateStrength !== null) opportunityParts.push([candidateStrength, 0.45]);
  if (sectorScore !== null) opportunityParts.push([sectorScore, 0.35]);
  if (overnightScore !== null) opportunityParts.push([overnightScore, 0.20]);
  const opportunityWeight = opportunityParts.reduce((sum, [, weight]) => sum + weight, 0);
  const opportunityScore = opportunityWeight
    ? clamp(opportunityParts.reduce((sum, [value, weight]) => sum + value * weight, 0) / opportunityWeight)
    : null;
  const regime = String(market?.regime ?? 'TRANSITION');
  const confidence = num(market?.confidence) ?? 0;
  const mappingConfidence = num(industryImpact?.industry_mapping_confidence) ?? 0;
  const impactClass = String(industryImpact?.impact_classification ?? 'UNCERTAIN');
  const openSignal = String(industryImpact?.a_share_open_signal ?? 'NOT_MEASURABLE');
  const reasons = [];
  let decision = 'WAIT_FOR_DATA';
  let buyPermission = false;
  let singlePositionCapPct = 0;

  if (regime === 'BEAR') {
    decision = 'NO_NEW_RISK';
    reasons.push('market-regime-BEAR');
  } else if (regime === 'DISTRIBUTION') {
    decision = 'REDUCE_RISK';
    reasons.push('market-regime-DISTRIBUTION');
  } else if (confidence < 45 || opportunityScore === null) {
    decision = 'WAIT_FOR_DATA';
    reasons.push('market-confidence-or-opportunity-data-insufficient');
  } else if (!entryPass) {
    decision = 'WAIT_FOR_ENTRY';
    reasons.push('entry-timing-not-confirmed');
  } else if (sectorScore === null || sectorScore < 55) {
    decision = 'WAIT_FOR_SECTOR';
    reasons.push('sector-opportunity-below-gate-or-missing');
  } else if (impactClass === 'NEGATIVE' && mappingConfidence >= 65 && openSignal !== 'RELATIVE_STRENGTH_CONFIRMED') {
    decision = 'WAIT_FOR_OVERSEAS_RISK';
    reasons.push('verified-high-confidence-negative-overnight-impact-not-offset-by-A-share-open');
  } else if (regime === 'TRANSITION') {
    decision = 'PROBE_ONLY';
    buyPermission = true;
    singlePositionCapPct = 8;
    reasons.push('market-transition-allows-only-small-probe');
  } else if (regime === 'BULL') {
    decision = 'SELECTIVE_ENTRY';
    buyPermission = true;
    singlePositionCapPct = 15;
    reasons.push('confirmed-BULL-market-and-entry-gates-pass');
  } else {
    decision = 'WAIT_FOR_DATA';
    reasons.push('unrecognized-market-regime');
  }

  if (entryTimingScore === null) reasons.push('entry-timing-score-not-measurable');
  if (industryImpact && industryImpact.a_share_open_status === 'NOT_MEASURABLE') {
    reasons.push('A-share-open-confirmation-NOT_MEASURABLE');
  }
  if (market?.data_warnings?.length) reasons.push('market-data-warnings-present');
  return {
    schema: 'ashare-v16-decision-overlay-v1',
    code: String(candidate.code ?? ''),
    name: String(candidate.name ?? ''),
    industry: industryKey,
    opportunity_score: opportunityScore === null ? null : Number(opportunityScore.toFixed(2)),
    entry_timing_score: entryTimingScore === null ? null : Number(entryTimingScore.toFixed(2)),
    entry_timing_pass: entryPass,
    market_regime: regime,
    market_confidence: confidence,
    sector_opportunity_score: sectorScore,
    overnight_industry_impact_score: overnightScore,
    overnight_impact_classification: impactClass,
    industry_mapping_confidence: mappingConfidence,
    a_share_open_signal: openSignal,
    decision,
    buy_permission: buyPermission,
    single_position_cap_pct: singlePositionCapPct,
    reasons,
    execution: 'NO_ORDER_PLACEMENT'
  };
}
