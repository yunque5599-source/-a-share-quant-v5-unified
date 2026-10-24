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
    const ranking = Array.isArray(snapshot?.rankings?.overall) ? snapshot.rankings.overall : [];
    const catalysts = Array.isArray(snapshot?.rankings?.catalystConfirmed) ? snapshot.rankings.catalystConfirmed : [];
    const emotionRepair = Array.isArray(snapshot?.rankings?.emotionRepair) ? snapshot.rankings.emotionRepair : [];
    const oversold = Array.isArray(snapshot?.rankings?.oversold) ? snapshot.rankings.oversold : [];
    const compact = (rows, lane) => rows.slice(0, 12).map((row, index) => ({
      rank: Number(row?.rank) || index + 1,
      code: String(row?.code ?? ''),
      name: String(row?.name ?? row?.code ?? ''),
      board: row?.board ?? null,
      score: Number.isFinite(Number(row?.score)) ? Number(row.score) : null,
      scorePath: row?.scorePath ?? lane,
      setup: row?.setup ?? null,
      quote: row?.quote ?? {},
      confidence: Number.isFinite(Number(row?.confidence)) ? Number(row.confidence) : null,
      primaryTheme: row?.psychology?.primaryTheme ?? row?.primaryTheme ?? null,
      catalystRankScore: Number.isFinite(Number(row?.catalystRankScore)) ? Number(row.catalystRankScore) : null,
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
      elapsedMs: Date.now() - startedAt,
      quality: snapshot?.quality ?? {},
      coverage: snapshot?.coverage ?? {},
      scope: 'V13 research-only 1–5 session watchlist. It may include non-main-board names for discovery; this output never creates a buy order or changes the primary production signal.',
      ranking: compact(ranking, 'balanced-blend'),
      catalystRanking: compact(catalysts, 'timestamped-catalyst-confirmed'),
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
