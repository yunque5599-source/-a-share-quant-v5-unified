import {earlyTrend} from './v16_early_trend.js';
import {evaluateMarketTransition} from './v16/market_transition.js';
import {scoreSectorRotation} from './v16/sector_rotation.js';
import {scoreCandidateFundingEvidence} from './v16/flow_lhb.js';
import {classifyVolumePricePhase} from './v16/volume_price_phase.js';

const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const num = value => finite(value) ? Number(value) : null;
const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
const mean = values => {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
};
const dateKey = value => String(value ?? '').slice(0, 10);
const sortSessions = rows => (Array.isArray(rows) ? rows : []).filter(Boolean)
  .slice().sort((a, b) => dateKey(a.tradeDate ?? a.date).localeCompare(dateKey(b.tradeDate ?? b.date)));

export function rankEarlyTrendPrefilter(stockRows, {limit = 30, excludeCodes = [], sectorRows = [], marketAveragePct = null} = {}) {
  const excluded = new Set((Array.isArray(excludeCodes) ? excludeCodes : []).map(String));
  const sectorByName = new Map((Array.isArray(sectorRows) ? sectorRows : []).map(row => [String(row.key ?? row.label ?? ''), row]));
  const candidates = [];
  for (const row of Array.isArray(stockRows) ? stockRows : []) {
    const code = String(row?.code ?? '');
    const name = String(row?.name ?? code);
    if (!/^(0|3|6)\d{5}$/.test(code) || excluded.has(code) || row?.specialTreatment === true || /(?:\*?ST|退)/i.test(name)) continue;
    const pct = num(row.pct);
    const amount = num(row.amount);
    const turnover = num(row.turn);
    const mainNet = num(row.mainNet);
    const mainPct = num(row.mainPct);
    const pct60 = num(row.pct60);
    if (pct === null || amount === null || amount < 30000000 || turnover === null || turnover < 0 || turnover > 20) continue;
    if (pct < -4.5 || pct > 6.5 || !((mainNet ?? 0) > 0 || (mainPct ?? 0) > 0)) continue;

    const flowRatio = mainNet !== null && amount > 0 ? mainNet / amount : null;
    const flowScore = flowRatio === null ? null : clamp(48 + flowRatio * 320);
    const dailyMoveScore = clamp(84 - Math.abs(pct - 1.2) * 5.5 - Math.max(0, pct - 4) * 7 - Math.max(0, -pct - 2) * 4);
    const mediumTrendScore = pct60 === null ? null
      : clamp(50 + pct60 * 0.65 - Math.max(0, pct60 - 30) * 1.3 - Math.max(0, -pct60 - 15) * 0.6);
    const turnoverScore = clamp(82 - Math.abs(turnover - 5) * 2.2 - Math.max(0, turnover - 12) * 3.5);
    const sector = sectorByName.get(String(row.industry ?? ''));
    const sectorParts = sector ? [
      num(sector.advancersRatio) === null ? null : clamp(num(sector.advancersRatio) * 100),
      num(sector.positiveFlowRatio) === null ? null : clamp(num(sector.positiveFlowRatio) * 100),
      num(sector.d1Pct) === null || num(marketAveragePct) === null
        ? null : clamp(50 + (num(sector.d1Pct) - num(marketAveragePct)) * 4)
    ].filter(Number.isFinite) : [];
    const sectorScore = sectorParts.length ? mean(sectorParts) : null;
    const components = [
      [flowScore, 0.30],
      [dailyMoveScore, 0.20],
      [mediumTrendScore, 0.20],
      [turnoverScore, 0.15],
      [sectorScore, 0.15]
    ].filter(([value]) => Number.isFinite(value));
    const weight = components.reduce((sum, [, partWeight]) => sum + partWeight, 0);
    if (weight < 0.60) continue;
    const score = components.reduce((sum, [value, partWeight]) => sum + value * partWeight, 0) / weight;
    const reasons = [];
    if ((mainNet ?? 0) > 0) reasons.push('当日主力资金净流入');
    if ((mainPct ?? 0) > 0) reasons.push('主力资金占比为正');
    if (pct >= -2 && pct <= 3.5) reasons.push('当日涨幅未明显扩张');
    if (pct60 !== null && pct60 > 0 && pct60 < 35) reasons.push('中期趋势未明显过热');
    if (sectorScore !== null && sectorScore >= 55) reasons.push('所属行业当日广度/资金相对较强');
    candidates.push({
      code, name, industry: String(row.industry ?? '未知'),
      price: num(row.price), pct, amount, turn: turnover, mainNet, mainPct, pct60,
      flowRatio, prefilterScore: Number(score.toFixed(2)),
      prefilterCoverage: Number(weight.toFixed(3)),
      prefilterReasons: reasons,
      source: 'EASTMONEY_FULL_MARKET_CROSS_SECTION',
      calibration: 'NOT_CALIBRATED',
      use: 'DEEP_SCAN_PREFILTER_ONLY'
    });
  }
  candidates.sort((a, b) => b.prefilterScore - a.prefilterScore || a.code.localeCompare(b.code));
  return {
    status: candidates.length ? 'AVAILABLE' : 'NO_CANDIDATES',
    method: 'EARLY_FLOW_CROSS_SECTION_PREFILTER_V1',
    candidateCount: candidates.length,
    rows: candidates.slice(0, Math.max(1, Math.min(100, Math.floor(Number(limit) || 30)))),
    limitations: [
      'This is a candidate-recall prefilter, not the final selection score or a return probability.',
      'The flow field is a vendor-derived daily estimate, not verified institutional holdings.',
      'A one-day inflow is not treated as multi-session funding persistence.'
    ]
  };
}

