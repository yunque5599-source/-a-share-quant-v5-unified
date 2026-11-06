const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const num = value => finite(value) ? Number(value) : null;
const dateKey = value => String(value ?? '').slice(0, 10);
const mean = values => {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
};
function median(values) {
  const valid = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!valid.length) return null;
  const middle = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[middle] : (valid[middle - 1] + valid[middle]) / 2;
}

export const DEFAULT_NAME_THEME_DEFINITIONS = Object.freeze([
  {
    key: 'sheep_homophone',
    label: '羊／洋／阳字辈',
    tokens: ['羊', '洋', '阳'],
    classification: 'NAME_BASED',
    minMembers: 2
  },
  {
    key: 'wolf_name',
    label: '狼字辈',
    tokens: ['狼'],
    classification: 'NAME_BASED',
    minMembers: 2
  },
  {
    key: 'oriental_name',
    label: '东方字辈',
    tokens: ['东方'],
    classification: 'NAME_BASED',
    minMembers: 2
  }
]);

export function extractNarrativeTags(name, definitions = DEFAULT_NAME_THEME_DEFINITIONS) {
  const text = String(name ?? '').trim();
  if (!text) return [];
  return definitions
    .filter(theme => theme.tokens.some(token => text.includes(token)))
    .map(theme => theme.key);
}

function normalizedStocks(snapshot, theme) {
  const stocks = Array.isArray(snapshot?.stocks) ? snapshot.stocks : [];
  return stocks.map(row => {
    const tags = extractNarrativeTags(row?.name);
    return {
      code: String(row?.code ?? ''),
      name: String(row?.name ?? ''),
      pct: num(row?.pct ?? row?.changePct),
      amount: num(row?.amount),
      turnoverPct: num(row?.turnoverPct),
      nearLimitUpProxy: row?.nearLimitUpProxy === true,
      tags
    };
  }).filter(row => row.code && row.tags.includes(theme.key));
}

function snapshotThemeMetrics(snapshot, theme) {
  const stocks = normalizedStocks(snapshot, theme);
  const returns = stocks.map(row => row.pct).filter(Number.isFinite);
  const amounts = stocks.map(row => row.amount).filter(value => Number.isFinite(value) && value > 0).sort((a, b) => b - a);
  const totalAmount = amounts.reduce((sum, value) => sum + value, 0);
  const top3Amount = amounts.slice(0, 3).reduce((sum, value) => sum + value, 0);
  const memberCount = stocks.length;
  const knownReturns = returns.length;
  const activeCount = returns.filter(value => value > 0).length;
  const strongCount = returns.filter(value => value >= 3).length;
  const nearLimitCount = stocks.filter(row => row.nearLimitUpProxy).length;
  const advancersRatio = knownReturns ? activeCount / knownReturns : null;
  const strongRatio = knownReturns ? strongCount / knownReturns : null;
  const nearLimitRatio = memberCount ? nearLimitCount / memberCount : null;
  const medianReturn = median(returns);
  const heatParts = [];
  if (medianReturn !== null) heatParts.push([clamp(50 + medianReturn * 7), 0.30]);
  if (advancersRatio !== null) heatParts.push([advancersRatio * 100, 0.30]);
  if (strongRatio !== null) heatParts.push([strongRatio * 100, 0.20]);
  if (nearLimitRatio !== null) heatParts.push([nearLimitRatio * 100, 0.20]);
  const heatWeight = heatParts.reduce((sum, [, weight]) => sum + weight, 0);
  const heat = heatWeight
    ? heatParts.reduce((sum, [value, weight]) => sum + value * weight, 0) / heatWeight
    : null;
  return {
    stocks,
    memberCount,
    knownReturns,
    activeCount,
    strongCount,
    nearLimitCount,
    advancersRatio,
    strongRatio,
    nearLimitRatio,
    medianReturn,
    leaderConcentration: totalAmount > 0 ? top3Amount / totalAmount : null,
    heatScore: heat === null ? null : Number(clamp(heat).toFixed(2)),
    sourceScope: snapshot?.sourceScope ?? 'unknown'
  };
}

function cohortReturn(history, theme, lookback) {
  if (history.length < lookback) return null;
  const recent = history.slice(-lookback);
  const maps = recent.map(snapshot => new Map(
    normalizedStocks(snapshot, theme)
      .filter(row => row.pct !== null)
      .map(row => [row.code, row])
  ));
  if (maps.some(map => map.size === 0)) return null;
  const commonCodes = [...maps[0].keys()].filter(code => maps.every(map => map.has(code)));
  if (commonCodes.length < 2) return null;
  const returns = commonCodes.map(code => {
    let wealth = 1;
    for (const map of maps) wealth *= 1 + map.get(code).pct / 100;
    return (wealth - 1) * 100;
  });
  return median(returns);
}

