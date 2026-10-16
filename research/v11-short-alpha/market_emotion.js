import { clamp, finiteNumber, round } from './schema.js';

const n = finiteNumber;
const list = value => Array.isArray(value) ? value : [];
const mean = values => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const median = values => {
  const sorted = [...values].sort((a,b) => a-b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid-1] + sorted[mid]) / 2;
};

function indexRows(indices) {
  return list(indices).map(row => ({
    name:String(row?.name ?? row?.id ?? ''),
    pct:n(row?.pct ?? row?.changePct)
  })).filter(row => row.pct !== null);
}

function candidatePcts(candidates) {
  return list(candidates).map(row => n(
    row?.f3 ?? row?.pct ?? row?.changePct
  )).filter(value => value !== null);
}

/**
 * Global market emotion proxy.
 *
 * This is intentionally not labelled "market breadth": the ranked candidate pool
 * is selected rather than the full A-share universe. Index direction is therefore
 * the dominant input, while the ranked pool contributes a smaller hot-money proxy.
 */
export function buildMarketEmotion(indices = [], candidates = []) {
  const ix = indexRows(indices);
  const cp = candidatePcts(candidates);
  const indexMeanPct = mean(ix.map(row => row.pct));
  const indexPositiveRatio = ix.length
    ? ix.filter(row => row.pct > 0).length / ix.length : null;
  const rankedMedianPct = median(cp);
  const rankedPositiveRatio = cp.length
    ? cp.filter(value => value > 0).length / cp.length : null;
  const hotRatio = cp.length
    ? cp.filter(value => value >= 5).length / cp.length : null;
  const panicRatio = cp.length
    ? cp.filter(value => value <= -3).length / cp.length : null;

  const indexDirectionScore = indexMeanPct === null
    ? null : clamp(50 + indexMeanPct * 12);
  const indexParticipationScore = indexPositiveRatio === null
    ? null : clamp(indexPositiveRatio * 100);
  const rankedHeatScore = rankedMedianPct === null
    ? null : clamp(50 + rankedMedianPct * 8);
  const rankedParticipationScore = rankedPositiveRatio === null
    ? null : clamp(rankedPositiveRatio * 100);

  const parts = [
    ['indexDirection', indexDirectionScore, 0.55],
    ['indexParticipation', indexParticipationScore, 0.25],
    ['rankedPoolHeat', rankedHeatScore, 0.10],
    ['rankedPoolParticipation', rankedParticipationScore, 0.10]
  ].filter(([, value]) => value !== null);

  if (panicRatio !== null) {
    const panicPenalty = Math.min(10, panicRatio * 20);
    parts.push(['panicPenalty', -panicPenalty, 1]);
  }
  if (hotRatio !== null) {
    const hotBonus = Math.min(6, hotRatio * 12);
    parts.push(['hotMoneyBonus', hotBonus, 1]);
  }

  if (!parts.length) {
    return {
      score:null, label:'UNKNOWN', confidence:0,
      components:{}, diagnostics:{indexCount:0, rankedPoolCount:0},
      source:'index-plus-ranked-pool-proxy-v1'
    };
  }

  const base = parts.filter(([key]) => key !== 'panicPenalty' && key !== 'hotMoneyBonus');
  const baseWeight = base.reduce((sum, [, , weight]) => sum + weight, 0);
  let score = base.reduce((sum, [, value, weight]) => sum + value * weight, 0) /
    Math.max(0.0001, baseWeight);
  const panic = parts.find(([key]) => key === 'panicPenalty')?.[1] ?? 0;
  const hot = parts.find(([key]) => key === 'hotMoneyBonus')?.[1] ?? 0;
  score = clamp(score + panic + hot);

  const label = (
    score >= 82 && ((hotRatio !== null && hotRatio >= 0.55) ||
      (indexPositiveRatio !== null && indexPositiveRatio >= 0.75))
  ) || score >= 90 ? 'FEVER'
    : score >= 65 ? 'RISING'
      : score >= 55 ? 'NEUTRAL'
        : score >= 45 ? 'FADING' : 'PANIC';

  return {
    score:round(score),
    label,
    confidence:ix.length >= 4 && cp.length >= 20 ? 0.90 : ix.length >= 3 ? 0.75 : ix.length >= 2 ? 0.65 : 0.55,
    components:{
      indexDirection:{score:indexDirectionScore, weight:0.55},
      indexParticipation:{score:indexParticipationScore, weight:0.25},
      rankedPoolHeat:{score:rankedHeatScore, weight:0.10},
      rankedPoolParticipation:{score:rankedParticipationScore, weight:0.10},
      hotMoneyBonus:{score:hot > 0 ? hot : 0, weight:0},
      panicPenalty:{score:panic, weight:0}
    },
    diagnostics:{
      indexCount:ix.length,
      rankedPoolCount:cp.length,
      indexMeanPct,
      indexPositiveRatio,
      rankedMedianPct,
      rankedPositiveRatio,
      hotRatio,
      panicRatio
    },
    source:'index-plus-ranked-pool-proxy-v1'
  };
}

export const _internal = { indexRows, candidatePcts, buildMarketEmotion };