export function aggregateIndustryRows(stockRows) {
  const groups = new Map();
  for (const row of Array.isArray(stockRows) ? stockRows : []) {
    const industry = String(row?.industry ?? '').trim() || '行业未知';
    if (!groups.has(industry)) groups.set(industry, {
      industry, sampleCount: 0, flowCount: 0, returnCount: 0,
      netFlowCny: 0, amountCny: 0, positiveFlowCount: 0, advancerCount: 0,
      returnSumPct: 0, leaderPct: null, turnoverSum: 0, turnoverCount: 0
    });
    const group = groups.get(industry);
    group.sampleCount += 1;
    const mainNet = num(row.mainNet);
    const amount = num(row.amount);
    const pct = num(row.pct);
    const turnover = num(row.turn);
    if (mainNet !== null && amount !== null && amount > 0) {
      group.flowCount += 1;
      group.netFlowCny += mainNet;
      group.amountCny += amount;
      if (mainNet > 0) group.positiveFlowCount += 1;
    }
    if (pct !== null) {
      group.returnCount += 1;
      group.returnSumPct += pct;
      if (pct > 0) group.advancerCount += 1;
      group.leaderPct = group.leaderPct === null ? pct : Math.max(group.leaderPct, pct);
    }
    if (turnover !== null) {
      group.turnoverSum += turnover;
      group.turnoverCount += 1;
    }
  }
  return [...groups.values()].map(group => {
    const avgReturnPct = group.returnCount ? group.returnSumPct / group.returnCount : null;
    return {
      ...group,
      flowRatio: group.amountCny > 0 ? group.netFlowCny / group.amountCny : null,
      positiveFlowRatio: group.flowCount ? group.positiveFlowCount / group.flowCount : null,
      advancersRatio: group.returnCount ? group.advancerCount / group.returnCount : null,
      avgReturnPct,
      leaderRelativeStrengthPct: avgReturnPct === null || group.leaderPct === null ? null : group.leaderPct - avgReturnPct,
      averageTurnoverPct: group.turnoverCount ? group.turnoverSum / group.turnoverCount : null
    };
  }).sort((a, b) => b.netFlowCny - a.netFlowCny);
}

function sectorDailyPulse(row, marketAveragePct) {
  if (!row) return null;
  const parts = [];
  if (finite(row.advancersRatio)) parts.push(clamp(Number(row.advancersRatio) * 100));
  if (finite(row.positiveFlowRatio)) parts.push(clamp(Number(row.positiveFlowRatio) * 100));
  if (finite(row.d1Pct) && finite(marketAveragePct)) parts.push(clamp(50 + (Number(row.d1Pct) - Number(marketAveragePct)) * 4));
  if (finite(row.leaderRelativeStrengthPct)) parts.push(clamp(50 + Number(row.leaderRelativeStrengthPct) * 4));
  return parts.length ? Number(mean(parts).toFixed(2)) : null;
}

