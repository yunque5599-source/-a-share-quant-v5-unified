import {buildV17OneClickSelection} from './v17_one_click_selection.js';
import {rankV15Stage1Candidates} from './v16/selection_backtest.js';

const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const num = value => finite(value) ? Number(value) : null;
const mean = values => {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
};
const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const dateOf = snapshot => String(snapshot?.tradeDate ?? '').slice(0, 10);
const supportedCode = code => /^(0|3|6)\d{5}$/.test(String(code ?? ''));
const mainBoardCode = code => /^(00|60)\d{4}$/.test(String(code ?? ''));
const tradable = row => supportedCode(row?.code)
  && row?.specialTreatment !== true && !/(?:\*?ST|退)/i.test(String(row?.name ?? ''));

function qualified(snapshot) {
  return snapshot?.quality?.qualifiedForReplay === true
    && snapshot?.sourceScope === 'full-market'
    && Array.isArray(snapshot?.stockRows)
    && snapshot.stockRows.length >= 500;
}

function dedupeSnapshots(snapshots, asOf) {
  const cutoff = String(asOf ?? '').slice(0, 10);
  const grouped = new Map();
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    const date = dateOf(snapshot);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || (cutoff && date > cutoff)) continue;
    if (!grouped.has(date)) grouped.set(date, []);
    grouped.get(date).push(snapshot);
  }
  return [...grouped.values()].map(group => {
    const usable = group.filter(qualified);
    const candidates = usable.length ? usable : group;
    return candidates.slice().sort((a, b) =>
      Date.parse(a.capturedAt ?? '') - Date.parse(b.capturedAt ?? '')).at(-1);
  }).sort((a, b) => dateOf(a).localeCompare(dateOf(b)));
}

function contextFromSnapshot(snapshot) {
  const quality = snapshot?.quality ?? {};
  const market = snapshot?.market ?? {};
  return {
    capturedAt: snapshot.capturedAt,
    chinaCalendarDate: dateOf(snapshot),
    chinaCloseFinalized: quality.qualifiedForReplay === true,
    aShareSessionDate: dateOf(snapshot),
    aShare: {
      dataStatus: quality.qualifiedForReplay === true ? 'FINALIZED_SESSION' : 'PARTIAL',
      breadth: market.breadth ?? {},
      source: {
        complete: quality.sourceComplete === true,
        collectionStartedAt: quality.collectionStartedAt ?? null,
        collectionFinishedAt: quality.collectionFinishedAt ?? snapshot.capturedAt,
        pagesFetched: snapshot.source?.pagesFetched ?? null,
        pageCount: snapshot.source?.pageCount ?? null
      },
      stockRows: snapshot.stockRows ?? [],
      sectors: market.sectors ?? [],
      marketAveragePct: market.marketAveragePct ?? null,
      indices: market.indices ?? [],
      turnover: market.turnover ?? {},
      sentiment: market.sentiment ?? {},
      volumePhaseRows: snapshot.volumePhaseRows ?? [],
      volumePhaseDiagnostics: snapshot.volumePhaseDiagnostics ?? {},
      earlyTrendRows: snapshot.earlyTrendRows ?? [],
      earlyTrendDiagnostics: snapshot.earlyTrendDiagnostics ?? {},
      limitPools: market.limitPools ?? {},
      lhb: market.lhb ?? {},
      newsAndFundamentalsComplete: false
    }
  };
}

function signalAsOf(snapshot) {
  const captured = Date.parse(snapshot?.capturedAt ?? '');
  return Number.isFinite(captured) ? new Date(captured + 60_000).toISOString() : null;
}

function rowsByCode(snapshot) {
  return new Map((Array.isArray(snapshot?.stockRows) ? snapshot.stockRows : [])
    .filter(tradable).map(row => [String(row.code), row]));
}

