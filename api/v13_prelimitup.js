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
    const compact = (rows, lane) => rows.slice(0, 12).map((row, index) => ({
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
      executionEligible: row?.executionEligible === true
    }));
    return json(res, 200, {
      schema: 'v13-prelimitup-watch-v1',
      status: snapshot?.recommendationsAvailable ? 'OBSERVATION_READY' : 'OBSERVATION_ONLY_QUALITY_GATE',
      qualityGatePassed: snapshot?.recommendationsAvailable === true,
      recommendationsAvailable: false,
      executionAllowed: false,
      capturedAt: snapshot?.capturedAt ?? new Date().toISOString(),
      asOf: snapshot?.asOf ?? null,
      marketRegime: snapshot?.marketRegime ?? null,
      policyFramework: snapshot?.policyFramework ?? null,
      elapsedMs: Date.now() - startedAt,
      quality: snapshot?.quality ?? {},
      coverage: snapshot?.coverage ?? {},
      selectionSummary: snapshot?.selectionSummary ?? {},
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