function summarizeIndustryWindow(window, industry) {
  if (!Array.isArray(window) || ![3, 5].includes(window.length)) return null;
  const rows = window.map(session => aggregateIndustryRows(session.rows).find(row => row.industry === industry) ?? null);
  const complete = rows.length === window.length && rows.every(row =>
    row && row.sampleCount >= 5 && row.flowCount >= 5 && row.returnCount >= 5);
  if (!complete) return null;
  const flowPositiveDays = rows.filter(row => row.netFlowCny > 0).length;
  const netFlowCny = rows.reduce((sum, row) => sum + row.netFlowCny, 0);
  const amount = rows.reduce((sum, row) => sum + row.amountCny, 0);
  const netFlowRatio = amount > 0 ? netFlowCny / amount : null;
  const positiveFlowRatio = mean(rows.map(row => row.positiveFlowRatio));
  const upShare = mean(rows.map(row => row.advancersRatio));
  const returnPct = (rows.reduce((acc, row) => acc * (1 + (row.avgReturnPct ?? 0) / 100), 1) - 1) * 100;
  const minimumPositiveDays = window.length === 3 ? 2 : 3;
  const persistent = netFlowCny > 0 && flowPositiveDays >= minimumPositiveDays
    && positiveFlowRatio !== null && positiveFlowRatio >= 0.5;
  const rebound = persistent && returnPct > 0 && upShare !== null && upShare >= 0.55;
  const status = rebound ? 'REBOUND_CONFIRMED'
    : persistent ? 'PERSISTENT_INFLOW'
    : netFlowCny < 0 && flowPositiveDays <= 1 ? 'PERSISTENT_OUTFLOW' : 'MIXED';
  const score = clamp(
    50 + (netFlowRatio ?? 0) * 400
    + ((flowPositiveDays / window.length) - 0.5) * 35
    + ((positiveFlowRatio ?? 0.5) - 0.5) * 30
    + ((upShare ?? 0.5) - 0.5) * 30
    + returnPct * 1.5
  );
  return {
    historySessions: window.length, status, flowPositiveDays,
    netFlowCny, netFlowRatio, positiveFlowRatio, upShare,
    returnPct: Number(returnPct.toFixed(2)),
    persistenceScore: Number(score.toFixed(2))
  };
}

export function buildSectorFlowEvidence({
  currentRows = [], priorSnapshots = [], currentQualified = false, currentTradeDate = null,
  currentSectorRows = [], marketAveragePct = null
} = {}) {
  const prior = sortSessions(priorSnapshots).filter(snapshot => dateKey(snapshot.tradeDate) < dateKey(currentTradeDate));
  const lastTwo = prior.slice(-2);
  const lastFour = prior.slice(-4);
  const priorWindowValid3 = lastTwo.length === 2 && lastTwo.every(snapshot =>
    snapshot?.quality?.qualifiedForReplay === true && Array.isArray(snapshot.stockRows));
  const priorWindowValid5 = lastFour.length === 4 && lastFour.every(snapshot =>
    snapshot?.quality?.qualifiedForReplay === true && Array.isArray(snapshot.stockRows));
  const currentWindowValid = currentQualified === true && Array.isArray(currentRows);
  const window3 = priorWindowValid3 && currentWindowValid
    ? [...lastTwo.map(snapshot => ({tradeDate: snapshot.tradeDate, rows: snapshot.stockRows})),
       {tradeDate: currentTradeDate, rows: currentRows}]
    : [];
  const window5 = priorWindowValid5 && currentWindowValid
    ? [...lastFour.map(snapshot => ({tradeDate: snapshot.tradeDate, rows: snapshot.stockRows})),
       {tradeDate: currentTradeDate, rows: currentRows}]
    : [];
  const currentAgg = aggregateIndustryRows(currentRows);
  const currentByIndustry = new Map(currentAgg.map(row => [row.industry, row]));
  const sectorByIndustry = new Map((Array.isArray(currentSectorRows) ? currentSectorRows : [])
    .map(row => [String(row.key ?? row.label ?? ''), row]));
  const industries = new Set([...currentByIndustry.keys(), ...sectorByIndustry.keys()]);
  const output = [];
  for (const industry of industries) {
    const current = currentByIndustry.get(industry) ?? null;
    const sector = sectorByIndustry.get(industry) ?? null;
    const dailyPulseScore = sectorDailyPulse(sector, marketAveragePct);
    const metrics3 = summarizeIndustryWindow(window3, industry);
    const metrics5 = summarizeIndustryWindow(window5, industry);
    const status = metrics3?.status ?? (current && current.netFlowCny > 0
      ? (currentQualified ? 'ONE_DAY_INFLOW' : 'PARTIAL_ONE_DAY_INFLOW') : 'INSUFFICIENT_HISTORY');
    output.push({
      industry,
      status,
      status5: metrics5?.status ?? 'INSUFFICIENT_HISTORY',
      historySessions: metrics3?.historySessions ?? (current ? 1 : 0),
      historySessions5: metrics5?.historySessions ?? 0,
      dailyNetFlowCny: current?.netFlowCny ?? null,
      dailyFlowRatio: current?.flowRatio ?? null,
      dailyPositiveFlowRatio: current?.positiveFlowRatio ?? null,
      dailyUpShare: current?.advancersRatio ?? null,
      dailyReturnPct: current?.avgReturnPct ?? num(sector?.d1Pct),
      dailyPulseScore,
      flowPositiveDays: metrics3?.flowPositiveDays ?? null,
      netFlow3Cny: metrics3?.netFlowCny ?? null,
      netFlowRatio3: metrics3?.netFlowRatio ?? null,
      positiveFlowRatio3: metrics3?.positiveFlowRatio ?? null,
      upShare3: metrics3?.upShare ?? null,
      return3Pct: metrics3?.returnPct ?? null,
      persistenceScore: metrics3?.persistenceScore ?? null,
      flowPositiveDays5: metrics5?.flowPositiveDays ?? null,
      netFlow5Cny: metrics5?.netFlowCny ?? null,
      netFlowRatio5: metrics5?.netFlowRatio ?? null,
      positiveFlowRatio5: metrics5?.positiveFlowRatio ?? null,
      upShare5: metrics5?.upShare ?? null,
      return5Pct: metrics5?.returnPct ?? null,
      persistenceScore5: metrics5?.persistenceScore ?? null,
      sampleCount: current?.sampleCount ?? null,
      sourceScope: currentQualified ? 'QUALIFIED_FULL_MARKET' : 'CURRENT_CROSS_SECTION_ONLY'
    });
  }
  return output.sort((a, b) =>
    (b.persistenceScore5 ?? b.persistenceScore ?? b.dailyPulseScore ?? -1)
      - (a.persistenceScore5 ?? a.persistenceScore ?? a.dailyPulseScore ?? -1)
    || a.industry.localeCompare(b.industry));
}