function momentumCandidates(snapshot) {
  return (Array.isArray(snapshot?.stockRows) ? snapshot.stockRows : [])
    .filter(row => tradable(row)
      && num(row.amount) !== null && num(row.amount) >= 30_000_000
      && num(row.turn) !== null && num(row.turn) >= 0 && num(row.turn) <= 20
      && num(row.pct) !== null && num(row.pct) >= -4.5 && num(row.pct) <= 6.5
      && num(row.pct60) !== null)
    .slice().sort((a, b) => (num(b.pct60) - num(a.pct60))
      || (num(b.pct) - num(a.pct)) || String(a.code).localeCompare(String(b.code)))
    .map(row => ({code: String(row.code), name: String(row.name ?? row.code), score: num(row.pct60)}));
}

function dailyOutcome(selected, future, horizon, costBps) {
  const futureMaps = future.map(rowsByCode);
  const outcomes = [];
  for (const candidate of selected) {
    const code = String(candidate.code);
    const path = futureMaps.map(rows => rows.get(code) ?? null);
    if (path.some(row => !row)) continue;
    const entryOpen = num(path[0]?.open);
    const exitClose = num(path[horizon - 1]?.price ?? path[horizon - 1]?.close);
    const closes = path.map(row => num(row?.price ?? row?.close));
    const highs = path.map(row => num(row?.high));
    const lows = path.map(row => num(row?.low));
    if (entryOpen === null || entryOpen <= 0 || exitClose === null || exitClose <= 0
      || closes.some(value => value === null || value <= 0)) continue;
    const grossReturnPct = (exitClose / entryOpen - 1) * 100;
    let peak = 1;
    let maxDrawdownPct = 0;
    for (const close of closes) {
      const wealth = close / entryOpen;
      peak = Math.max(peak, wealth);
      maxDrawdownPct = Math.min(maxDrawdownPct, (wealth / peak - 1) * 100);
    }
    outcomes.push({
      code, grossReturnPct, netReturnPct: grossReturnPct - costBps / 100,
      maxDrawdownPct,
      maxFavorablePct: highs.every(Number.isFinite) ? (Math.max(...highs) / entryOpen - 1) * 100 : null,
      maxAdversePct: lows.every(Number.isFinite) ? (Math.min(...lows) / entryOpen - 1) * 100 : null
    });
  }

  const benchmarkCodes = [...futureMaps[0].keys()];
  const benchmark = [];
  for (const code of benchmarkCodes) {
    const path = futureMaps.map(rows => rows.get(code) ?? null);
    if (path.some(row => !row)) continue;
    const entryOpen = num(path[0]?.open);
    const exitClose = num(path[horizon - 1]?.price ?? path[horizon - 1]?.close);
    if (entryOpen === null || entryOpen <= 0 || exitClose === null || exitClose <= 0) continue;
    benchmark.push((exitClose / entryOpen - 1) * 100 - costBps / 100);
  }
  return {outcomes, benchmark};
}

function limitUpEvents(future) {
  const events = new Set();
  for (const snapshot of future) {
    const pools = snapshot?.market?.limitPools;
    const status = pools?.sourceStatus?.limitUp ?? (pools?.status === 'AVAILABLE' ? 'AVAILABLE' : 'NOT_MEASURABLE');
    if (status !== 'AVAILABLE') return {status: 'NOT_MEASURABLE', events: []};
    for (const row of Array.isArray(pools?.limitUp) ? pools.limitUp : []) {
      if (supportedCode(row.code) && !/(?:\*?ST|退)/i.test(String(row.name ?? '')))
        events.add(String(row.code));
    }
  }
  return {status: 'AVAILABLE', events: [...events]};
}

