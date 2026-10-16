import { clamp, finiteNumber, round, asOfDate } from './schema.js';
import { scoreNarrativeResearch, scoreImaginationResearch } from './psychology_research.js';

export const PSYCHOLOGY_WEIGHTS = Object.freeze({
  emotionHeat: 0.20,
  emotionAcceleration: 0.20,
  narrative: 0.20,
  leader: 0.20,
  imagination: 0.10,
  behavioral: 0.10
});

export const PSYCHOLOGY_VERSION = 'V12 Psychology Score Phase 3 Behavioral';

const n = finiteNumber;
const metric = value => value === null || !Number.isFinite(value) ? null : round(value);
const list = value => Array.isArray(value) ? value : [];

function pctScore(value, multiplier = 5) {
  return value === null ? null : clamp(50 + value * multiplier);
}

function breadthPct(theme = {}) {
  const explicit = n(theme.breadthPct);
  if (explicit !== null) return clamp(explicit <= 1 ? explicit * 100 : explicit);
  const ratio = n(theme.upRatio);
  if (ratio !== null) return clamp(ratio <= 1 ? ratio * 100 : ratio);
  const up = n(theme.upCount);
  const down = n(theme.downCount);
  const flat = n(theme.flatCount) ?? 0;
  const total = up !== null && down !== null ? up + down + flat : 0;
  return total > 0 ? clamp(up / total * 100) : null;
}

function strongBreadthPct(theme = {}) {
  const explicit = n(theme.strongBreadthPct);
  if (explicit !== null) return clamp(explicit <= 1 ? explicit * 100 : explicit);
  const strong = n(theme.strongCount ?? theme.limitUpCount);
  const members = n(theme.memberCount);
  return strong !== null && members > 0 ? clamp(strong / members * 100) : null;
}

function limitUpRatio(theme = {}) {
  const count = n(theme.limitUpCount);
  const members = n(theme.memberCount);
  return count !== null && members > 0 ? clamp(count / members * 100) : null;
}

function scoreEmotionHeat(theme = {}) {
  const flow = n(theme.mainNetPct ?? theme.themeFlowPct);
  const change = n(theme.changePct ?? theme.themeChangePct);
  const breadth = breadthPct(theme);
  const limitUps = limitUpRatio(theme);
  const strongBreadth = strongBreadthPct(theme);
  if ([flow, change, breadth].some(value => value === null)) {
    return {score:null, confidence:0, components:{}, reasons:['emotion-evidence-incomplete']};
  }
  const components = {
    flow: {score:pctScore(flow, 8), weight:0.40},
    breadth: {score:breadth, weight:0.35},
    change: {score:pctScore(change, 5), weight:0.25}
  };
  if (limitUps !== null) {
    components.limitUps = {score:clamp(50 + (limitUps - 5) * 5), weight:0.15};
    for (const key of ['flow','breadth','change']) components[key].weight *= 0.85;
  }
  if (strongBreadth !== null) {
    components.strongBreadth = {score:clamp(50 + (strongBreadth - 5) * 5), weight:0.10};
    const baseKeys = limitUps !== null ? ['flow','breadth','change','limitUps'] : ['flow','breadth','change'];
    for (const key of baseKeys) components[key].weight *= 0.90;
  }
  const score = Object.values(components).reduce((sum, item) =>
    sum + item.score * item.weight, 0);
  return {
    score:clamp(score),
    confidence:strongBreadth === null ? 0.82 : 1,
    components,
    reasons:[
      flow > 0 ? 'theme-capital-inflow' : 'theme-capital-outflow',
      breadth >= 70 ? 'broad-participation' : breadth <= 35 ? 'narrow-participation' : 'mixed-participation',
      limitUps >= 8 ? 'limit-up-cluster' : 'limit-up-sparse'
    ]
  };
}

function deltaScore(delta, multiplier = 5) {
  return delta === null ? null : clamp(50 + delta * multiplier);
}

