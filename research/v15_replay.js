const SNAPSHOT_SCHEMA = 'ashare-v15-full-universe-snapshot-v1';
const DEFAULT_HORIZONS = [1, 3, 5];
const DEFAULT_TOP_KS = [5, 10, 20, 30, 35, 40];

const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const num = value => finite(value) ? Number(value) : null;
const dateOnly = value => {
  const text = String(value ?? '');
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
};
const average = values => {
  const xs = values.filter(Number.isFinite);
  return xs.length ? xs.reduce((sum, value) => sum + value, 0) / xs.length : null;
};
const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

function rowsFromUniverse(snapshot) {
  const universe = snapshot?.universe;
  if (Array.isArray(universe)) return universe;
  if (Array.isArray(universe?.records)) return universe.records;
  if (Array.isArray(universe?.rows) && Array.isArray(universe?.fields)) {
    return universe.rows.map(values => Object.fromEntries(
      universe.fields.map((field, index) => [field, values[index] ?? null])
    ));
  }
  return [];
}

function candidateFrom(value) {
  if (typeof value === 'string') return {code: value};
  if (Array.isArray(value)) return {code: String(value[0] ?? ''), score: num(value[1]), lanes: Array.isArray(value[2]) ? value[2] : []};
  if (!value || typeof value !== 'object') return null;
  return {
    ...value,
    code: String(value.code ?? ''),
    score: num(value.score ?? value.observationScore ?? value.stage1),
    lanes: Array.isArray(value.lanes) ? value.lanes : Array.isArray(value.observationLanes) ? value.observationLanes : []
  };
}

function uniqueCandidates(values = []) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(values) ? values : []) {
    const candidate = candidateFrom(raw);
    if (!candidate?.code || seen.has(candidate.code)) continue;
    seen.add(candidate.code);
    out.push(candidate);
  }
  return out;
}

function strategyLists(snapshot) {
  const strategies = snapshot?.strategies ?? {};
  const primary = uniqueCandidates(strategies.primaryTop);
  const legacyShadow = uniqueCandidates(strategies.legacyShadowTop).filter(x => !new Set(primary.map(y => y.code)).has(x.code));
  const v15Observation = uniqueCandidates(strategies.v15ObservationTop).filter(x => !new Set(primary.map(y => y.code)).has(x.code));
  const lists = {
    primaryTop: primary,
    primaryFinalTop: uniqueCandidates(strategies.primaryFinalTop),
    legacyUnion: uniqueCandidates([...primary, ...legacyShadow]),
    v15Union: uniqueCandidates([...primary, ...v15Observation]),
    legacyShadowOnly: legacyShadow,
    v15ObservationOnly: v15Observation
  };
  const lanes = strategies.observationLanes ?? {};
  for (const [lane, values] of Object.entries(lanes)) {
    lists['v15Lane:' + lane] = uniqueCandidates(values);
  }
  return lists;
}

function isEligibleUniverseRow(row) {
  const code = String(row?.code ?? '');
  const name = String(row?.name ?? '');
  if (!/^(00|60)\d{4}$/.test(code)) return false;
  if (/(?:ST|退)/i.test(name) || row?.specialTreatment === true) return false;
  return finite(row?.price) && Number(row.price) > 0;
}

function limitUpEvidence(bar, code) {
  if (typeof bar?.isLimitUp === 'boolean') return {known: true, hit: bar.isLimitUp};
  if (bar?.limitUpVerified === true && finite(bar?.limitUpPrice) && finite(bar?.high)) {
    return {known: true, hit: Number(bar.high) >= Number(bar.limitUpPrice) - 0.005};
  }
  if (bar?.limitUpVerified === true && finite(bar?.pct)) {
    const value = String(code);
    const limit = /^(300|301|688|689)/.test(value) ? 20 : /^(4|8|92)/.test(value) ? 30 : 10;
    return {known: true, hit: Number(bar.pct) >= limit - 0.15};
  }
  return {known: false, hit: false};
}

