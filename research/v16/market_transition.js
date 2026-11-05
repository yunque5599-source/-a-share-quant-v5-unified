const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const num = value => finite(value) ? Number(value) : null;
const mean = values => {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
};
const ratio = value => {
  const n = num(value);
  if (n === null) return null;
  return clamp(n > 1 ? n / 100 : n, 0, 1);
};
const dateKey = value => String(value ?? '').slice(0, 10);

const COMPONENT_WEIGHTS = Object.freeze({
  breadth: 25,
  indexTrend: 20,
  turnover: 15,
  sentiment: 15,
  sectorPersistence: 15,
  leaderHealth: 10
});

function breadthComponent(breadth = {}) {
  let upRatio = ratio(breadth.upRatio ?? breadth.advancersRatio ?? breadth.advancersPct);
  const up = num(breadth.up ?? breadth.advancers);
  const down = num(breadth.down ?? breadth.decliners);
  const flat = num(breadth.flat ?? breadth.unchanged);
  if (upRatio === null && up !== null && down !== null && up + down > 0) {
    upRatio = up / (up + down + (flat ?? 0));
  }
  if (upRatio === null) return {score: null, raw: null, sourceQuality: 0, reason: 'breadth-missing'};
  const score = clamp((upRatio - 0.25) / 0.50 * 100);
  const scope = String(breadth.universe ?? breadth.sourceScope ?? '').toLowerCase();
  const sourceQuality = scope === 'full-market' || breadth.fullMarket === true ? 1
    : scope === 'candidate-pool' || breadth.isProxy === true ? 0.45 : 0.55;
  return {score, raw: upRatio, sourceQuality, reason: sourceQuality < 0.6 ? 'breadth-is-not-full-market' : null};
}

function indexTrendComponent(indices) {
  const rows = Array.isArray(indices) ? indices : Object.values(indices ?? {});
  const scores = [];
  for (const item of rows) {
    if (!item || typeof item !== 'object') continue;
    const parts = [];
    const changePct = num(item.changePct ?? item.pct);
    const trend5Pct = num(item.trend5Pct);
    const trend20Pct = num(item.trend20Pct);
    if (changePct !== null) parts.push(clamp(50 + changePct * 5));
    if (trend5Pct !== null) parts.push(clamp(50 + trend5Pct * 3));
    if (trend20Pct !== null) parts.push(clamp(50 + trend20Pct * 2));
    if (typeof item.aboveMa5 === 'boolean') parts.push(item.aboveMa5 ? 65 : 35);
    if (typeof item.aboveMa10 === 'boolean') parts.push(item.aboveMa10 ? 70 : 30);
    if (typeof item.aboveMa20 === 'boolean') parts.push(item.aboveMa20 ? 70 : 30);
    if (parts.length) scores.push(mean(parts));
  }
  return {score: mean(scores), raw: scores.length, sourceQuality: scores.length >= 3 ? 1 : scores.length >= 2 ? 0.8 : 0.5};
}

function turnoverComponent(turnover = {}) {
  let changePct = num(turnover.amountChangePct);
  if (changePct === null) {
    const current = num(turnover.amountCny);
    const previous = num(turnover.previousAmountCny);
    if (current !== null && previous !== null && previous > 0) changePct = (current / previous - 1) * 100;
  }
  if (changePct === null) return {score: null, raw: null, sourceQuality: 0};
  return {score: clamp(50 + changePct * 1.8), raw: changePct, sourceQuality: 1};
}

function sentimentComponent(sentiment = {}) {
  const scores = [];
  const limitUp = num(sentiment.limitUpCount);
  const limitDown = num(sentiment.limitDownCount);
  if (limitUp !== null && limitDown !== null) {
    scores.push(clamp(100 * (limitUp + 1) / (limitUp + limitDown + 2)));
  }
  const broken = ratio(sentiment.brokenBoardRate);
  if (broken !== null) scores.push(100 * (1 - broken));
  const premium = num(sentiment.nextDayPremiumPct);
  if (premium !== null) scores.push(clamp(50 + premium * 8));
  const positive = ratio(sentiment.nextDayPositiveRatio);
  if (positive !== null) scores.push(positive * 100);
  if (!scores.length) return {score: null, raw: null, sourceQuality: 0, reason: 'sentiment-data-missing'};
  const sourceQuality = sentiment.limitLabelQuality === 'APPROXIMATE_PROXY' ? 0.55
    : sentiment.brokenBoardRate === 'NOT_MEASURABLE' ? 0.7 : 0.9;
  return {score: mean(scores), raw: scores.length, sourceQuality};
}

