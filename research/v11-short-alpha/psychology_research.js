export const NARRATIVE_RESEARCH_WEIGHTS = Object.freeze({
  novelty:0.25,
  credibility:0.25,
  propagation:0.20,
  persistence:0.15,
  expectationGap:0.15
});

export const IMAGINATION_RESEARCH_WEIGHTS = Object.freeze({
  marketSize:0.25,
  penetrationGap:0.20,
  policyRunway:0.20,
  technologyOptionality:0.20,
  companyCapture:0.15
});

const n = value => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
};

const evidenceList = value => Array.isArray(value) ? value.filter(Boolean).slice(0, 12) : [];

function scoreBlock(block, weights, requiredCount = Object.keys(weights).length) {
  if (!block || typeof block !== 'object') {
    return {score:null, confidence:0, complete:false, components:{}, evidence:[]};
  }
  const components = {};
  let available = 0;
  for (const [key, weight] of Object.entries(weights)) {
    const score = n(block[key] ?? block[key + 'Score']);
    if (score !== null) available += 1;
    components[key] = {score, weight};
  }
  const evidence = evidenceList(block.evidence ?? block.sources ?? block.researchEvidence);
  if (block.complete === false) {
    const evidenceConfidence = evidence.length >= 2 ? 0.68 : evidence.length === 1 ? 0.55 : 0.40;
    return {
      score:null,
      confidence:Math.min(evidenceConfidence, available / Object.keys(weights).length),
      complete:false, components, evidence
    };
  }
  if (available < requiredCount) {
    const evidenceConfidence = evidence.length >= 2 ? 1 : evidence.length === 1 ? 0.80 : 0.55;
    return {
      score:null,
      confidence:available / Object.keys(weights).length * evidenceConfidence,
      complete:false, components, evidence
    };
  }
  const weightSum = Object.values(components)
    .filter(item => item.score !== null)
    .reduce((sum, item) => sum + item.weight, 0);
  const score = Object.values(components)
    .filter(item => item.score !== null)
    .reduce((sum, item) => sum + item.score * item.weight, 0) / weightSum;
  const evidenceConfidence = evidence.length >= 2 ? 1 : evidence.length === 1 ? 0.80 : 0.55;
  return {
    score, confidence:Math.min(1, available / Object.keys(weights).length * evidenceConfidence),
    complete:available === Object.keys(weights).length && evidence.length >= 2,
    components, evidence
  };
}

export function scoreNarrativeResearch(theme = {}) {
  return scoreBlock(
    theme.narrativeResearch ?? theme.research?.narrative,
    NARRATIVE_RESEARCH_WEIGHTS
  );
}

export function scoreImaginationResearch(theme = {}) {
  return scoreBlock(
    theme.imaginationResearch ?? theme.research?.imagination,
    IMAGINATION_RESEARCH_WEIGHTS
  );
}

export function attachResearchScores(theme = {}) {
  const narrative = scoreNarrativeResearch(theme);
  const imagination = scoreImaginationResearch(theme);
  return {
    ...theme,
    narrativeScore:narrative.score,
    narrativeEvidence:narrative.evidence,
    imaginationScore:imagination.score,
    imaginationEvidence:imagination.evidence,
    researchQuality:{
      narrative:{complete:narrative.complete, confidence:narrative.confidence},
      imagination:{complete:imagination.complete, confidence:imagination.confidence}
    }
  };
}