function scoreEmotionAcceleration(theme = {}) {
  const currentReturn = n(theme.change5dPct ?? theme.return5dPct);
  const priorReturn = n(theme.prior5dPct ?? theme.prior5dReturnPct);
  const currentBreadth = breadthPct(theme);
  const priorBreadthRaw = n(theme.priorBreadthPct);
  const priorBreadth = priorBreadthRaw === null ? null :
    clamp(priorBreadthRaw <= 1 ? priorBreadthRaw * 100 : priorBreadthRaw);
  const currentLimit = n(theme.limitUpCount);
  const priorLimit = n(theme.priorLimitUpCount);
  const memberCount = n(theme.memberCount);
  const flow = n(theme.recentMainNetPct ?? theme.mainNetPct ?? theme.themeFlowPct);
  const priorFlow = n(theme.priorMainNetPct ?? theme.priorThemeFlowPct);

  const signals = [];
  if (currentReturn !== null && priorReturn !== null) {
    signals.push({
      key:'returnAcceleration',
      score:deltaScore(currentReturn - priorReturn, 5),
      weight:0.35
    });
  }
  if (currentBreadth !== null && priorBreadth !== null) {
    signals.push({
      key:'breadthAcceleration',
      score:deltaScore(currentBreadth - priorBreadth, 1),
      weight:0.25
    });
  }
  if (currentLimit !== null && priorLimit !== null && memberCount > 0) {
    signals.push({
      key:'limitUpAcceleration',
      score:deltaScore((currentLimit - priorLimit) / memberCount * 100, 3),
      weight:0.20
    });
  }
  if (flow !== null && priorFlow !== null) {
    signals.push({
      key:'capitalAcceleration',
      score:deltaScore(flow - priorFlow, 5),
      weight:0.20
    });
  }
  if (signals.length < 2) {
    return {score:null, confidence:0, components:{}, reasons:['emotion-acceleration-incomplete']};
  }
  const weightSum = signals.reduce((sum, item) => sum + item.weight, 0);
  const score = signals.reduce((sum, item) => sum + item.score * item.weight, 0) / weightSum;
  return {
    score:clamp(score),
    confidence:signals.length >= 3 ? 1 : 0.82,
    components:Object.fromEntries(signals.map(item => [item.key, {
      score:item.score, weight:item.weight
    }])),
    reasons:[
      score >= 70 ? 'emotion-accelerating' : score <= 35 ? 'emotion-decelerating' : 'emotion-mixed'
    ]
  };
}

function scoreNarrative(theme = {}) {
  const researched = scoreNarrativeResearch(theme);
  if (researched.score !== null) {
    return {
      score:clamp(researched.score),
      confidence:researched.confidence,
      source:'structured-research',
      evidence:researched.evidence,
      reasons:researched.complete ? ['narrative-research-complete'] :
        ['narrative-research-partial']
    };
  }
  const direct = n(theme.narrativeScore);
  if (direct !== null) {
    const evidence = list(theme.narrativeEvidence ?? theme.catalystEvidence);
    return {
      score:clamp(direct),
      confidence:evidence.length ? 1 : 0.60,
      source:evidence.length ? 'explicit-with-evidence' : 'explicit-without-evidence',
      evidence:evidence.slice(0,8),
      reasons:evidence.length ? ['narrative-evidence-present'] : ['narrative-score-needs-evidence']
    };
  }
  const strength = n(theme.catalystStrengthScore);
  const freshness = n(theme.catalystFreshnessScore);
  if (strength === null || freshness === null) {
    return {score:null, confidence:0, source:'missing', evidence:[], reasons:['narrative-evidence-missing']};
  }
  return {
    score:clamp(strength * 0.60 + freshness * 0.40),
    confidence:0.75,
    source:'catalyst-proxy',
    evidence:list(theme.catalystEvidence).slice(0,8),
    reasons:['narrative-derived-from-catalyst']
  };
}