function snapshotMarketSession(snapshot) {
  const market = snapshot?.market ?? {};
  const sectors = Array.isArray(market.sectors) ? market.sectors : [];
  const sectorBreadth = mean(sectors.map(row => num(row.advancersRatio)).filter(Number.isFinite));
  const sectorFlow = mean(sectors.map(row => num(row.positiveFlowRatio)).filter(Number.isFinite));
  const leaderRs = sectors.map(row => num(row.leaderRelativeStrengthPct)).filter(Number.isFinite);
  return {
    date: snapshot.tradeDate,
    d1Pct: num(market.marketAveragePct),
    breadth: market.breadth ?? {},
    indices: market.indices ?? [],
    turnover: market.turnover ?? {},
    sentiment: market.sentiment ?? {},
    sectors: {
      breadthRatio: sectorBreadth,
      positiveFlowRatio: sectorFlow,
      topSectorRepeatDays: 0,
      leaderRelativeStrengthPct: leaderRs.length ? Math.max(...leaderRs) : null,
      sourceScope: market.breadth?.universe ?? 'unknown'
    },
    leaders: market.leaders ?? [],
    dataQuality: {degraded: snapshot.quality?.qualifiedForReplay !== true}
  };
}

function currentMarketSession(context) {
  const a = context?.aShare ?? {};
  const sectors = Array.isArray(a.sectors) ? a.sectors : [];
  const sectorBreadth = mean(sectors.map(row => num(row.advancersRatio)).filter(Number.isFinite));
  const sectorFlow = mean(sectors.map(row => num(row.positiveFlowRatio)).filter(Number.isFinite));
  const leaderRs = sectors.map(row => num(row.leaderRelativeStrengthPct)).filter(Number.isFinite);
  const full = a.breadth?.fullMarket === true && num(a.breadth?.coverage) >= 0.99;
  return {
    date: context.aShareSessionDate,
    d1Pct: num(a.marketAveragePct),
    breadth: a.breadth ?? {},
    indices: a.indices ?? [],
    turnover: a.turnover ?? {},
    sentiment: a.sentiment ?? {},
    sectors: {
      breadthRatio: sectorBreadth,
      positiveFlowRatio: sectorFlow,
      topSectorRepeatDays: 0,
      leaderRelativeStrengthPct: leaderRs.length ? Math.max(...leaderRs) : null,
      sourceScope: a.breadth?.universe ?? 'unknown'
    },
    leaders: a.leaders ?? [],
    dataQuality: {degraded: !full}
  };
}

function currentSnapshotQualified(context, asOf) {
  const a = context?.aShare ?? {};
  const capturedAt = Date.parse(context?.capturedAt ?? '');
  const asOfMs = Date.parse(asOf ?? '');
  const collectionFinishedAt = Date.parse(a.source?.collectionFinishedAt ?? '');
  if (!Number.isFinite(capturedAt) || !Number.isFinite(asOfMs) || capturedAt > asOfMs
    || asOfMs - capturedAt > 15 * 60 * 1000
    || (Number.isFinite(collectionFinishedAt) && asOfMs - collectionFinishedAt > 15 * 60 * 1000)) return false;
  const rows = Array.isArray(a.stockRows) ? a.stockRows : [];
  const quoteRows = rows.filter(row => Number.isFinite(Date.parse(row?.quoteAt ?? '')));
  const sameDateRows = quoteRows.filter(row => {
    const quoteDate = new Date(Date.parse(row.quoteAt) + 8 * 3600000).toISOString().slice(0, 10);
    return quoteDate === dateKey(context.aShareSessionDate);
  });
  const quoteCoverage = quoteRows.length / Math.max(1, rows.length);
  const sameDateCoverage = sameDateRows.length / Math.max(1, rows.length);
  return context?.chinaCloseFinalized === true
    && a.dataStatus === 'FINALIZED_SESSION'
    && a.breadth?.fullMarket === true
    && num(a.breadth?.coverage) >= 0.99
    && a.source?.complete === true
    && rows.length >= 500
    && quoteCoverage >= 0.95
    && sameDateCoverage >= 0.95;
}

