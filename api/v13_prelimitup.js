import { captureV13LiveSnapshot } from '../research/v13-limitup-precursor/live_snapshot.js';

export const config = { maxDuration: 60 };

function json(res, status, body) {
  res.setHeader?.('Cache-Control', 'no-store, max-age=0');
  res.setHeader?.('Content-Type', 'application/json; charset=utf-8');
  return res.status(status).json(body);
}

/**
 * Research-only live observation lane for 1–5 session pre-limit-up candidates.
 * It does not change or authorize the production executable signal.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const startedAt = Date.now();
  try {
    const snapshot = await captureV13LiveSnapshot({
      candidateLimit: 90,
      wideNewsScan: true,
      out: '/tmp/v13-prelimitup-' + startedAt + '.json'
    });
    const ranking = Array.isArray(snapshot?.rankings?.coreSelection) ? snapshot.rankings.coreSelection : [];
    const catalysts = Array.isArray(snapshot?.rankings?.catalystConfirmed) ? snapshot.rankings.catalystConfirmed : [];
    const emotionRepair = Array.isArray(snapshot?.rankings?.emotionRepair) ? snapshot.rankings.emotionRepair : [];
    const oversold = Array.isArray(snapshot?.rankings?.oversold) ? snapshot.rankings.oversold : [];
    const preBreakout = Array.isArray(snapshot?.rankings?.preBreakoutWatch) ? snapshot.rankings.preBreakoutWatch : [];
    const limitUpIgnition = Array.isArray(snapshot?.rankings?.limitUpIgnitionWatch) ? snapshot.rankings.limitUpIgnitionWatch : [];
    const nextDayLimitUp = Array.isArray(snapshot?.rankings?.nextDayLimitUpWatch) ? snapshot.rankings.nextDayLimitUpWatch : [];
    const actionPlan = snapshot?.nextDayActionPlan ?? {};
    const actionByCode = new Map((Array.isArray(actionPlan.currentActions) ? actionPlan.currentActions : [])
      .map(item => [String(item?.code ?? ''), item]));
    const compact = (rows, lane) => rows.slice(0, 12).map((row, index) => {
      const nextAction = actionByCode.get(String(row?.code ?? '')) ?? {};
      return ({
      rank: Number(row?.rank) || index + 1,
      code: String(row?.code ?? ''),
      name: String(row?.name ?? row?.code ?? ''),
      board: row?.board ?? null,
      score: Number.isFinite(Number(row?.selectionScore)) ? Number(row.selectionScore)
        : Number.isFinite(Number(row?.score)) ? Number(row.score) : null,
      selectionScore: Number.isFinite(Number(row?.selectionScore)) ? Number(row.selectionScore) : null,
      modelScore: Number.isFinite(Number(row?.score)) ? Number(row.score) : null,
      scorePath: row?.scorePath ?? lane,
      setup: row?.setup ?? null,
      quote: row?.quote ?? {},
      confidence: Number.isFinite(Number(row?.confidence)) ? Number(row.confidence) : null,
      primaryTheme: row?.leaderEvidence?.themeName ?? row?.psychology?.primaryTheme ?? row?.primaryTheme ?? null,
      selection: row?.selection ?? null,
      leaderEvidence: row?.leaderEvidence ?? null,
      riskReward: row?.riskReward ?? null,
      relativeStrengthPercentile: Number.isFinite(Number(row?.relativeStrengthPercentile)) ? Number(row.relativeStrengthPercentile) : null,
      trendScore: Number.isFinite(Number(row?.components?.trend)) ? Number(row.components.trend) : null,
      flowScore: Number.isFinite(Number(row?.components?.flow)) ? Number(row.components.flow) : null,
      sectorScore: Number.isFinite(Number(row?.components?.sector)) ? Number(row.components.sector) : null,
      catalystRankScore: Number.isFinite(Number(row?.catalystRankScore)) ? Number(row.catalystRankScore) : null,
      policyScore: Number.isFinite(Number(row?.components?.policyAlignment)) ? Number(row.components.policyAlignment) : null,
      marketFitScore: Number.isFinite(Number(row?.components?.marketFit)) ? Number(row.components.marketFit) : null,
      policyThemes: (row?.policyAlignment?.matchedThemes ?? []).slice(0, 3).map(theme => ({
        label: theme.label, score: theme.score, evidenceType: theme.evidenceType,
        matchedKeywords: theme.matchedKeywords ?? [], policy: theme.policy ?? null
      })),
      policyEvidenceAvailable: row?.policyAlignment?.evidenceAvailable === true,
      catalystEvidence: (row?.catalystEvidence ?? []).slice(0, 2),
      riskFlags: row?.riskFlags ?? [],
      executionEligible: row?.executionEligible === true,
      entryEligible: row?.entryEligible === true,
      entryGateReasons: Array.isArray(row?.entryGateReasons) ? row.entryGateReasons.slice(0, 8) : [],
      nextDayAction: nextAction.action ?? null,
      nextDayActionLabel: nextAction.label ?? null,
      nextDayActionReason: nextAction.reason ?? null
    });
    });
    const compactPreBreakout = preBreakout.slice(0, 15).map((row, index) => ({
      rank: Number(row?.rank) || index + 1,
      code: String(row?.code ?? ''),
      name: String(row?.name ?? row?.code ?? ''),
      board: row?.board ?? null,
      score: Number.isFinite(Number(row?.score)) ? Number(row.score) : null,
      confidence: Number.isFinite(Number(row?.confidence)) ? Number(row.confidence) : null,
      evidenceCoverage: Number.isFinite(Number(row?.evidenceCoverage ?? row?.confidence))
        ? Number(row?.evidenceCoverage ?? row?.confidence) : null,
      stage: row?.stage ?? null,
      themeName: row?.themeName ?? null,
      leaderVerified: row?.leaderVerified === true,
      policyVerified: row?.policyVerified === true,
      components: row?.components ?? {},
      metrics: row?.metrics ?? {},
      triggerChecklist: row?.triggerChecklist ?? {},
      interpretation: row?.interpretation ?? '',
      passedGates: row?.passedGates ?? [],
      failedGates: row?.failedGates ?? []
    }));
    const compactLimitUpIgnition = limitUpIgnition.slice(0, 15).map((row, index) => ({
      rank: Number(row?.rank) || index + 1,
      code: String(row?.code ?? ''),
      name: String(row?.name ?? row?.code ?? ''),
      board: row?.board ?? null,
      currentPct: Number.isFinite(Number(row?.currentPct)) ? Number(row.currentPct) : null,
      score: Number.isFinite(Number(row?.score)) ? Number(row.score) : null,
      confidence: Number.isFinite(Number(row?.confidence)) ? Number(row.confidence) : null,
      stage: row?.stage ?? null,
      leaderVerified: row?.leaderVerified === true,
      themeName: row?.themeName ?? null,
      components: row?.components ?? {},
      evidence: row?.evidence ?? {},
      riskFlags: Array.isArray(row?.riskFlags) ? row.riskFlags.slice(0, 5) : [],
      action: row?.action ?? 'WATCH_NEXT_SESSION_CONFIRMATION',
      nextSessionChecklist: Array.isArray(row?.nextSessionChecklist) ? row.nextSessionChecklist : [],
      method: row?.method ?? 'heuristic-continuation-ranking-not-a-calibrated-limit-up-probability'
    }));
    const compactNextDayLimitUp = nextDayLimitUp.slice(0, 20).map((row, index) => ({
      rank:Number(row?.rank)||index+1,
      code:String(row?.code??''),
      name:String(row?.name??row?.code??''),
      board:row?.board??null,
      currentPct:Number.isFinite(Number(row?.currentPct))?Number(row.currentPct):null,
      score:Number.isFinite(Number(row?.score))?Number(row.score):null,
      confidence:Number.isFinite(Number(row?.confidence))?Number(row.confidence):null,
      path:row?.path??null,
      stage:row?.stage??null,
      themeName:row?.themeName??null,
      leaderVerified:row?.leaderVerified===true,
      signalBarComplete:row?.signalBarComplete===true,
      forecastStatus:row?.forecastStatus??snapshot?.nextDayForecastStatus??'UNKNOWN',
      components:row?.components??{},
      evidence:row?.evidence??{},
      riskFlags:Array.isArray(row?.riskFlags)?row.riskFlags.slice(0,6):[],
      failedGates:Array.isArray(row?.failedGates)?row.failedGates.slice(0,5):[],
      action:row?.action??'WATCH_NEXT_SESSION_CONFIRMATION',
      method:row?.method??'dual-path-next-session-limit-up-ranking-not-a-calibrated-probability'
    }));
    return json(res, 200, {
      schema: 'v13-prelimitup-watch-v1',
      status: snapshot?.recommendationsAvailable ? 'OBSERVATION_READY' : 'OBSERVATION_ONLY_QUALITY_GATE',
      qualityGatePassed: snapshot?.recommendationsAvailable === true,
      recommendationsAvailable: false,
      executionAllowed: false,
      capturedAt: snapshot?.capturedAt ?? new Date().toISOString(),
      asOf: snapshot?.asOf ?? null,
      nextDayForecastStatus:snapshot?.nextDayForecastStatus??'UNKNOWN',
      nextDayLimitUpSummary:snapshot?.coverage?{
        assessedCount:Number(snapshot.coverage.nextDayLimitUpAssessedCount)||0,
        passedGateCount:Number(snapshot.coverage.nextDayLimitUpPassedGateCount)||0,
        returnedCount:Number(snapshot.coverage.nextDayLimitUpWatchCount)||0,
        continuationCount:Number(snapshot.coverage.nextDayLimitUpContinuationCount)||0,
        prebreakoutCount:Number(snapshot.coverage.nextDayLimitUpPrebreakoutCount)||0
      }:{},
      marketRegime: snapshot?.marketRegime ?? null,
      policyFramework: snapshot?.policyFramework ?? null,
      elapsedMs: Date.now() - startedAt,
      quality: snapshot?.quality ?? {},
      coverage: snapshot?.coverage ?? {},
      selectionSummary: snapshot?.selectionSummary ?? {},
      preBreakoutSummary: snapshot?.preBreakoutSummary ?? {},
      limitUpIgnitionSummary: snapshot?.limitUpIgnitionSummary ?? {},
      limitUpIgnitionRanking: compactLimitUpIgnition,
      nextDayLimitUpRanking:compactNextDayLimitUp,
      nextDayLimitUpPolicy:'Dual-path next-session observation ranking. Before the daily bar closes it is provisional intraday only; after close it is still a heuristic watchlist, not a calibrated probability or buy signal.',
      limitUpIgnitionPolicy: 'Momentum-continuation watch only; not a calibrated probability or buy signal. Confirm next-session sector breadth, order-book/volume support and risk before any decision; do not chase a locked limit-up.',
      nextDayActionPlan: {
        status: actionPlan.status ?? 'CURRENT_ONLY_NO_PRIOR_SNAPSHOT',
        summary: actionPlan.summary ?? {},
        priorSnapshotAvailable: actionPlan.priorSnapshotAvailable === true,
        currentActions: compact(Array.isArray(actionPlan.currentActions) ? actionPlan.currentActions : [], 'next-day-action-plan'),
        priorDayFollowThrough: Array.isArray(actionPlan.priorDayFollowThrough) ? actionPlan.priorDayFollowThrough.slice(0, 15) : []
      },
      preBreakoutRanking: compactPreBreakout,
      preBreakoutPolicy: 'Pre-breakout observation only: compressed base near prior 20-day high, trend turn, sustained flow, sector strength, and dated policy/leader evidence. Wait for a close above resistance with volume/flow/sector confirmation; no buy order is authorized.',
      selectionPolicy: 'Four-layer strict selection: market regime; policy/trend/relative strength/theme leadership/sustained capital flow; risk-reward and overnight risk; decision tier. No candidates are added to fill empty slots.',
      scope: 'V13 research-only 1–5 session core-leader shortlist. It may return zero names when the hard gates are not met. This output never creates a buy order or changes the primary production signal.',
      ranking: compact(ranking, 'four-layer-core-leader-selection'),
      catalystRanking: compact(catalysts, 'diagnostic-timestamped-catalyst'),
      emotionRepair: compact(emotionRepair, 'emotion-repair-observation'),
      oversold: compact(oversold, 'oversold-observation')
    });
  } catch (error) {
    return json(res, 502, {
      schema: 'v13-prelimitup-watch-v1',
      status: 'SOURCE_OR_COMPUTE_FAILED',
      recommendationsAvailable: false,
      executionAllowed: false,
      elapsedMs: Date.now() - startedAt,
      error: String(error?.message ?? error).slice(0, 400),
      scope: 'Research-only observation. Failure never falls back to a fabricated list.'
    });
  }
}
