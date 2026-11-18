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
const strengthFromPct = pct => pct === null ? null : clamp(50 + pct * 7.5);

const FACTOR_WEIGHTS = Object.freeze({
  semiconductor: [
    ['sox', 0.34], ['smh', 0.14], ['soxx', 0.10], ['nvda', 0.14],
    ['amd', 0.10], ['avgo', 0.08], ['mu', 0.06], ['sndk', 0.04]
  ],
  aiInfrastructure: [
    ['nvda', 0.16], ['amd', 0.08], ['avgo', 0.12], ['sox', 0.16],
    ['msft', 0.12], ['amzn', 0.12], ['googl', 0.08], ['smh', 0.08], ['soxx', 0.08]
  ],
  megaCapTech: [
    ['nasdaq100', 0.32], ['nasdaqComposite', 0.18], ['msft', 0.14],
    ['amzn', 0.12], ['googl', 0.12], ['meta', 0.12]
  ],
  memory: [['mu', 0.48], ['sndk', 0.32], ['sox', 0.12], ['smh', 0.08]],
  cloud: [['msft', 0.34], ['amzn', 0.33], ['googl', 0.23], ['nasdaq100', 0.10]]
});

export const DEFAULT_INDUSTRY_MAP = Object.freeze({
  gpu_chip_design: {label: 'GPU及芯片设计', weights: {semiconductor: 0.65, aiInfrastructure: 0.20, megaCapTech: 0.15}, confidence: 0.90},
  semiconductor_equipment: {label: '半导体设备', weights: {semiconductor: 0.50, aiInfrastructure: 0.20, megaCapTech: 0.10}, confidence: 0.86},
  semiconductor_materials: {label: '半导体材料', weights: {semiconductor: 0.48, memory: 0.22, megaCapTech: 0.10}, confidence: 0.78},
  memory_storage: {label: '存储芯片', weights: {memory: 0.72, semiconductor: 0.18, megaCapTech: 0.10}, confidence: 0.91},
  cpo_optical: {label: 'CPO及光模块', weights: {aiInfrastructure: 0.48, semiconductor: 0.22, megaCapTech: 0.20}, confidence: 0.82},
  pcb: {label: 'PCB', weights: {aiInfrastructure: 0.42, semiconductor: 0.22, megaCapTech: 0.20}, confidence: 0.76},
  ai_servers: {label: 'AI服务器', weights: {aiInfrastructure: 0.58, megaCapTech: 0.24, semiconductor: 0.18}, confidence: 0.84},
  liquid_cooling: {label: '液冷', weights: {aiInfrastructure: 0.50, megaCapTech: 0.30, semiconductor: 0.12}, confidence: 0.72},
  domestic_compute: {label: '国产算力', weights: {aiInfrastructure: 0.30, semiconductor: 0.25, megaCapTech: 0.15}, confidence: 0.58},
  ai_applications: {label: 'AI应用', weights: {cloud: 0.40, megaCapTech: 0.32, aiInfrastructure: 0.18}, confidence: 0.70},
  robotics: {label: '机器人', weights: {semiconductor: 0.24, aiInfrastructure: 0.22, megaCapTech: 0.24}, confidence: 0.62}
});