function scoreLiquidity(row, latestBar) {
  const amount = num(row?.amount) ?? num(latestBar?.amount);
  const turnover = num(row?.turn) ?? num(latestBar?.turnover);
  if (amount === null || amount <= 0) return null;
  let score = amount >= 1000000000 ? 95 : amount >= 300000000 ? 85
    : amount >= 100000000 ? 75 : amount >= 50000000 ? 65 : amount >= 30000000 ? 55 : 35;
  if (turnover !== null && turnover > 15) score -= Math.min(25, (turnover - 15) * 2);
  if (turnover !== null && turnover < 0.5) score -= 10;
  return clamp(score);
}

function relativeStrengthScore(trend, context) {
  if (!trend || trend.insufficient || !finite(trend.ret5)) return null;
  const index = (context?.aShare?.indices ?? []).find(row => row.key === 'shanghai')
    ?? (context?.aShare?.indices ?? []).find(row => /上证/.test(String(row.name ?? '')));
  const benchmark5 = num(index?.trend5Pct);
  const stock5 = Number(trend.ret5) * 100;
  const marketFallback = num(context?.aShare?.marketAveragePct);
  const relative = benchmark5 !== null ? stock5 - benchmark5
    : marketFallback !== null ? stock5 - marketFallback : null;
  return relative === null ? null : clamp(50 + relative * 4);
}