function barsForSessions(snapshot, code, dailyBarsByCode, intradayBarsByCode) {
  const tradeDate = dateOnly(snapshot?.tradeDate ?? snapshot?.capturedAt);
  const capturedMs = Date.parse(snapshot?.capturedAt ?? '');
  const groups = new Map();
  const add = (bar, date) => {
    if (!date) return;
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(bar);
  };
  const intraday = Array.isArray(intradayBarsByCode?.[code]) ? intradayBarsByCode[code] : [];
  if (Number.isFinite(capturedMs)) {
    for (const bar of intraday) {
      const timestamp = Date.parse(bar?.timestamp ?? bar?.time ?? '');
      const date = dateOnly(bar?.date ?? bar?.timestamp ?? bar?.time);
      if (date === tradeDate && Number.isFinite(timestamp) && timestamp > capturedMs) add(bar, date);
    }
  }
  const daily = Array.isArray(dailyBarsByCode?.[code]) ? dailyBarsByCode[code] : [];
  for (const bar of daily) {
    const date = dateOnly(bar?.date ?? bar?.tradeDate);
    // Daily high/low/close for the snapshot date contains pre-snapshot prices.
    // Excluding that entire daily candle prevents intraday look-ahead leakage.
    if (date && date > tradeDate) add(bar, date);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, bars]) => ({
      date,
      bars: bars.sort((a, b) => {
        const ta = Date.parse(a?.timestamp ?? a?.time ?? '');
        const tb = Date.parse(b?.timestamp ?? b?.time ?? '');
        return (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0);
      })
    }));
}

function outcomeFor(snapshot, row, dailyBarsByCode, intradayBarsByCode, horizon) {
  const code = String(row?.code ?? '');
  const entry = num(row?.price);
  if (!code || !(entry > 0)) return {evaluable: false, labelKnown: false};
  const sessions = barsForSessions(snapshot, code, dailyBarsByCode, intradayBarsByCode);
  if (sessions.length < horizon) return {evaluable: false, labelKnown: false};
  const selected = sessions.slice(0, horizon);
  const allBars = selected.flatMap(session => session.bars);
  if (!allBars.length) return {evaluable: false, labelKnown: false};
  const lastSessionBars = selected.at(-1).bars;
  const lastBar = lastSessionBars.at(-1);
  const close = num(lastBar?.close);
  if (!(close > 0)) return {evaluable: false, labelKnown: false};
  const highs = allBars.map(bar => num(bar?.high)).filter(value => value !== null && value > 0);
  const lows = allBars.map(bar => num(bar?.low)).filter(value => value !== null && value > 0);
  const evidence = allBars.map(bar => limitUpEvidence(bar, code));
  const hit = evidence.some(item => item.known && item.hit);
  const labelKnown = hit || evidence.every(item => item.known);
  return {
    evaluable: true,
    labelKnown,
    limitUpHit: labelKnown ? hit : null,
    horizon,
    endDate: selected.at(-1).date,
    returnPct: (close / entry - 1) * 100,
    maxFavorablePct: highs.length ? (Math.max(...highs) / entry - 1) * 100 : null,
    maxAdversePct: lows.length ? (Math.min(...lows) / entry - 1) * 100 : null
  };
}