function scoreImagination(theme = {}) {
  const researched = scoreImaginationResearch(theme);
  if (researched.score !== null) {
    return {
      score:clamp(researched.score),
      confidence:researched.confidence,
      source:'structured-research',
      evidence:researched.evidence,
      reasons:researched.complete ? ['imagination-research-complete'] :
        ['imagination-research-partial']
    };
  }
  const direct = n(theme.imaginationScore);
  if (direct !== null) {
    const evidence = list(theme.imaginationEvidence ?? theme.spaceEvidence);
    const suppliedConfidence = n(theme.imaginationConfidence);
    const confidence = suppliedConfidence !== null
      ? Math.min(0.90, Math.max(0, suppliedConfidence))
      : evidence.length ? 1 : 0.60;
    return {
      score:clamp(direct),
      confidence,
      source:confidence < 0.90 ? 'structured-research-partial' :
        evidence.length ? 'explicit-with-evidence' : 'explicit-without-evidence',
      evidence:evidence.slice(0,8),
      reasons:confidence < 0.90 ? ['imagination-research-partial'] :
        evidence.length ? ['imagination-evidence-present'] : ['imagination-score-needs-evidence']
    };
  }
  const parts = [
    ['marketSizeScore', n(theme.marketSizeScore)],
    ['penetrationGapScore', n(theme.penetrationGapScore)],
    ['policyRunwayScore', n(theme.policyRunwayScore)],
    ['industryExpansionScore', n(theme.industryExpansionScore)]
  ].filter(([, value]) => value !== null);
  if (parts.length < 2) {
    return {score:null, confidence:0, source:'missing', evidence:[], reasons:['imagination-evidence-missing']};
  }
  return {
    score:clamp(parts.reduce((sum, [, value]) => sum + value, 0) / parts.length),
    confidence:0.75,
    source:'space-proxy',
    evidence:list(theme.spaceEvidence).slice(0,8),
    reasons:['imagination-derived-from-space-proxies']
  };
}

const leaderStatusScores = Object.freeze({
  leader:100,
  龙头:100,
  core:88,
  核心:88,
  front:72,
  前排:72,
  follower:42,
  跟风:42
});

function scoreLeader(theme = {}, candidate = {}) {
  const code = String(candidate.symbol ?? candidate.code ?? '').trim();
  const leaderCode = String(theme.leaderCode ?? theme.leadingCode ?? '').trim();
  const status = String(theme.leaderStatus ?? '').trim().toLowerCase();
  const rank = n(theme.candidateRank ?? candidate.themeRank);
  const premium = n(theme.candidatePremiumPct ?? candidate.themePremiumPct ??
    theme.leaderPremiumPct);
  const persistence = n(theme.leaderPersistenceDays);

  const pieces = [];
  if (leaderCode && code) {
    pieces.push({key:'leaderIdentity', score:leaderCode === code ? 100 : 30,
      weight:leaderCode === code ? 0.55 : 0.25});
  }
  if (status && leaderStatusScores[status] !== undefined) {
    pieces.push({key:'leaderStatus', score:leaderStatusScores[status], weight:0.25});
  }
  if (rank !== null && rank > 0) {
    const rankScore = clamp(100 - 15 * Math.log(rank));
    pieces.push({key:'themeRank', score:rankScore, weight:0.30});
  }
  if (premium !== null) {
    pieces.push({key:'leaderPremium', score:pctScore(premium, 5), weight:0.20});
  }
  if (persistence !== null) {
    pieces.push({key:'leaderPersistence', score:clamp(40 + persistence * 8), weight:0.15});
  }
  if (pieces.length < 2) {
    return {score:null, confidence:0, components:{}, reasons:['leader-evidence-incomplete']};
  }
  const weightSum = pieces.reduce((sum, item) => sum + item.weight, 0);
  const score = pieces.reduce((sum, item) => sum + item.score * item.weight, 0) / weightSum;
  const identity = pieces.find(item => item.key === 'leaderIdentity');
  return {
    score:clamp(score),
    confidence:identity && identity.score === 100 ? 1 : 0.78,
    components:Object.fromEntries(pieces.map(item => [item.key, {
      score:item.score, weight:item.weight
    }])),
    reasons:identity?.score === 100 ? ['theme-leader'] :
      rank !== null && rank <= 3 ? ['theme-front-runner'] : ['theme-follower']
  };
}