function getPct(us, key) {
  const aliases = {
    nasdaqComposite: us?.indices?.nasdaqCompositePct ?? us?.indices?.nasdaqComposite?.pct,
    nasdaq100: us?.indices?.nasdaq100Pct ?? us?.indices?.nasdaq100?.pct,
    sox: us?.indices?.soxPct ?? us?.indices?.sox?.pct,
    smh: us?.etfs?.smhPct ?? us?.etfs?.smh?.pct,
    soxx: us?.etfs?.soxxPct ?? us?.etfs?.soxx?.pct,
    qqq: us?.etfs?.qqqPct ?? us?.etfs?.qqq?.pct,
    nvda: us?.stocks?.nvdaPct ?? us?.stocks?.NVDA?.pct ?? us?.stocks?.NVDA,
    amd: us?.stocks?.amdPct ?? us?.stocks?.AMD?.pct ?? us?.stocks?.AMD,
    avgo: us?.stocks?.avgoPct ?? us?.stocks?.AVGO?.pct ?? us?.stocks?.AVGO,
    mu: us?.stocks?.muPct ?? us?.stocks?.MU?.pct ?? us?.stocks?.MU,
    sndk: us?.stocks?.sndkPct ?? us?.stocks?.SNDK?.pct ?? us?.stocks?.SNDK,
    msft: us?.stocks?.msftPct ?? us?.stocks?.MSFT?.pct ?? us?.stocks?.MSFT,
    amzn: us?.stocks?.amznPct ?? us?.stocks?.AMZN?.pct ?? us?.stocks?.AMZN,
    googl: us?.stocks?.googlPct ?? us?.stocks?.GOOGL?.pct ?? us?.stocks?.GOOGL,
    meta: us?.stocks?.metaPct ?? us?.stocks?.META?.pct ?? us?.stocks?.META
  };
  return num(aliases[key]);
}

function weightedFactor(us, weights) {
  let total = 0;
  let used = 0;
  for (const [key, weight] of weights) {
    const pct = getPct(us, key);
    const score = strengthFromPct(pct);
    if (score === null) continue;
    total += score * weight;
    used += weight;
  }
  return {score: used ? total / used : null, coverage: used / weights.reduce((sum, row) => sum + row[1], 0)};
}

function eventScores(events = []) {
  const verified = (Array.isArray(events) ? events : []).filter(event =>
    event?.verified === true && event?.sourceUrl && finite(event?.severity)
  );
  const adverse = verified.filter(event => String(event.direction).toLowerCase() === 'negative');
  const supportive = verified.filter(event => String(event.direction).toLowerCase() === 'positive');
  const risk = adverse.length ? clamp(100 * (1 - adverse.reduce((product, event) =>
    product * (1 - clamp(Number(event.severity), 0, 1) * (finite(event.sourceConfidence) ? clamp(Number(event.sourceConfidence), 0, 1) : 0.8)), 1))) : null;
  const support = supportive.length ? clamp(100 * (1 - supportive.reduce((product, event) =>
    product * (1 - clamp(Number(event.severity), 0, 1) * (finite(event.sourceConfidence) ? clamp(Number(event.sourceConfidence), 0, 1) : 0.8)), 1))) : null;
  return {risk, support, verifiedCount: verified.length, status: verified.length ? 'VERIFIED_EVENTS' : 'NOT_MEASURABLE'};
}

function classifyImpact(score, confidence) {
  if (!Number.isFinite(score) || confidence < 0.5) return 'UNCERTAIN';
  if (score >= 58) return 'POSITIVE';
  if (score <= 42) return 'NEGATIVE';
  return 'NEUTRAL';
}