function evaluateList({snapshot, list, universeByCode, poolOutcomes, dailyBarsByCode, intradayBarsByCode, horizon, k, strategy}) {
  const selected = list.slice(0, k);
  const observations = selected.map(candidate => {
    const row = universeByCode.get(candidate.code);
    if (!row) return {candidate, outcome: {evaluable: false, labelKnown: false}};
    return {candidate, outcome: outcomeFor(snapshot, row, dailyBarsByCode, intradayBarsByCode, horizon)};
  });
  const evaluable = observations.filter(item => item.outcome.evaluable);
  const labelled = evaluable.filter(item => item.outcome.labelKnown);
  const hits = labelled.filter(item => item.outcome.limitUpHit === true);
  const poolLabelled = [...poolOutcomes.values()].filter(item => item.labelKnown);
  const poolHits = poolLabelled.filter(item => item.limitUpHit === true);
  return {
    tradeDate: dateOnly(snapshot.tradeDate ?? snapshot.capturedAt),
    strategy,
    horizonSessions: horizon,
    requestedK: k,
    selectedCount: selected.length,
    evaluableCount: evaluable.length,
    labelledCount: labelled.length,
    selectedLabelCoverage: selected.length ? labelled.length / selected.length : null,
    precisionAtK: labelled.length ? hits.length / labelled.length : null,
    hitCount: hits.length,
    observedUniverseCount: universeByCode.size,
    observedUniverseLabelledCount: poolLabelled.length,
    observedUniverseLabelCoverage: universeByCode.size ? poolLabelled.length / universeByCode.size : null,
    observedUniverseLimitUpCount: poolHits.length,
    observedPoolRecallAtK: poolHits.length ? hits.length / poolHits.length : null,
    avgReturnPct: average(evaluable.map(item => item.outcome.returnPct)),
    avgMaxFavorablePct: average(evaluable.map(item => item.outcome.maxFavorablePct).filter(Number.isFinite)),
    avgMaxAdversePct: average(evaluable.map(item => item.outcome.maxAdversePct).filter(Number.isFinite)),
    endDates: [...new Set(evaluable.map(item => item.outcome.endDate))].sort()
  };
}

function aggregateReports(reports) {
  const groups = new Map();
  for (const report of reports) {
    const key = [report.strategy, report.horizonSessions, report.requestedK].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(report);
  }
  return [...groups.values()].map(rows => {
    const first = rows[0];
    const selectedCount = rows.reduce((sum, row) => sum + row.selectedCount, 0);
    const evaluableCount = rows.reduce((sum, row) => sum + row.evaluableCount, 0);
    const labelledCount = rows.reduce((sum, row) => sum + row.labelledCount, 0);
    const hitCount = rows.reduce((sum, row) => sum + row.hitCount, 0);
    const poolHits = rows.reduce((sum, row) => sum + row.observedUniverseLimitUpCount, 0);
    const weighted = keyName => {
      const values = rows.filter(row => Number.isFinite(row[keyName]) && row.evaluableCount > 0);
      const weight = values.reduce((sum, row) => sum + row.evaluableCount, 0);
      return weight ? values.reduce((sum, row) => sum + row[keyName] * row.evaluableCount, 0) / weight : null;
    };
    return {
      strategy: first.strategy,
      horizonSessions: first.horizonSessions,
      requestedK: first.requestedK,
      snapshotCount: rows.length,
      selectedCount,
      evaluableCount,
      labelledCount,
      selectedLabelCoverage: selectedCount ? labelledCount / selectedCount : null,
      precisionAtK: labelledCount ? hitCount / labelledCount : null,
      hitCount,
      observedUniverseLimitUpCount: poolHits,
      observedPoolRecallAtK: poolHits ? hitCount / poolHits : null,
      avgReturnPct: weighted('avgReturnPct'),
      avgMaxFavorablePct: weighted('avgMaxFavorablePct'),
      avgMaxAdversePct: weighted('avgMaxAdversePct')
    };
  }).sort((a, b) => a.horizonSessions - b.horizonSessions || a.requestedK - b.requestedK || a.strategy.localeCompare(b.strategy));
}

/**
 * Point-in-time replay for V15 research snapshots.
 * Daily candles from the snapshot's own trade date are always excluded. Same-day
 * labels are only admitted from explicitly timestamped intraday bars after capture.
 * Limit-up metrics require verified labels; unknown labels are never treated as misses.
 */