function fomoRisk(theme = {}, candidate = {}) {
  const change = n(theme.changePct ?? theme.themeChangePct);
  const leaderChange = n(theme.leaderChangePct);
  const breadth = breadthPct(theme);
  const flow = n(theme.mainNetPct ?? theme.themeFlowPct);
  const parts = [];
  if (change !== null) parts.push({value:clamp(50 + (change - 5) * 8), weight:0.35});
  if (leaderChange !== null) parts.push({value:clamp(50 + (leaderChange - 8) * 6), weight:0.30});
  if (breadth !== null) parts.push({value:breadth, weight:0.20});
  if (flow !== null) parts.push({value:clamp(50 + flow * 8), weight:0.15});
  const weightSum = parts.reduce((sum, item) => sum + item.weight, 0);
  const score = weightSum ? parts.reduce((sum, item) =>
    sum + item.value * item.weight, 0) / weightSum : null;
  const candidateChange = n(candidate.pct ?? candidate.changePct);
  const candidateFomo = candidateChange === null ? null :
    clamp(50 + (candidateChange - 5) * 8);
  return {
    score:score === null ? candidateFomo : clamp(score),
    candidateScore:candidateFomo,
    label:score === null ? 'unknown' :
      score >= 75 ? 'high' : score >= 55 ? 'elevated' : 'normal'
  };
}

function scoreBehavioral(theme = {}, candidate = {}, marketEmotion = {}) {
  const fomo = fomoRisk(theme, candidate);
  const globalEmotion = n(marketEmotion?.score ?? marketEmotion?.marketEmotionScore);
  const flow = n(theme.mainNetPct ?? theme.themeFlowPct);
  const breadth = breadthPct(theme);
  const candidateChange = n(candidate.pct ?? candidate.changePct);
  const leaderChange = n(theme.leaderChangePct);
  const capital = candidate?.features?.capital ?? {};
  const largeOrderPct = n(capital.largeOrderNetPct5d);
  const largeOrderPositiveRatio = n(capital.largeOrderPositiveRatio5d);
  const flowTiming = String(capital.flowTiming ?? '');
  const parts = [];

  const change = n(theme.changePct ?? theme.themeChangePct);
  if (flow !== null) {
    const flowScore = clamp(50 + flow * 8);
    const priceScore = change === null ? 50 : clamp(50 + change * 5);
    const directionBonus = change === null || flow * change >= 0 ? 10 : -10;
    let capitalEmotionScore = clamp(flowScore * 0.60 + priceScore * 0.40 + directionBonus);
    let capitalReason = 'main-flow-price-aligned';
    // Eastmoney exposes order-size buckets, not an A-share "dark pool".
    // Treat large+super-large net flow only as an observable institutional/large-order proxy.
    if (largeOrderPct !== null && largeOrderPositiveRatio !== null) {
      const largeOrderScore = clamp(
        clamp(50 + largeOrderPct * 8) * 0.65 +
        largeOrderPositiveRatio * 100 * 0.35
      );
      const orderAlignment = flow === 0 || largeOrderPct === 0 ||
        Math.sign(flow) === Math.sign(largeOrderPct);
      capitalEmotionScore = clamp(
        capitalEmotionScore * 0.75 +
        largeOrderScore * 0.25 +
        (orderAlignment ? 4 : -6)
      );
      capitalReason = orderAlignment ? 'large-order-confirmation' : 'large-order-divergence';
    }
    parts.push({
      key:'capitalEmotionAlignment',
      score:capitalEmotionScore,
      weight:0.35,
      detail:{largeOrderNetPct5d:largeOrderPct, largeOrderPositiveRatio5d:largeOrderPositiveRatio,
        interpretation:capitalReason}
    });
  }
  if (breadth !== null) {
    parts.push({
      key:'crowdParticipation',
      score:breadth,
      weight:0.20
    });
  }
  if (fomo.score !== null) {
    // Moderate excitement is constructive; both panic and euphoria are penalized.
    const fomoQuality = clamp(100 - Math.abs(fomo.score - 55) * 1.8);
    parts.push({
      key:'fomoBalance',
      score:fomoQuality,
      weight:0.20
    });
  }
  if (candidateChange !== null && leaderChange !== null) {
    const alignment = clamp(100 - Math.abs(candidateChange - leaderChange) * 6);
    parts.push({
      key:'leaderAlignment',
      score:alignment,
      weight:0.10
    });
  }
  if (flowTiming) {
    const flowTimingScore = {
      'early-inflow':90,
      'recent-inflow':68,
      'late-high-inflow':25,
      'outflow':20
    }[flowTiming] ?? 50;
    const timingPenalty = flowTiming === 'late-high-inflow' ? 8 : 0;
    parts.push({
      key:'flowTimingPsychology',
      score:clamp(flowTimingScore - timingPenalty),
      weight:0.10
    });
  }
  if (globalEmotion !== null) {
    parts.push({
      key:'marketEmotion',
      score:clamp(globalEmotion),
      weight:0.10
    });
  }

  if (parts.length < 2) {
    return {
      score:null,
      confidence:0,
      components:{},
      reasons:['behavioral-evidence-incomplete']
    };
  }
  const weightSum = parts.reduce((sum, item) => sum + item.weight, 0);
  const score = parts.reduce((sum, item) => sum + item.score * item.weight, 0) / weightSum;
  return {
    score:clamp(score),
    confidence:parts.length >= 3 ? 1 : 0.80,
    components:Object.fromEntries(parts.map(item => [item.key, {
      score:item.score, weight:item.weight
    }])),
    reasons:[
      score >= 70 ? 'constructive-crowd-psychology' :
        score <= 35 ? 'weak-crowd-psychology' : 'mixed-crowd-psychology'
    ]
  };
}