function metricForSelection(selected, future, horizon, costBps) {
  if (!selected.length) return {status: 'NO_CANDIDATES', horizon, selectedCount: 0, maturedCount: 0, coverage: 0};
  const result = dailyOutcome(selected, future, horizon, costBps);
  const gross = result.outcomes.map(row => row.grossReturnPct);
  const net = result.outcomes.map(row => row.netReturnPct);
  const benchmarkMean = mean(result.benchmark);
  const exact = limitUpEvents(future);
  const selectedCodes = new Set(selected.map(row => String(row.code)));
  const captured = exact.status === 'AVAILABLE'
    ? exact.events.filter(code => selectedCodes.has(code)).length : null;
  return {
    status: result.outcomes.length === selected.length ? 'MEASURABLE' : 'PARTIAL',
    horizon, selectedCount: selected.length, maturedCount: result.outcomes.length,
    coverage: selected.length ? result.outcomes.length / selected.length : 0,
    meanGrossReturnPct: mean(gross), meanNetReturnPct: mean(net), medianNetReturnPct: median(net),
    positiveRatio: net.length ? net.filter(value => value > 0).length / net.length : null,
    hit5PctRatio: net.length ? net.filter(value => value >= 5).length / net.length : null,
    benchmarkMeanNetPct: benchmarkMean,
    excessMeanPct: mean(net) === null || benchmarkMean === null ? null : mean(net) - benchmarkMean,
    meanMaxDrawdownPct: mean(result.outcomes.map(row => row.maxDrawdownPct)),
    meanMaxFavorablePct: mean(result.outcomes.map(row => row.maxFavorablePct).filter(Number.isFinite)),
    meanMaxAdversePct: mean(result.outcomes.map(row => row.maxAdversePct).filter(Number.isFinite)),
    exactLimitUpStatus: exact.status,
    exactLimitUpEventCount: exact.status === 'AVAILABLE' ? exact.events.length : null,
    exactLimitUpCapturedCount: captured,
    exactLimitUpCaptureRate: exact.status === 'AVAILABLE' && exact.events.length ? captured / exact.events.length : null,
    exactLimitUpPrecision: exact.status === 'AVAILABLE' ? captured / selected.length : null,
    grossReturnSumPct: gross.reduce((sum, value) => sum + value, 0),
    netReturnSumPct: net.reduce((sum, value) => sum + value, 0),
    positiveCount: net.filter(value => value > 0).length,
    hit5Count: net.filter(value => value >= 5).length,
    executionFillability: 'NOT_MEASURABLE_DAILY_OPEN_CLOSE_ONLY'
  };
}