export function replayV15Snapshots({
  snapshots = [],
  dailyBarsByCode = {},
  intradayBarsByCode = {},
  horizons = DEFAULT_HORIZONS,
  topKs = DEFAULT_TOP_KS,
  includeUnqualified = false
} = {}) {
  const input = Array.isArray(snapshots) ? snapshots : Array.isArray(snapshots?.snapshots) ? snapshots.snapshots : [snapshots];
  const accepted = [];
  const excluded = [];
  const reports = [];
  for (const snapshot of input) {
    if (!snapshot || typeof snapshot !== 'object') {
      excluded.push({reason: 'invalid-snapshot'});
      continue;
    }
    if (!includeUnqualified && snapshot.quality?.qualifiedForReplay === false) {
      excluded.push({tradeDate: dateOnly(snapshot.tradeDate ?? snapshot.capturedAt), reason: 'snapshot-not-qualified-for-replay', qualityReasons: snapshot.quality?.reasons ?? []});
      continue;
    }
    const tradeDate = dateOnly(snapshot.tradeDate ?? snapshot.capturedAt);
    if (!tradeDate || !Number.isFinite(Date.parse(snapshot.capturedAt ?? ''))) {
      excluded.push({tradeDate, reason: 'missing-trade-date-or-capture-timestamp'});
      continue;
    }
    const rows = rowsFromUniverse(snapshot).filter(isEligibleUniverseRow);
    if (!rows.length) {
      excluded.push({tradeDate, reason: 'empty-or-non-main-board-universe'});
      continue;
    }
    const universeByCode = new Map(rows.map(row => [String(row.code), row]));
    const lists = strategyLists(snapshot);
    const missing = ['primaryTop', 'legacyShadowTop', 'v15ObservationTop'].filter(key => !Array.isArray(snapshot.strategies?.[key]));
    if (missing.length) {
      excluded.push({tradeDate, reason: 'missing-strategy-lists', missing});
      continue;
    }
    accepted.push({tradeDate, universeCount: universeByCode.size});
    for (const horizon of horizons) {
      const poolOutcomes = new Map();
      for (const [code, row] of universeByCode) {
        poolOutcomes.set(code, outcomeFor(snapshot, row, dailyBarsByCode, intradayBarsByCode, horizon));
      }
      for (const [strategy, list] of Object.entries(lists)) {
        const maxK = strategy.endsWith('Only') || strategy.startsWith('v15Lane:') ? Math.max(...topKs) : Math.max(...topKs);
        for (const k of topKs) {
          if (list.length === 0 || k > maxK) continue;
          reports.push(evaluateList({snapshot, list, universeByCode, poolOutcomes, dailyBarsByCode, intradayBarsByCode, horizon, k, strategy}));
        }
      }
    }
  }
  return {
    schema: 'ashare-v15-replay-report-v1',
    generatedAt: new Date().toISOString(),
    method: 'point-in-time-snapshot-forward-outcome-replay',
    snapshotCount: accepted.length,
    acceptedSnapshots: accepted,
    excludedSnapshots: excluded,
    limitations: {
      scope: 'Only the supplied snapshot universe is used for recall denominators; full-market recall requires a complete and qualified universe snapshot for every date.',
      limitUpLabels: 'Only explicit isLimitUp booleans or provider-verified limitUpVerified labels count. Unknown labels are excluded from precision/recall denominators.',
      sameDay: 'Same-day daily OHLC candles are excluded to prevent look-ahead. Same-day outcomes require intraday bars timestamped after capturedAt.',
      probabilityCalibration: 'Scores are ranking scores, not calibrated probabilities.',
      costs: 'Returns exclude fees, slippage, limit-order fill constraints and market impact.'
    },
    reportCount: reports.length,
    perSnapshot: reports,
    aggregate: aggregateReports(reports)
  };
}

export const _internal = {rowsFromUniverse, strategyLists, isEligibleUniverseRow, limitUpEvidence, barsForSessions, outcomeFor, aggregateReports};