function sectorComponent(sectors = {}) {
  const scores = [];
  const breadth = ratio(sectors.breadthRatio ?? sectors.positiveSectorRatio);
  const flow = ratio(sectors.positiveFlowRatio);
  const repeatDays = num(sectors.topSectorRepeatDays);
  const leaderRs = num(sectors.leaderRelativeStrengthPct);
  if (breadth !== null) scores.push(breadth * 100);
  if (flow !== null) scores.push(flow * 100);
  if (repeatDays !== null) scores.push(clamp(repeatDays / 4 * 100));
  if (leaderRs !== null) scores.push(clamp(50 + leaderRs * 5));
  if (!scores.length) return {score: null, raw: null, sourceQuality: 0};
  return {score: mean(scores), raw: scores.length, sourceQuality: sectors.sourceScope === 'full-market' ? 1 : 0.65};
}

function leaderComponent(leaders = {}) {
  const scores = [];
  const rows = Array.isArray(leaders) ? leaders : Array.isArray(leaders.items) ? leaders.items : [];
  for (const row of rows) {
    const rs = num(row.relativeStrengthPct);
    const close = ratio(row.closeLocation);
    const parts = [];
    if (rs !== null) parts.push(clamp(50 + rs * 5));
    if (close !== null) parts.push(close * 100);
    if (parts.length) scores.push(mean(parts));
  }
  const breadth = ratio(!Array.isArray(leaders) ? leaders.aboveMa5Ratio : null);
  if (breadth !== null) scores.push(breadth * 100);
  if (!scores.length) return {score: null, raw: null, sourceQuality: 0};
  return {score: mean(scores), raw: scores.length, sourceQuality: rows.length >= 3 ? 0.9 : 0.6};
}

export function scoreMarketSession(session = {}) {
  const breadth = breadthComponent(session.breadth);
  const indexTrend = indexTrendComponent(session.indices);
  const turnover = turnoverComponent(session.turnover);
  const sentiment = sentimentComponent(session.sentiment);
  const sectorPersistence = sectorComponent(session.sectors);
  const leaderHealth = leaderComponent(session.leaders);
  const parts = {breadth, indexTrend, turnover, sentiment, sectorPersistence, leaderHealth};
  let weighted = 0;
  let availableWeight = 0;
  let weightedQuality = 0;
  for (const [key, weight] of Object.entries(COMPONENT_WEIGHTS)) {
    const part = parts[key];
    if (!part || !Number.isFinite(part.score)) continue;
    weighted += part.score * weight;
    availableWeight += weight;
    weightedQuality += weight * (part.sourceQuality ?? 0.5);
  }
  const score = availableWeight ? weighted / availableWeight : null;
  const coverage = availableWeight / 100;
  const sourceQuality = availableWeight ? weightedQuality / availableWeight : 0;
  const degradedMultiplier = session.dataQuality?.degraded === true ? 0.75 : 1;
  const confidence = clamp(coverage * sourceQuality * degradedMultiplier * 100);
  const missing = Object.entries(parts).filter(([, value]) => !Number.isFinite(value.score)).map(([key]) => key);
  return {
    date: dateKey(session.date ?? session.tradeDate ?? session.asOf),
    market_regime_score: score === null ? null : Number(score.toFixed(2)),
    market_breadth_score: breadth.score === null ? null : Number(breadth.score.toFixed(2)),
    index_trend_score: indexTrend.score === null ? null : Number(indexTrend.score.toFixed(2)),
    turnover_score: turnover.score === null ? null : Number(turnover.score.toFixed(2)),
    sentiment_score: sentiment.score === null ? null : Number(sentiment.score.toFixed(2)),
    sector_persistence_score: sectorPersistence.score === null ? null : Number(sectorPersistence.score.toFixed(2)),
    leader_health_score: leaderHealth.score === null ? null : Number(leaderHealth.score.toFixed(2)),
    confidence: Number(confidence.toFixed(2)),
    coverage: Number(coverage.toFixed(3)),
    breadth_source_quality: breadth.sourceQuality,
    breadth_source_reason: breadth.reason ?? null,
    components: Object.fromEntries(Object.entries(parts).map(([key, value]) => [key, value.score === null ? null : Number(value.score.toFixed(2))])),
    missing_components: missing,
    source_scope: session.breadth?.universe ?? session.breadth?.sourceScope ?? 'unknown'
  };
}