function stageFor(heat, acceleration, fomo) {
  if ([heat, acceleration].some(value => value === null)) return 'unknown';
  if (heat < 40 || acceleration < 35) return 'decay';
  if (heat >= 82 && (fomo ?? 0) >= 75) return 'climax';
  if (acceleration >= 70 && heat >= 55) return 'acceleration';
  if (acceleration >= 65 && heat < 55) return 'ignition';
  if (heat >= 60) return 'mainstream';
  return 'neutral';
}

function themeKey(theme = {}) {
  return String(theme.code ?? theme.id ?? theme.name ?? '').trim();
}

function normalizeThemes(context = {}) {
  const raw = context?.themes ?? context?.themeResearch?.themes ??
    context?.concepts ?? context?.boards ?? [];
  return list(raw).filter(item => item && typeof item === 'object');
}

function candidateThemeRefs(candidate = {}) {
  const refs = list(candidate.themes ?? candidate.concepts ??
    candidate.themeCodes ?? candidate.conceptCodes);
  return refs.map(ref => typeof ref === 'string' ? ref : ref?.code ?? ref?.id ?? ref?.name)
    .filter(Boolean).map(String);
}

function matchThemes(candidate = {}, context = {}) {
  const all = normalizeThemes(context);
  const bySymbol = context?.themeBySymbol?.[String(candidate.symbol)] ??
    context?.themeBySymbol?.[String(candidate.code)] ?? [];
  const refs = candidateThemeRefs(candidate);
  const selected = [];
  const seen = new Set();

  const candidateDate = asOfDate(candidate.asOf);
  for (const theme of [...list(bySymbol), ...all]) {
    const themeAsOf = theme.asOf === undefined || theme.asOf === null || theme.asOf === ''
      ? null : asOfDate(theme.asOf);
    if (theme.asOf !== undefined && theme.asOf !== null && theme.asOf !== '' &&
        (!themeAsOf || !candidateDate || themeAsOf > candidateDate)) continue;
    const key = themeKey(theme);
    const name = String(theme.name ?? '').trim();
    const matched = refs.length === 0
      ? list(bySymbol).includes(theme)
      : refs.some(ref => ref === key || ref === name);
    if (matched && !seen.has(key)) {
      seen.add(key);
      selected.push(theme);
    }
  }
  return selected;
}

function primaryTheme(candidate, themes) {
  if (!themes.length) return null;
  const explicit = themes.find(theme => theme.primary === true);
  if (explicit) return {theme:explicit, basis:'explicit-primary'};
  const relevance = themes
    .filter(theme => n(theme.relevanceScore) !== null)
    .sort((a,b) => n(b.relevanceScore) - n(a.relevanceScore));
  if (relevance.length) return {theme:relevance[0], basis:'relevance-score'};
  return {theme:themes[0], basis:'first-matched-theme'};
}