function aggregateMetrics(metrics, minSignalDates, minSampleCoverage) {
  const eligible = metrics.filter(row => row.status === 'MEASURABLE' || row.status === 'PARTIAL');
  const maturedCount = eligible.reduce((sum, row) => sum + (row.maturedCount ?? 0), 0);
  const selectedCount = eligible.reduce((sum, row) => sum + (row.selectedCount ?? 0), 0);
  const sampleCoverage = selectedCount ? maturedCount / selectedCount : 0;
  const exactRows = eligible.filter(row => row.exactLimitUpStatus === 'AVAILABLE');
  const exactEvents = exactRows.reduce((sum, row) => sum + (row.exactLimitUpEventCount ?? 0), 0);
  const exactCaptured = exactRows.reduce((sum, row) => sum + (row.exactLimitUpCapturedCount ?? 0), 0);
  const exactSelected = exactRows.reduce((sum, row) => sum + (row.selectedCount ?? 0), 0);
  const meanNet = maturedCount ? eligible.reduce((sum, row) => sum + (row.netReturnSumPct ?? 0), 0) / maturedCount : null;
  const meanGross = maturedCount ? eligible.reduce((sum, row) => sum + (row.grossReturnSumPct ?? 0), 0) / maturedCount : null;
  const signalDateCount = eligible.length;
  const status = signalDateCount >= minSignalDates && sampleCoverage >= minSampleCoverage
    ? 'MEASURABLE' : signalDateCount ? 'PARTIAL' : 'NOT_MEASURABLE';
  return {
    status, signalDateCount, maturedCandidates: maturedCount, selectedCandidates: selectedCount,
    sampleCoverage, minimumSampleCoverage: minSampleCoverage,
    meanGrossReturnPct: meanGross, meanNetReturnPct: meanNet,
    medianNetReturnPct: mean(eligible.map(row => row.medianNetReturnPct).filter(Number.isFinite)),
    positiveRatio: maturedCount ? eligible.reduce((sum, row) => sum + (row.positiveCount ?? 0), 0) / maturedCount : null,
    hit5PctRatio: maturedCount ? eligible.reduce((sum, row) => sum + (row.hit5Count ?? 0), 0) / maturedCount : null,
    benchmarkMeanNetPct: mean(eligible.map(row => row.benchmarkMeanNetPct).filter(Number.isFinite)),
    excessMeanPct: meanNet === null ? null : meanNet - mean(eligible.map(row => row.benchmarkMeanNetPct).filter(Number.isFinite)),
    meanMaxDrawdownPct: mean(eligible.map(row => row.meanMaxDrawdownPct).filter(Number.isFinite)),
    meanMaxFavorablePct: mean(eligible.map(row => row.meanMaxFavorablePct).filter(Number.isFinite)),
    meanMaxAdversePct: mean(eligible.map(row => row.meanMaxAdversePct).filter(Number.isFinite)),
    exactLimitUpStatus: exactRows.length >= minSignalDates && eligible.length
      && exactRows.length / eligible.length >= minSampleCoverage ? 'MEASURABLE'
      : exactRows.length ? 'PARTIAL' : 'NOT_MEASURABLE',
    exactLimitUpCoverage: eligible.length ? exactRows.length / eligible.length : 0,
    exactLimitUpEventCount: exactRows.length ? exactEvents : null,
    exactLimitUpCapturedCount: exactRows.length ? exactCaptured : null,
    exactLimitUpCaptureRate: exactEvents ? exactCaptured / exactEvents : null,
    exactLimitUpPrecision: exactSelected ? exactCaptured / exactSelected : null
  };
}

function delta(current, baseline, key) {
  const a = num(current?.[key]), b = num(baseline?.[key]);
  return a === null || b === null ? null : Number((a - b).toFixed(4));
}