export function buildV17OneClickSelection({context, snapshots = [], asOf = null} = {}) {
  if (!context?.aShare || !context.aShareSessionDate) throw new TypeError('Current V16 market context is required');
  if (typeof asOf !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(asOf) || !Number.isFinite(Date.parse(asOf)))
    throw new TypeError('Explicit timezone-aware asOf is required');
  const a = context.aShare;
  const tradeDate = dateKey(context.aShareSessionDate);
  const allSnapshots = sortSessions(snapshots).filter(snapshot => dateKey(snapshot.tradeDate) < tradeDate);
  const currentQualified = currentSnapshotQualified(context, asOf);
  const latestTwo = allSnapshots.slice(-2);
  const priorWindowValid = latestTwo.length === 2 && latestTwo.every(snapshot =>
    snapshot?.quality?.qualifiedForReplay === true && Array.isArray(snapshot.stockRows));
  const persistencePrior = priorWindowValid ? latestTwo : [];
  const currentSession = {tradeDate, stockRows: a.stockRows ?? [], lhb: a.lhb ?? null};
  const fundingSessions = currentQualified ? [...persistencePrior, currentSession] : [];
  const sectorEvidence = buildSectorFlowEvidence({
    currentRows: a.stockRows ?? [],
    priorSnapshots: allSnapshots,
    currentQualified,
    currentTradeDate: tradeDate,
    currentSectorRows: a.sectors ?? [],
    marketAveragePct: a.marketAveragePct
  });

  const marketHistory = allSnapshots.slice(-4).map(snapshotMarketSession);
  const currentSessionMarket = currentMarketSession(context);
  const market = evaluateMarketTransition({
    sessions: [...marketHistory, currentSessionMarket],
    asOf: tradeDate
  });
  const previousSectorRows = latestTwo.at(-1)?.quality?.qualifiedForReplay === true
    ? (latestTwo.at(-1)?.market?.sectors ?? []) : [];
  const rotation = scoreSectorRotation({
    sectors: a.sectors ?? [],
    previousSectors: previousSectorRows,
    market: currentSessionMarket
  });
  const rotationByIndustry = new Map(rotation.sectors.map(row => [row.key, row]));
  const sectorByIndustry = new Map(sectorEvidence.map(row => [row.industry, row]));
  const stockByCode = new Map((a.stockRows ?? []).map(row => [String(row.code), row]));
  const rawRows = [
    ...(Array.isArray(a.volumePhaseRows) ? a.volumePhaseRows.map(row => ({...row, candidateSource: 'V15_STAGE1_TOP50'})) : []),
    ...(Array.isArray(a.earlyTrendRows) ? a.earlyTrendRows.map(row => ({...row, candidateSource: 'V17_EARLY_FLOW_PREFILTER'})) : [])
  ];
  const deduped = new Map();
  for (const row of rawRows) {
    const code = String(row.code ?? '');
    if (!code) continue;
    const prior = deduped.get(code);
    if (!prior) deduped.set(code, row);
    else {
      const combinedSource = prior.candidateSource === row.candidateSource
        ? prior.candidateSource : 'V15_STAGE1_TOP50+V17_EARLY_FLOW_PREFILTER';
      const preferred = row.candidateSource === 'V17_EARLY_FLOW_PREFILTER' ? row : prior;
      deduped.set(code, {...preferred, candidateSource: combinedSource});
    }
  }

  const candidates = [];
  for (const row of deduped.values()) {
    if (row.status !== 'AVAILABLE' || !Array.isArray(row.bars)) continue;
    const visibleBars = row.bars.filter(bar => bar && /^\d{4}-\d{2}-\d{2}$/.test(String(bar.date ?? ''))
      && Number.isFinite(Date.parse(bar.availableAt ?? ''))
      && Date.parse(bar.availableAt) <= Date.parse(asOf)
      && Date.parse(bar.date + 'T15:00:00+08:00') <= Date.parse(asOf))
      .slice().sort((left, right) => left.date.localeCompare(right.date));
    if (visibleBars.length < 65 || visibleBars.at(-1)?.date !== tradeDate) continue;
    const code = String(row.code);
    const stock = stockByCode.get(code) ?? row;
    const latestBar = visibleBars.at(-1);
    const previousBar = visibleBars.at(-2);
    const quoteTimestamp = Date.parse(stock?.quoteAt ?? '');
    const quoteDate = Number.isFinite(quoteTimestamp)
      ? new Date(quoteTimestamp + 8 * 3600000).toISOString().slice(0, 10) : null;
    const currentQuoteAligned = quoteDate === tradeDate;
    const barPct = previousBar && num(previousBar.close) > 0 && num(latestBar.close) !== null
      ? (num(latestBar.close) / num(previousBar.close) - 1) * 100 : null;
    const currentPrice = (currentQuoteAligned ? num(stock.price) : null) ?? num(latestBar.close);
    const currentPct = (currentQuoteAligned ? num(stock.pct) : null) ?? barPct;
    const currentTurn = (currentQuoteAligned ? num(stock.turn) : null) ?? num(latestBar.turnover);
    const liquidityRow = currentQuoteAligned ? stock : {amount: latestBar.amount, turn: latestBar.turnover};
    const trend = earlyTrend(visibleBars);
    if (trend.insufficient) continue;
    const phase = row.phase?.status === 'AVAILABLE'
      ? row.phase
      : classifyVolumePricePhase(visibleBars, {asOf, expectedDate: tradeDate, breakoutLevel: trend.resistance20});
    const funding = scoreCandidateFundingEvidence({
      code, sessions: fundingSessions, asOf: tradeDate, includeInstitutionalLhb: false
    });
    const industry = sectorByIndustry.get(String(stock.industry ?? row.industry ?? '未知')) ?? null;
    const rotationRow = rotationByIndustry.get(String(stock.industry ?? row.industry ?? '未知')) ?? null;
    const trendScore = num(trend.score);
    const flowScore = funding.status === 'AVAILABLE' ? num(funding.fundingScore) : null;
    const industryPersistenceScore = num(industry?.persistenceScore5) ?? num(industry?.persistenceScore);
    const industryScore = industryPersistenceScore ?? num(industry?.dailyPulseScore) ?? num(rotationRow?.opportunity_score);
    const industryWeight = industryPersistenceScore !== null ? 20 : industryScore !== null ? 10 : 0;
    const rsScore = relativeStrengthScore(trend, context);
    const liquidityScore = scoreLiquidity(liquidityRow, latestBar);
    const components = [
      [trendScore, 35],
      [flowScore, 25],
      [industryScore, industryWeight],
      [rsScore, 10],
      [liquidityScore, 10]
    ].filter(([value, weight]) => Number.isFinite(value) && weight > 0);
    const coverage = components.reduce((sum, [, weight]) => sum + weight, 0);
    const rawScore = coverage ? components.reduce((sum, [value, weight]) => sum + value * weight, 0) / coverage : null;
    const limitPoolsCurrent = dateKey(a.limitPools?.tradeDate) === tradeDate;
    const limitUpCodes = new Set((limitPoolsCurrent ? (a.limitPools?.limitUp ?? []) : []).map(item => String(item.code)));
    const limitDownCodes = new Set((limitPoolsCurrent ? (a.limitPools?.limitDown ?? []) : []).map(item => String(item.code)));
    const atLimitUp = limitUpCodes.has(code);
    const atLimitDown = limitDownCodes.has(code);
    const riskFlags = [];
    let penalty = 0;
    if (trend.failed || phase.classification === 'DISTRIBUTION_RISK' || atLimitDown) {
      riskFlags.push('TREND_OR_PRICE_STRUCTURE_INVALID');
      penalty += 25;
    }
    if (trend.phase === 'D') { riskFlags.push('ACCELERATION_RISK'); penalty += 14; }
    if (trend.phase === 'E') { riskFlags.push('OVERHEATED'); penalty += 25; }
    if (funding.persistentOutflow || funding.reversal) { riskFlags.push('FLOW_REVERSAL_OR_OUTFLOW'); penalty += 18; }
    if (industry?.status === 'PERSISTENT_OUTFLOW') { riskFlags.push('INDUSTRY_PERSISTENT_OUTFLOW'); penalty += 12; }
    if (currentTurn !== null && currentTurn >= 20) { riskFlags.push('HIGH_TURNOVER'); penalty += 10; }
    if (currentPct !== null && currentPct >= 6.5) { riskFlags.push('DAILY_MOVE_NO_CHASE'); penalty += 18; }
    if (atLimitUp) { riskFlags.push('LIMIT_UP_NO_CHASE'); penalty += 25; }
    if (market.trade_permission === 'NO_NEW_RISK' || market.trade_permission === 'REDUCE_RISK') {
      riskFlags.push('MARKET_RISK_GATE');
      penalty += 20;
    }
    const score = rawScore === null ? null : Number(clamp(rawScore - penalty).toFixed(2));
    let state = 'WATCH';
    if (trend.failed || phase.classification === 'DISTRIBUTION_RISK' || atLimitDown) state = 'INVALIDATED';
    else if (trend.phase === 'D' || trend.phase === 'E' || atLimitUp || (currentPct !== null && currentPct >= 6.5)) state = 'AVOID_CHASE';
    else if (['B', 'C'].includes(trend.phase) && funding.status === 'AVAILABLE'
      && ['PERSISTENT_INFLOW', 'REBOUND_CONFIRMED'].includes(industry?.status)
      && ['SELECTIVE', 'PROBE_ONLY'].includes(market.trade_permission) && coverage >= 80) {
      const newsAndFundamentalsComplete = a.newsAndFundamentalsComplete === true;
      state = trend.phase === 'C' && industry.status === 'REBOUND_CONFIRMED' && newsAndFundamentalsComplete
        ? 'CONFIRMED' : 'TRIGGERED';
    }
    const reasons = [
      ...trend.reasons,
      ...(funding.status === 'AVAILABLE' ? ['近3个合格交易日资金持续性与更高低点通过'] : ['多日资金证据不足，不把单日净流入当作持续吸筹']),
      ...(industry?.status === 'REBOUND_CONFIRMED' ? ['行业3日资金与上涨广度同步改善'] :
        industry?.status === 'PERSISTENT_INFLOW' ? ['行业3日资金持续净流入'] : ['行业多日资金持续性尚未核验']),
      ...(phase.reasons ?? [])
    ];
    candidates.push({
      code, name: String(stock.name ?? row.name ?? code), industry: String(stock.industry ?? row.industry ?? '未知'),
      price: currentPrice,
      pct: currentPct, quoteAligned: currentQuoteAligned, score, dataCoverage: Number((coverage / 100).toFixed(2)),
      state, trendPhase: trend.phase, trendScore,
      return5Pct: finite(trend.ret5) ? Number((trend.ret5 * 100).toFixed(2)) : null,
      deviation20Pct: finite(trend.deviation20) ? Number((trend.deviation20 * 100).toFixed(2)) : null,
      flowEvidence: funding, industryEvidence: industry,
      sectorRotationScore: rotationRow?.opportunity_score ?? null,
      relativeStrengthScore: rsScore, liquidityScore,
      volumePricePhase: phase.classification ?? 'NOT_MEASURABLE',
      volumePriceMetrics: phase.metrics ?? null,
      riskFlags, penalty: Number(penalty.toFixed(2)), reasons,
      candidateSource: row.candidateSource,
      rank: null, buyPlanEligible: false, execution: 'SHADOW_NO_ORDERS'
    });
  }
  const priority = {TRIGGERED: 0, CONFIRMED: 1, WATCH: 2, AVOID_CHASE: 3, INVALIDATED: 4};
  candidates.sort((a, b) => (priority[a.state] ?? 9) - (priority[b.state] ?? 9)
    || (b.score ?? -1) - (a.score ?? -1) || a.code.localeCompare(b.code));
  candidates.forEach((row, index) => { row.rank = index + 1; });
  const fullUniverse = a.breadth?.fullMarket === true && num(a.breadth?.coverage) >= 0.99;
  const decision = fullUniverse && currentQualified && candidates.length ? 'OBSERVE' : 'WAIT';
  const archiveSessions = allSnapshots.filter(snapshot => snapshot?.quality?.qualifiedForReplay === true).length;
  const latestFour = allSnapshots.slice(-4);
  const fiveSessionWindowAvailable = latestFour.length === 4
    && latestFour.every(snapshot => snapshot?.quality?.qualifiedForReplay === true) && currentQualified;
  return {
    schema: 'ashare-v17-one-click-selection-v1',
    modelVersion: 'V17.0.0-one-click-shadow',
    asOf,
    tradeDate,
    decision,
    market: {
      regime: market.regime,
      classificationStatus: market.classification_status,
      score: market.market_regime_score,
      transitionScore: market.market_transition_score,
      reversalRisk: market.market_reversal_risk,
      confidence: market.confidence,
      coverage: market.coverage,
      permission: market.trade_permission,
      warnings: market.data_warnings
    },
    universe: {
      scope: a.breadth?.universe ?? 'unknown',
      fullMarket: fullUniverse,
      coverage: num(a.breadth?.coverage),
      uniqueSymbols: a.breadth?.uniqueSymbols ?? a.stockRows?.length ?? 0,
      reportedTotal: a.breadth?.totalReported ?? null,
      pagesFetched: a.source?.pagesFetched ?? null,
      pageCount: a.source?.pageCount ?? null,
      complete: a.source?.complete === true,
      candidateUniverse: 'V15_STAGE1_TOP50 + V17_SH_SZ_EARLY_FLOW_PREFILTER_TOP30',
      candidateScanCount: candidates.length,
      earlyTrendDiagnostics: a.earlyTrendDiagnostics ?? null
    },
    sectors: sectorEvidence.slice(0, 30),
    sectorRotation: rotation.sectors.slice(0, 20),
    candidates: candidates.slice(0, 50),
    top10: candidates.slice(0, 10),
    top30: candidates.slice(0, 30),
    top50: candidates.slice(0, 50),
    archive: {
      loadedSnapshotCount: allSnapshots.length,
      qualifiedSessionCount: archiveSessions,
      latestSnapshotDate: allSnapshots.at(-1)?.tradeDate ?? null,
      persistenceWindowAvailable: persistencePrior.length === 2 && currentQualified,
      fiveSessionPersistenceWindowAvailable: fiveSessionWindowAvailable,
      requiredQualifiedPriorSessions: 2,
      requiredQualifiedPriorSessions5: 4,
      status: persistencePrior.length === 2 && currentQualified ? 'AVAILABLE' : 'INSUFFICIENT_HISTORY'
    },
    capabilities: {
      fullMarketUniverse: fullUniverse ? 'MEASURABLE' : 'PARTIAL',
      dailyKlines: a.earlyTrendDiagnostics?.status ?? 'NOT_MEASURABLE',
      threeSessionStockFlow: persistencePrior.length === 2 && currentQualified ? 'MEASURABLE' : 'NOT_MEASURABLE',
      threeSessionIndustryFlow: persistencePrior.length === 2 && currentQualified ? 'MEASURABLE' : 'NOT_MEASURABLE',
      fiveSessionIndustryFlow: fiveSessionWindowAvailable ? 'MEASURABLE' : 'NOT_MEASURABLE',
      lhb: a.lhb?.dailyStatus ?? 'NOT_MEASURABLE',
      limitUpDailyProxy: a.limitPools?.sourceStatus?.limitUp === 'AVAILABLE' ? 'VENDOR_DAILY_PROXY_UNCALIBRATED' : 'NOT_MEASURABLE',
      intradaySealQuality: 'NOT_MEASURABLE',
      level2CancellationRisk: 'NOT_MEASURABLE',
      newsAndFundamentals: a.newsAndFundamentalsComplete === true ? 'MEASURABLE' : 'NOT_MEASURABLE'
    },
    warnings: [
      ...(fullUniverse ? [] : ['当前全市场覆盖不足99%，候选列表不能称为全市场排名']),
      ...(currentQualified ? [] : ['当前收盘快照未通过全市场点时质量门槛，禁止确认多日资金信号']),
      ...(persistencePrior.length === 2 ? [] : ['最近两个归档交易日不完整或未通过质量门槛，3日资金/行业持续性不可测']),
      ...(fiveSessionWindowAvailable ? [] : ['最近四个归档交易日未全部通过质量门槛，5日行业资金持续性不可测']),
      '主力资金为供应商估算口径，不等于机构真实持仓或账户净流入。',
      '候选初筛来自V15 Stage1 Top50与V17沪深支持代码早期资金预筛Top30的并集；北交所代码未纳入当前深度扫描，不代表全市场每只股票均已完成65日线深度扫描。',
      '分数是研究排序分，不是上涨概率；当前版本不输出买入价、止损价、目标价或仓位。',
      '分钟线、集合竞价、盘口撤单、新闻和财务点时数据未接入，不得据此宣称具备盘中预警或完整基本面风控。'
    ],
    execution: 'SHADOW_NO_ORDERS',
    productionOverride: false
  };
}