function verifiedFundamentalOverlap(theme, stocks, evidence, asOf) {
  const codes = new Set(stocks.map(row => row.code));
  const verified = (Array.isArray(evidence) ? evidence : []).filter(item => {
    if (item?.verified !== true || !/^https?:\/\//i.test(String(item?.sourceUrl ?? ''))) return false;
    const eventDate = dateKey(item.eventDate ?? item.publishedAt);
    if (asOf && eventDate && eventDate > asOf) return false;
    const themeMatch = String(item.themeKey ?? '') === theme.key;
    const stockMatch = Array.isArray(item.stockCodes) && item.stockCodes.some(code => codes.has(String(code)));
    return themeMatch || stockMatch;
  });
  if (!verified.length) return {score: null, count: 0, status: 'NOT_MEASURABLE'};
  const relevance = verified.map(item => num(item.relevanceScore))
    .filter(value => value !== null)
    .map(value => clamp(value));
  if (!relevance.length) return {score: null, count: verified.length, status: 'NOT_MEASURABLE'};
  return {
    score: Number(mean(relevance).toFixed(2)),
    count: verified.length,
    status: 'MEASURABLE'
  };
}

function exhaustionRisk({history, theme, current, previous, median3d, median5d}) {
  if (history.length < 3 || median3d === null) {
    return {score: null, status: 'NOT_MEASURABLE', components: {}};
  }
  const parts = [];
  const components = {};
  if (median3d !== null) {
    components.runup3d = clamp((median3d - 5) * 5);
    parts.push([components.runup3d, 0.25]);
  }
  if (median5d !== null) {
    components.runup5d = clamp((median5d - 8) * 3.5);
    parts.push([components.runup5d, 0.15]);
  }
  if (current.advancersRatio !== null && previous?.advancersRatio !== null && previous?.advancersRatio !== undefined) {
    const delta = current.advancersRatio - previous.advancersRatio;
    components.participationContraction = clamp(50 - delta * 180);
    parts.push([components.participationContraction, 0.20]);
  }
  if (current.leaderConcentration !== null) {
    components.leaderConcentration = clamp((current.leaderConcentration - 0.35) * 150);
    parts.push([components.leaderConcentration, 0.15]);
  }
  if (current.nearLimitRatio !== null) {
    components.nearLimitCrowding = clamp((current.nearLimitRatio - 0.05) * 300);
    parts.push([components.nearLimitCrowding, 0.10]);
  }
  if (median3d >= 8 && current.medianReturn !== null && current.medianReturn < 0) {
    components.runupThenFade = 90;
    parts.push([90, 0.15]);
  }
  const totalWeight = parts.reduce((sum, [, weight]) => sum + weight, 0);
  if (!totalWeight) return {score: null, status: 'NOT_MEASURABLE', components};
  return {
    score: Number(clamp(parts.reduce((sum, [value, weight]) => sum + value * weight, 0) / totalWeight).toFixed(2)),
    status: 'MEASURABLE',
    components
  };
}

export function scoreNarrativeThemes({
  snapshots = [],
  asOf = null,
  definitions = DEFAULT_NAME_THEME_DEFINITIONS,
  verifiedEvidence = []
} = {}) {
  const cutoff = dateKey(asOf);
  const cutoffTimestamp = asOf && String(asOf).length > 10 ? Date.parse(String(asOf)) : null;
  const history = (Array.isArray(snapshots) ? snapshots : [])
    .filter(snapshot => {
      const date = dateKey(snapshot?.tradeDate ?? snapshot?.date);
      if (!date || (cutoff && date > cutoff)) return false;
      if (cutoffTimestamp !== null && snapshot?.capturedAt) {
        const capturedAt = Date.parse(snapshot.capturedAt);
        if (!Number.isFinite(capturedAt) || capturedAt > cutoffTimestamp) return false;
      }
      return true;
    })
    .sort((a, b) => dateKey(a.tradeDate ?? a.date).localeCompare(dateKey(b.tradeDate ?? b.date)))
    .slice(-5);
  const latest = history.at(-1) ?? null;
  const previousSnapshot = history.at(-2) ?? null;
  const themes = definitions.map(theme => {
    const current = latest ? snapshotThemeMetrics(latest, theme) : snapshotThemeMetrics({}, theme);
    const previous = previousSnapshot ? snapshotThemeMetrics(previousSnapshot, theme) : null;
    const diffusionDelta = previous && previous.memberCount > 0 && current.advancersRatio !== null && previous.advancersRatio !== null
      ? current.advancersRatio - previous.advancersRatio
      : null;
    const activeCountDelta = previous ? current.activeCount - previous.activeCount : null;
    const diffusion = diffusionDelta === null ? null
      : Number(clamp(50 + diffusionDelta * 120 + (activeCountDelta ?? 0) * 2).toFixed(2));
    const median3d = cohortReturn(history, theme, 3);
    const median5d = cohortReturn(history, theme, 5);
    const exhaustion = exhaustionRisk({history, theme, current, previous, median3d, median5d});
    const fundamental = verifiedFundamentalOverlap(theme, current.stocks, verifiedEvidence, cutoff || dateKey(latest?.tradeDate));
    const fullMarket = current.sourceScope === 'full-market';
    const sourceQuality = fullMarket ? 1 : current.sourceScope === 'partial-market' ? 0.55 : 0.35;
    const confidence = current.memberCount >= 5 ? 90 : current.memberCount >= 3 ? 75 : current.memberCount >= theme.minMembers ? 60 : 0;
    const adjustedConfidence = Number((confidence * sourceQuality).toFixed(2));
    let stage = 'INACTIVE';
    if (current.memberCount >= theme.minMembers) {
      if (exhaustion.score !== null && exhaustion.score >= 75) stage = 'EXHAUSTION_RISK';
      else if (current.heatScore !== null && current.heatScore >= 65 && diffusion !== null && diffusion >= 65) stage = 'DIFFUSING';
      else if (current.heatScore !== null && current.heatScore >= 65) stage = 'HOT';
      else if (current.activeCount >= 2 && current.medianReturn !== null && current.medianReturn > 0) stage = 'EARLY';
    }
    return {
      theme_key: theme.key,
      theme_label: theme.label,
      classification: theme.classification ?? 'NAME_BASED',
      member_count: current.memberCount,
      active_count: current.activeCount,
      strong_count: current.strongCount,
      near_limit_up_proxy_count: current.nearLimitCount,
      median_1d_return_pct: current.medianReturn === null ? null : Number(current.medianReturn.toFixed(2)),
      advancers_ratio: current.advancersRatio,
      name_theme_heat_score: current.heatScore,
      theme_diffusion_speed: diffusion,
      theme_diffusion_delta_pp: diffusionDelta === null ? null : Number((diffusionDelta * 100).toFixed(2)),
      active_count_delta: activeCountDelta,
      leader_concentration: current.leaderConcentration === null ? null : Number((current.leaderConcentration * 100).toFixed(2)),
      fundamental_overlap_score: fundamental.score,
      fundamental_overlap_count: fundamental.count,
      fundamental_overlap_status: fundamental.status,
      speculative_exhaustion_risk: exhaustion.score,
      speculative_exhaustion_status: exhaustion.status,
      speculative_exhaustion_components: exhaustion.components,
      median_3d_cohort_return_pct: median3d === null ? null : Number(median3d.toFixed(2)),
      median_5d_cohort_return_pct: median5d === null ? null : Number(median5d.toFixed(2)),
      stage,
      confidence: adjustedConfidence,
      source_scope: current.sourceScope,
      status: current.memberCount ? 'AVAILABLE' : 'NO_MATCHES'
    };
  });
  return {
    schema: 'ashare-v16-narrative-theme-v1',
    asOf: dateKey(latest?.tradeDate ?? asOf) || null,
    snapshot_count: history.length,
    themes,
    limitations: [
      'Name-based membership is a lexical match, not evidence of a shared industry, product, earnings driver or corporate relationship.',
      '羊／洋／阳 are grouped as a homophone-style name cluster; matches are intentionally broad and require manual review.',
      'Theme diffusion and speculative exhaustion require consecutive point-in-time snapshots; missing history is NOT_MEASURABLE.',
      'Leader concentration uses reported turnover amount and is not a measure of beneficial ownership or institutional control.',
      'Near-limit counts are approximate proxies until board, ST and new-listing rules are verified.',
      'Fundamental overlap is NOT_MEASURABLE unless a verified, dated source and explicit stock/theme mapping are supplied.'
    ]
  };
}

export const _internal = {snapshotThemeMetrics, cohortReturn, exhaustionRisk, verifiedFundamentalOverlap};