export function evaluateV17HistoricalReplay({
  snapshots = [], asOf = null, topKs = [10, 30, 50], horizons = [1, 3, 5],
  minSignalDates = 20, minSampleCoverage = 0.95, costBps = 21
} = {}) {
  const history = dedupeSnapshots(snapshots, asOf);
  const ks = [...new Set(topKs.map(Number).filter(value => Number.isInteger(value) && value > 0 && value <= 50))];
  const hs = [...new Set(horizons.map(Number).filter(value => Number.isInteger(value) && value > 0 && value <= 10))];
  const variants = ['v17All', 'v17MainBoard', 'v15Stage1', 'momentum60'];
  const samples = new Map(variants.map(variant => [
    variant, new Map(ks.map(k => [k, new Map(hs.map(h => [h, []]))]))
  ]));
  const daily = [];
  const signalSnapshots = history.map((snapshot, index) => ({snapshot, index})).filter(({snapshot}) => qualified(snapshot));

  for (const {snapshot, index} of signalSnapshots) {
    const signalTime = signalAsOf(snapshot);
    let selection = null;
    if (signalTime) {
      try {
        selection = buildV17OneClickSelection({
          context: contextFromSnapshot(snapshot), snapshots: history.slice(0, index), asOf: signalTime
        });
      } catch {
        selection = null;
      }
    }
    const v17Candidates = (selection?.candidates ?? [])
      .filter(row => !['INVALIDATED', 'AVOID_CHASE'].includes(row.state));
    const v17MainBoard = v17Candidates.filter(row => mainBoardCode(row.code));
    const v15Candidates = rankV15Stage1Candidates(snapshot.stockRows, snapshot.market?.indices ?? []).candidates;
    const momentum = momentumCandidates(snapshot);
    const ranked = {v17All: v17Candidates, v17MainBoard, v15Stage1: v15Candidates, momentum60: momentum};
    const dailyVariants = {};
    for (const variant of variants) {
      dailyVariants[variant] = {};
      for (const k of ks) {
        const selected = ranked[variant].slice(0, k);
        const horizonsOut = {};
        for (const horizon of hs) {
          const future = history.slice(index + 1, index + horizon + 1);
          const futureStatus = future.length !== horizon ? 'IMMATURE'
            : future.every(qualified) ? 'AVAILABLE' : 'DATA_GAP';
          const metric = futureStatus === 'AVAILABLE'
            ? metricForSelection(selected, future, horizon, costBps)
            : {status: futureStatus, horizon, selectedCount: selected.length, maturedCount: 0, coverage: 0};
          horizonsOut['T+' + horizon] = metric;
          if (metric.status === 'MEASURABLE' || metric.status === 'PARTIAL')
            samples.get(variant).get(k).get(horizon).push(metric);
        }
        dailyVariants[variant]['top' + k] = {
          selectedCount: selected.length,
          top: selected.slice(0, 10).map(row => ({
            code: row.code, name: row.name, score: num(row.score ?? row.stage1Score), state: row.state ?? 'BASELINE'
          })),
          horizons: horizonsOut
        };
      }
    }
    daily.push({
      tradeDate: dateOf(snapshot), capturedAt: snapshot.capturedAt,
      v17Decision: selection?.decision ?? 'NOT_MEASURABLE',
      v17CandidateCount: selection?.candidates?.length ?? 0,
      v17TriggerCount: selection?.selectionPools?.triggered?.length ?? 0,
      v17NoChaseCount: selection?.selectionPools?.noChase?.length ?? 0,
      marketRegime: selection?.market?.regime ?? 'NOT_MEASURABLE',
      qualifiedForReplay: qualified(snapshot), topK: dailyVariants
    });
  }

  const aggregate = {};
  for (const variant of variants) {
    aggregate[variant] = {};
    for (const k of ks) {
      aggregate[variant]['top' + k] = {};
      for (const horizon of hs) {
        aggregate[variant]['top' + k]['T+' + horizon] = aggregateMetrics(
          samples.get(variant).get(k).get(horizon), minSignalDates, minSampleCoverage
        );
      }
    }
  }
  const comparison = {};
  for (const variant of ['v17MainBoard', 'v17All', 'momentum60']) {
    comparison[variant] = {};
    for (const k of ks) {
      comparison[variant]['top' + k] = {};
      for (const horizon of hs) {
        const current = aggregate[variant]['top' + k]['T+' + horizon];
        const baseline = aggregate[variant === 'v17All' ? 'momentum60' : 'v15Stage1']['top' + k]['T+' + horizon];
        comparison[variant]['top' + k]['T+' + horizon] = {
          meanNetReturnDeltaPct: delta(current, baseline, 'meanNetReturnPct'),
          positiveRatioDelta: delta(current, baseline, 'positiveRatio'),
          excessReturnDeltaPct: delta(current, baseline, 'excessMeanPct'),
          drawdownDeltaPct: delta(current, baseline, 'meanMaxDrawdownPct')
        };
      }
    }
  }
  const metrics = variants.flatMap(variant => ks.flatMap(k => hs.map(h => aggregate[variant]['top' + k]['T+' + h])));
  const measurableCount = metrics.filter(row => row.status === 'MEASURABLE').length;
  const partialCount = metrics.filter(row => row.status === 'PARTIAL').length;
  const minimumMaturedSignalDates = metrics.length ? Math.min(...metrics.map(row => row.signalDateCount ?? 0)) : 0;
  const overallStatus = measurableCount === metrics.length && metrics.length > 0 ? 'MEASURABLE'
    : measurableCount || partialCount ? 'PARTIAL' : 'NOT_MEASURABLE';

  return {
    schema: 'ashare-v17-historical-replay-v1', modelVersion: 'V17.1.0-one-click-shadow',
    asOf: String(asOf ?? history.at(-1)?.tradeDate ?? '').slice(0, 10) || null,
    inputSnapshotCount: Array.isArray(snapshots) ? snapshots.length : 0,
    uniqueTradeDates: history.length, qualifiedSignalDates: signalSnapshots.length,
    minimumSignalDatesForMetric: minSignalDates, minimumSampleCoverageForMetric: minSampleCoverage,
    costAssumption: {
      commissionBpsPerSide: 3, stampDutyBpsSell: 5, slippageBpsPerSide: 5,
      totalRoundTripBps: costBps, appliedToReportedNetReturns: true
    },
    horizonConvention: 'NEXT_QUALIFIED_ARCHIVE_SESSIONS',
    officialTradingCalendarStatus: 'NOT_MEASURABLE_NOT_ARCHIVED',
    executionConvention: {
      signal: 'All signal features are frozen using the signal-date post-close snapshot only.',
      entry: 'Earliest modeled entry is the next qualified archived session open; no same-close fill is assumed.',
      exit: 'T+1/T+3/T+5 are counted as next qualified archived snapshots, not independently verified exchange-calendar sessions.',
      costs: 'Reported net return subtracts the configured round-trip commission, stamp-duty and slippage proxy.',
      benchmark: 'Equal-weighted supported-universe cohort with complete entry-open and exit-close observations.',
      fillability: 'Daily bars cannot establish auction queue, limit-lock fills, intraday execution or T+1 sellability.'
    },
    variants: {
      v17All: 'V17.1 candidates across the archived Shanghai/Shenzhen supported deep-scan funnel, excluding explicit no-chase and invalidated states.',
      v17MainBoard: 'V17.1 candidates restricted to the overlapping 00/60 main-board universe for comparison with V15 Stage1.',
      v15Stage1: 'Reconstructed V15 Stage1 ranking on the archived main-board cross-section.',
      momentum60: 'Simple supported-universe 60-day momentum ranking with the same liquidity and daily-move prefilters.'
    },
    status: overallStatus, promotionEligible: false, minimumMaturedSignalDates,
    archiveCoverage: {
      partialSnapshots: history.filter(snapshot => !qualified(snapshot)).length,
      qualifiedSnapshots: signalSnapshots.length,
      v17CandidateDates: daily.filter(row => row.v17CandidateCount > 0).length,
      datesWithAnyTriggeredCandidate: daily.filter(row => row.v17TriggerCount > 0).length
    },
    aggregate, comparison, daily,
    limitations: [
      'This replay evaluates a research ranking, not a live trading strategy or a calibrated probability model.',
      'V17 deep-scan candidates are the union of V15 Stage1 Top50 and the separate V17 early-flow prefilter Top30; this is not a full-market 65-day K-line scan.',
      'The archive is an approximate multi-page point-in-time collection, not an atomic exchange snapshot.',
      'Official exchange trading-calendar dates are not archived; T+N refers to the next qualified archived snapshots and must not be treated as calendar-verified T+N.',
      'Vendor main-flow estimates do not establish actual institutional holdings or account-level money movement.',
      'No minute bars, auction, VWAP, Level-2 order-book events, queue position, limit-lock fill or T+1 sellability simulation is available.',
      'A 21-basis-point round-trip cost is a transparent proxy, not a broker-specific execution-cost estimate.',
      'At least 20 matured signal dates and 95% selected-candidate outcome coverage are required for each Top-K/horizon metric to be labelled MEASURABLE.',
      'Synthetic tests validate deterministic replay mechanics only; they do not establish real-market predictive performance.'
    ]
  };
}

export const _internal = {qualified, dedupeSnapshots, contextFromSnapshot, dailyOutcome, metricForSelection, aggregateMetrics};