function scoreOpenConfirmation(open = {}) {
  const required = [
    'auctionPct', 'first15mReturnPct', 'first15mVolumeRatio',
    'sectorAdvancersRatio', 'leaderRelativeStrengthPct', 'priceVsVwapPct'
  ];
  const available = required.filter(key => finite(open[key]));
  if (open.first15mComplete !== true || available.length < 4) {
    return {
      status: 'NOT_MEASURABLE',
      score: null,
      lowOpenAbsorptionScore: null,
      coverage: available.length / required.length,
      reason: 'first-15-minute or required breadth/VWAP evidence is missing'
    };
  }
  const pieces = [];
  const add = (key, score, weight) => { if (Number.isFinite(score)) pieces.push({key, score, weight}); };
  add('auction', strengthFromPct(num(open.auctionPct)), 0.10);
  add('first15mReturn', strengthFromPct(num(open.first15mReturnPct)), 0.10);
  const volumeRatio = num(open.first15mVolumeRatio);
  const sectorBreadthRatio = ratio(open.sectorAdvancersRatio);
  const leaderRelativeStrength = num(open.leaderRelativeStrengthPct);
  const priceVsVwap = num(open.priceVsVwapPct);
  add('volume', volumeRatio === null ? null : clamp(45 + (volumeRatio - 1) * 25), 0.15);
  add('sectorBreadth', sectorBreadthRatio === null ? null : sectorBreadthRatio * 100, 0.20);
  add('leaderRelativeStrength', leaderRelativeStrength === null ? null : clamp(50 + leaderRelativeStrength * 5), 0.20);
  add('priceVsVwap', priceVsVwap === null ? null : clamp(50 + priceVsVwap * 10), 0.25);
  const totalWeight = pieces.reduce((sum, piece) => sum + piece.weight, 0);
  const score = pieces.reduce((sum, piece) => sum + piece.score * piece.weight, 0) / totalWeight;
  const gapRecovery = num(open.gapRecoveryPct);
  const lowOpenAbsorptionScore = gapRecovery === null
    ? score
    : clamp(score * 0.75 + clamp(gapRecovery) * 0.25);
  return {
    status: 'MEASURABLE',
    score: Number(score.toFixed(2)),
    lowOpenAbsorptionScore: Number(lowOpenAbsorptionScore.toFixed(2)),
    coverage: available.length / required.length,
    relativeStrengthConfirmed: lowOpenAbsorptionScore >= 65,
    reasons: pieces.map(piece => piece.key)
  };
}