function scoreTheme(theme, candidate, marketEmotion = {}) {
  const heat = scoreEmotionHeat(theme);
  const acceleration = scoreEmotionAcceleration(theme);
  const narrative = scoreNarrative(theme);
  const leader = scoreLeader(theme, candidate);
  const imagination = scoreImagination(theme);
  const fomo = fomoRisk(theme, candidate);
  const behavioral = scoreBehavioral(theme, candidate, marketEmotion);
  const parts = {emotionHeat:heat, emotionAcceleration:acceleration, narrative, leader, imagination, behavioral};
  const complete = Object.values(parts).every(item => item.score !== null) &&
    Object.values(parts).every(item => item.confidence >= 0.70);
  const raw = complete
    ? Object.entries(PSYCHOLOGY_WEIGHTS).reduce((sum, [key, weight]) =>
      sum + parts[key].score * weight, 0) : null;
  const penalty = fomo.score !== null && fomo.score >= 80 ? 15 :
    fomo.score !== null && fomo.score >= 65 ? 7 : 0;
  const score = raw === null ? null : clamp(raw - penalty);
  const confidence = Object.entries(PSYCHOLOGY_WEIGHTS).reduce((sum, [key, weight]) =>
    sum + (parts[key].confidence ?? 0) * weight, 0);
  return {
    themeCode:themeKey(theme),
    themeName:String(theme.name ?? theme.themeName ?? theme.code ?? 'unknown'),
    score:metric(score),
    scoreRaw:score,
    complete,
    confidence:round(confidence),
    stage:stageFor(heat.score, acceleration.score, fomo.score),
    fomoRisk:{score:metric(fomo.score), candidateScore:metric(fomo.candidateScore), label:fomo.label},
    components:Object.fromEntries(Object.entries(parts).map(([key, item]) => [key, {
      score:metric(item.score), confidence:item.confidence,
      source:item.source ?? 'market-derived', reasons:item.reasons,
      components:item.components ?? null,
      detail:item.detail ?? null
    }])),
    evidence:{
      narrative:narrative.evidence ?? [],
      imagination:imagination.evidence ?? []
    },
    reasons:[...heat.reasons, ...acceleration.reasons, ...narrative.reasons,
      ...leader.reasons, ...imagination.reasons]
  };
}

export function scoreCandidatePsychology(candidate = {}, context = {}) {
  const themes = matchThemes(candidate, context);
  if (!themes.length) {
    return {
      version:PSYCHOLOGY_VERSION, score:null, scoreRaw:null, complete:false,
      confidence:0, stage:'unknown', primaryTheme:null, selectionBasis:'no-theme-match',
      themes:[], fomoRisk:{score:null,label:'unknown'},
      reasons:['theme-membership-missing']
    };
  }
  const marketEmotion = context?.marketEmotion ?? {};
  const scored = themes.map(theme => scoreTheme(theme, candidate, marketEmotion));
  const primary = primaryTheme(candidate, themes);
  const primaryIndex = primary ? themes.indexOf(primary.theme) : -1;
  const result = primaryIndex >= 0 ? scored[primaryIndex] : null;
  return {
    version:PSYCHOLOGY_VERSION,
    score:result?.score ?? null,
    scoreRaw:result?.scoreRaw ?? null,
    complete:result?.complete === true,
    confidence:metric(result?.confidence ?? 0),
    stage:result?.stage ?? 'unknown',
    primaryTheme:result ? {
      code:result.themeCode, name:result.themeName
    } : null,
    selectionBasis:primary?.basis ?? 'none',
    themes:scored.map(item => {
      const copy = {...item};
      delete copy._theme;
      return copy;
    }),
    fomoRisk:result?.fomoRisk ?? {score:null,label:'unknown'},
    reasons:result?.reasons ?? ['psychology-evidence-incomplete']
  };
}

export function withPsychology(candidate = {}, context = {}) {
  const psychology = scoreCandidatePsychology(candidate, context);
  return {
    ...candidate,
    scores:{
      ...(candidate.scores ?? {}),
      psychology:psychology.score,
      psychologyRaw:psychology.scoreRaw
    },
    psychology
  };
}