function transitionMetrics(scored) {
  if (scored.length < 2) return {score: null, improvingCount: 0, changes: {}};
  const first = scored[Math.max(0, scored.length - 3)];
  const last = scored.at(-1);
  const changes = {};
  const values = [];
  for (const key of ['breadth', 'indexTrend', 'turnover', 'sentiment', 'sectorPersistence', 'leaderHealth']) {
    const before = first.components[key];
    const after = last.components[key];
    if (!Number.isFinite(before) || !Number.isFinite(after)) continue;
    const delta = after - before;
    changes[key] = Number(delta.toFixed(2));
    values.push(clamp(50 + delta * 1.7));
  }
  const improvingCount = Object.values(changes).filter(delta => delta >= 5).length;
  return {score: values.length ? Number(mean(values).toFixed(2)) : null, improvingCount, changes};
}

function reversalRisk(scored) {
  if (!scored.length) return {score: null, signals: []};
  const current = scored.at(-1);
  const previous = scored.slice(0, -1).slice(-3);
  const signals = [];
  const breadth = current.components.breadth;
  const index = current.components.indexTrend;
  if (Number.isFinite(breadth) && Number.isFinite(index)) {
    signals.push({name: 'index-breadth-divergence', score: index >= 60 && breadth <= 40 ? 90 : index >= 55 && breadth <= 45 ? 65 : 15});
  }
  const priorHigh = Math.max(...previous.map(row => row.market_regime_score).filter(Number.isFinite));
  if (Number.isFinite(priorHigh) && Number.isFinite(current.market_regime_score)) {
    signals.push({name: 'regime-score-deterioration', score: clamp((priorHigh - current.market_regime_score) * 4)});
  }
  const sentiment = current.components.sentiment;
  if (Number.isFinite(sentiment)) signals.push({name: 'short-term-sentiment', score: clamp((55 - sentiment) * 2)});
  const leader = current.components.leaderHealth;
  if (Number.isFinite(leader)) signals.push({name: 'leader-weakness', score: clamp((55 - leader) * 2)});
  const turnover = current.components.turnover;
  if (Number.isFinite(turnover) && Number.isFinite(breadth)) {
    signals.push({name: 'high-volume-poor-breadth', score: turnover >= 65 && breadth <= 40 ? 85 : 10});
  }
  return {score: signals.length ? Number(mean(signals.map(item => item.score)).toFixed(2)) : null, signals};
}

function classifyRegime(scored, transition, risk) {
  const current = scored.at(-1);
  if (!current || !Number.isFinite(current.market_regime_score)) return {regime: 'TRANSITION', status: 'INSUFFICIENT_DATA'};
  const lastTwo = scored.slice(-2);
  const breadth = current.components.breadth;
  const index = current.components.indexTrend;
  const confidence = current.confidence;
  const bull = lastTwo.length === 2
    && lastTwo.every(row => row.market_regime_score >= 68 && row.confidence >= 50)
    && Number.isFinite(breadth) && breadth >= 55
    && Number.isFinite(index) && index >= 55;
  const bear = lastTwo.length === 2
    && lastTwo.every(row => row.market_regime_score <= 38 && row.confidence >= 45)
    && Number.isFinite(breadth) && breadth <= 45;
  const previousHigh = Math.max(...scored.slice(0, -1).slice(-3).map(row => row.market_regime_score).filter(Number.isFinite));
  const deteriorated = Number.isFinite(previousHigh)
    && current.market_regime_score <= previousHigh - 12
    && (risk.score ?? 0) >= 50;
  const divergence = Number.isFinite(index) && Number.isFinite(breadth) && index >= 55 && breadth <= 40;
  if (deteriorated || divergence) return {regime: 'DISTRIBUTION', status: 'RISK_DETERIORATION'};
  if (bear) return {regime: 'BEAR', status: 'CONFIRMED'};
  if (bull && confidence >= 55) return {regime: 'BULL', status: 'CONFIRMED'};
  return {regime: 'TRANSITION', status: scored.length < 2 || confidence < 40 ? 'INSUFFICIENT_CONFIRMATION' : 'WATCH'};
}

