import {evaluateMarketTransition} from './market_transition.js';
import {evaluateOvernightGlobalImpact} from './overnight_global_impact.js';
import {scoreSectorRotation} from './sector_rotation.js';

const dateKey = value => String(value ?? '').slice(0, 10);

function capabilityStatus(snapshot, market, overnight, sector) {
  const fullBreadth = snapshot.market?.breadth?.universe === 'full-market'
    || snapshot.market?.breadth?.fullMarket === true;
  const openingMeasured = Object.values(overnight.industries ?? {})
    .some(row => row.a_share_open_status === 'MEASURABLE');
  return {
    marketRegime: market.market_regime_score === null ? 'NOT_MEASURABLE'
      : fullBreadth && market.confidence >= 50 ? 'MEASURABLE' : 'PARTIAL',
    overnightImpact: overnight.overnight_impact_score === null ? 'NOT_MEASURABLE'
      : overnight.factor_coverage && Object.values(overnight.factor_coverage).some(value => value >= 0.5) ? 'PARTIAL_OR_MEASURABLE' : 'PARTIAL',
    sectorRotation: sector.previous_snapshot_available ? 'MEASURABLE' : 'PARTIAL',
    aShareOpen: openingMeasured ? 'MEASURABLE' : 'NOT_MEASURABLE',
    fullMarketBreadth: fullBreadth ? 'MEASURABLE' : 'NOT_MEASURABLE',
    brokenBoardRate: finiteOrStatus(snapshot.market?.sentiment?.brokenBoardRate) ? 'MEASURABLE' : 'NOT_MEASURABLE',
    nextDayPremium: finiteOrStatus(snapshot.market?.sentiment?.nextDayPremiumPct) ? 'MEASURABLE' : 'NOT_MEASURABLE'
  };
}
function finiteOrStatus(value) {
  return value !== null && value !== undefined && value !== '' && value !== 'NOT_MEASURABLE' && Number.isFinite(Number(value));
}

export function replayV16Snapshots({snapshots = [], asOf = null} = {}) {
  const cutoff = dateKey(asOf);
  const cutoffTimestamp = asOf ? (String(asOf).length > 10 ? String(asOf) : String(asOf) + 'T23:59:59') : null;
  const eligible = (Array.isArray(snapshots) ? snapshots : [])
    .filter(snapshot => snapshot && dateKey(snapshot.tradeDate ?? snapshot.date)
      && (!cutoff || dateKey(snapshot.tradeDate ?? snapshot.date) <= cutoff)
      && (!snapshot.capturedAt || !cutoffTimestamp || (Number.isFinite(Date.parse(snapshot.capturedAt)) && Date.parse(snapshot.capturedAt) <= Date.parse(cutoffTimestamp))))
    .sort((a, b) => dateKey(a.tradeDate ?? a.date).localeCompare(dateKey(b.tradeDate ?? b.date)));
  const reports = [];
  const marketSessions = [];
  let previousSectors = [];
  for (const snapshot of eligible) {
    const date = dateKey(snapshot.tradeDate ?? snapshot.date);
    const marketSession = {...(snapshot.market ?? {}), date};
    marketSessions.push(marketSession);
    const market = evaluateMarketTransition({sessions: marketSessions, asOf: date});
    const overnight = evaluateOvernightGlobalImpact({
      us: snapshot.us ?? {},
      industryMap: snapshot.industryMap,
      aShareOpen: snapshot.aShareOpen ?? null
    });
    const sector = scoreSectorRotation({
      sectors: snapshot.sectors ?? [],
      previousSectors,
      market: snapshot.marketSummary ?? {}
    });
    const capabilities = capabilityStatus(snapshot, market, overnight, sector);
    const statuses = Object.values(capabilities);
    const status = statuses.every(value => value === 'MEASURABLE') ? 'MEASURABLE'
      : statuses.some(value => value === 'MEASURABLE' || value === 'PARTIAL' || value === 'PARTIAL_OR_MEASURABLE') ? 'PARTIAL' : 'NOT_MEASURABLE';
    reports.push({
      tradeDate: date,
      capturedAt: snapshot.capturedAt ?? null,
      status,
      market,
      overnight,
      sector,
      capabilities
    });
    previousSectors = Array.isArray(snapshot.sectors) ? snapshot.sectors : [];
  }
  return {
    schema: 'ashare-v16-point-in-time-replay-v1',
    asOf: cutoff || null,
    inputSnapshotCount: Array.isArray(snapshots) ? snapshots.length : 0,
    replayedSnapshotCount: reports.length,
    excludedFutureSnapshotCount: Math.max(0, (Array.isArray(snapshots) ? snapshots.length : 0) - eligible.length),
    reports,
    limitations: [
      'Only archived snapshots captured on or before the replay date are accepted.',
      'A daily close cannot be used to reconstruct auction, first-15-minute, VWAP, order-book or cancellation signals.',
      'Candidate-pool breadth is not whole-market breadth and cannot support full-market recall claims.',
      'Unknown limit-up labels and unavailable next-day outcomes are not counted as misses.'
    ]
  };
}

export function buildNov4Nov5ValidationReport({snapshots = []} = {}) {
  const requiredDates = ['2026-11-04', '2026-11-05'];
  const byDate = new Map((Array.isArray(snapshots) ? snapshots : [])
    .map(row => [dateKey(row.tradeDate ?? row.date), row]));
  const missingDates = requiredDates.filter(date => !byDate.has(date));
  const replay = replayV16Snapshots({snapshots: requiredDates.map(date => byDate.get(date)).filter(Boolean), asOf: '2026-11-05'});
  return {
    schema: 'ashare-v16-nov4-nov5-validation-v1',
    requiredDates,
    status: missingDates.length ? 'NOT_MEASURABLE' : replay.reports.every(row => row.status === 'MEASURABLE') ? 'MEASURABLE' : 'PARTIAL',
    missingPointInTimeSnapshotDates: missingDates,
    replay,
    prohibitedClaims: missingDates.length
      ? ['Do not claim that the model correctly predicted 2026-11-04 or 2026-11-05 market breadth, opening absorption, or stock-level outcomes without the missing point-in-time snapshots.']
      : []
  };
}