export function evaluateOvernightGlobalImpact({us = {}, industryMap = DEFAULT_INDUSTRY_MAP, aShareOpen = null} = {}) {
  const semiconductor = weightedFactor(us, FACTOR_WEIGHTS.semiconductor);
  const aiInfrastructure = weightedFactor(us, FACTOR_WEIGHTS.aiInfrastructure);
  const megaCapTech = weightedFactor(us, FACTOR_WEIGHTS.megaCapTech);
  const memory = weightedFactor(us, FACTOR_WEIGHTS.memory);
  const cloud = weightedFactor(us, FACTOR_WEIGHTS.cloud);
  const policy = eventScores(us.policyEvents);
  const factors = {
    semiconductor: semiconductor.score,
    aiInfrastructure: aiInfrastructure.score,
    megaCapTech: megaCapTech.score,
    memory: memory.score,
    cloud: cloud.score
  };
  const factorWeights = {semiconductor: 0.35, aiInfrastructure: 0.35, megaCapTech: 0.20, memory: 0.05, cloud: 0.05};
  let broadScore = 0;
  let broadWeight = 0;
  for (const [key, weight] of Object.entries(factorWeights)) {
    if (!Number.isFinite(factors[key])) continue;
    broadScore += factors[key] * weight;
    broadWeight += weight;
  }
  const overnightScore = broadWeight ? broadScore / broadWeight : null;
  const industryResults = {};
  for (const [key, mapping] of Object.entries(industryMap ?? {})) {
    let total = 0;
    let used = 0;
    for (const [factor, weight] of Object.entries(mapping.weights ?? {})) {
      if (!Number.isFinite(factors[factor])) continue;
      total += factors[factor] * weight;
      used += weight;
    }
    const score = used ? total / used : null;
    const inputCoverage = Object.values(mapping.weights ?? {}).reduce((sum, weight) => sum + weight, 0)
      ? used / Object.values(mapping.weights ?? {}).reduce((sum, weight) => sum + weight, 0) : 0;
    const confidence = clamp(inputCoverage * (Number(mapping.confidence) || 0.5) * 100);
    const open = aShareOpen?.[key] ?? null;
    const openConfirmation = open ? scoreOpenConfirmation(open) : {status: 'NOT_MEASURABLE', score: null, lowOpenAbsorptionScore: null, reason: 'A-share intraday data not supplied'};
    const adjustedScore = Number.isFinite(score) && Number.isFinite(openConfirmation.lowOpenAbsorptionScore)
      ? score * 0.35 + openConfirmation.lowOpenAbsorptionScore * 0.65
      : null;
    const finalScore = adjustedScore ?? score;
    const classification = classifyImpact(finalScore, confidence / 100);
    let openSignal = 'NOT_MEASURABLE';
    if (openConfirmation.status === 'MEASURABLE') {
      if (score !== null && score <= 42 && openConfirmation.lowOpenAbsorptionScore >= 65) openSignal = 'RELATIVE_STRENGTH_CONFIRMED';
      else if (score !== null && score >= 58 && openConfirmation.lowOpenAbsorptionScore <= 40) openSignal = 'OVERSEAS_STRENGTH_NOT_CONFIRMED';
      else openSignal = 'OPEN_CONFIRMATION_MIXED';
    }
    industryResults[key] = {
      label: mapping.label ?? key,
      overnight_impact_score: score === null ? null : Number(score.toFixed(2)),
      adjusted_impact_score: adjustedScore === null ? null : Number(adjustedScore.toFixed(2)),
      impact_classification: classification,
      industry_mapping_confidence: Number(confidence.toFixed(2)),
      factor_coverage: Number(inputCoverage.toFixed(3)),
      a_share_open_status: openConfirmation.status,
      low_open_absorption_score: openConfirmation.lowOpenAbsorptionScore,
      a_share_open_signal: openSignal,
      mapping_weights: mapping.weights ?? {}
    };
  }
  const broadConfidence = broadWeight;
  return {
    schema: 'ashare-v16-overnight-impact-v1',
    asOf: us.asOf ?? null,
    overnight_impact_score: overnightScore === null ? null : Number(overnightScore.toFixed(2)),
    overnight_impact_classification: classifyImpact(overnightScore, broadConfidence),
    us_semiconductor_strength: semiconductor.score === null ? null : Number(semiconductor.score.toFixed(2)),
    us_ai_infrastructure_strength: aiInfrastructure.score === null ? null : Number(aiInfrastructure.score.toFixed(2)),
    us_mega_cap_tech_strength: megaCapTech.score === null ? null : Number(megaCapTech.score.toFixed(2)),
    us_memory_strength: memory.score === null ? null : Number(memory.score.toFixed(2)),
    us_cloud_strength: cloud.score === null ? null : Number(cloud.score.toFixed(2)),
    policy_event_risk: policy.risk,
    policy_event_support: policy.support,
    policy_event_status: policy.status,
    verified_policy_event_count: policy.verifiedCount,
    industry_mapping_confidence: Object.keys(industryResults).length
      ? Number(mean(Object.values(industryResults).map(row => row.industry_mapping_confidence)).toFixed(2)) : 0,
    factor_coverage: {
      semiconductor: Number(semiconductor.coverage.toFixed(3)),
      aiInfrastructure: Number(aiInfrastructure.coverage.toFixed(3)),
      megaCapTech: Number(megaCapTech.coverage.toFixed(3)),
      memory: Number(memory.coverage.toFixed(3)),
      cloud: Number(cloud.coverage.toFixed(3))
    },
    industries: industryResults,
    limitations: [
      'US factor scores are normalized to 0-100 with 50 as neutral; they are not return forecasts.',
      'Industry exposures are explicit research assumptions and require periodic review against A-share revenue/customer exposure.',
      'No A-share opening confirmation is inferred from daily close data; missing minute/VWAP inputs remain NOT_MEASURABLE.',
      'Unverified policy headlines do not contribute to policy_event_risk or policy_event_support.'
    ]
  };
}

export const _internal = {getPct, weightedFactor, eventScores, classifyImpact, scoreOpenConfirmation, strengthFromPct};