function positionRange(regime, confidence) {
  const ranges = {
    BEAR: [0, 15],
    TRANSITION: [10, 35],
    BULL: [35, 65],
    DISTRIBUTION: [0, 20]
  };
  const base = ranges[regime] ?? [0, 15];
  if (confidence >= 60) return base;
  return [Math.min(base[0], 10), Math.min(base[1], 20)];
}

export function evaluateMarketTransition({sessions = [], asOf = null} = {}) {
  const cutoff = dateKey(asOf);
  const eligible = (Array.isArray(sessions) ? sessions : [])
    .filter(row => row && dateKey(row.date ?? row.tradeDate ?? row.asOf)
      && (!cutoff || dateKey(row.date ?? row.tradeDate ?? row.asOf) <= cutoff))
    .sort((a, b) => dateKey(a.date ?? a.tradeDate ?? a.asOf).localeCompare(dateKey(b.date ?? b.tradeDate ?? b.asOf)))
    .slice(-5);
  const scored = eligible.map(scoreMarketSession);
  const transition = transitionMetrics(scored);
  const risk = reversalRisk(scored);
  const classification = classifyRegime(scored, transition, risk);
  const current = scored.at(-1) ?? null;
  const confidence = current?.confidence ?? 0;
  let permission = 'WAIT_FOR_DATA';
  if (confidence >= 45) {
    if (classification.regime === 'BEAR') permission = 'NO_NEW_RISK';
    else if (classification.regime === 'DISTRIBUTION') permission = 'REDUCE_RISK';
    else if (classification.regime === 'BULL') permission = 'SELECTIVE';
    else permission = 'PROBE_ONLY';
  }
  const transitionStage = classification.regime === 'BULL' ? 'CONFIRMED'
    : transition.score !== null && transition.score >= 65 && transition.improvingCount >= 3 ? 'CONFIRMING'
    : transition.score !== null && transition.score >= 57 && transition.improvingCount >= 2 ? 'EARLY_WATCH'
    : 'NONE';
  const range = positionRange(classification.regime, confidence);
  const dataWarnings = [];
  if (!current) dataWarnings.push('no-qualified-market-session');
  if (current?.breadth_source_quality < 0.6) dataWarnings.push('breadth-is-not-full-market');
  if (eligible.at(-1)?.sentiment?.limitLabelQuality === 'APPROXIMATE_PROXY') dataWarnings.push('limit-up-down-counts-are-approximate-proxies');
  if (current?.missing_components?.length) dataWarnings.push('missing-components:' + current.missing_components.join(','));
  if (confidence < 45) dataWarnings.push('confidence-below-actionable-threshold');
  return {
    schema: 'ashare-v16-market-transition-v1',
    asOf: current?.date ?? cutoff ?? null,
    regime: classification.regime,
    classification_status: classification.status,
    market_regime_score: current?.market_regime_score ?? null,
    market_transition_score: transition.score,
    market_reversal_risk: risk.score,
    market_breadth_score: current?.market_breadth_score ?? null,
    sector_persistence_score: current?.sector_persistence_score ?? null,
    confidence,
    coverage: current?.coverage ?? 0,
    transition_stage: transitionStage,
    improving_component_count: transition.improvingCount,
    component_changes: transition.changes,
    components: current?.components ?? {},
    recommended_position_range_pct: range,
    trade_permission: permission,
    data_warnings: dataWarnings,
    history: scored
  };
}

export const _internal = {breadthComponent, indexTrendComponent, turnoverComponent, sentimentComponent, sectorComponent, leaderComponent, transitionMetrics, reversalRisk, classifyRegime};
