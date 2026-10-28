const finite = v => typeof v === 'number' && Number.isFinite(v);

function normalizeBars(bars) {
  return (Array.isArray(bars) ? bars : []).map(x => ({
    date: String(x?.date || ''),
    close: Number(x?.close),
    high: Number(x?.high),
    low: Number(x?.low)
  })).filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x.date) && finite(x.close) && x.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function evaluateForwardSample(sample, bars, { asOfDate = null, excludeCurrentDay = false } = {}) {
  const entry = Number(sample?.price);
  const signalDate = String(sample?.date || '');
  if (!(entry > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(signalDate)) return sample;
  let clean = normalizeBars(bars);
  if (excludeCurrentDay && asOfDate) clean = clean.filter(x => x.date < asOfDate);
  const future = clean.filter(x => x.date > signalDate);
  const forward = { ...(sample.forward || {}) };
  let changed = false;
  for (const horizon of [1, 3, 5]) {
    const key = 'r' + horizon;
    if (!Object.hasOwn(forward, key) && future.length >= horizon) {
      const close = future[horizon - 1].close;
      forward[key] = close / entry - 1;
      forward['date' + horizon] = future[horizon - 1].date;
      changed = true;
    }
  }
  if (future.length >= 5) {
    const five = future.slice(0, 5);
    const lows = five.map(x => x.low).filter(finite);
    const highs = five.map(x => x.high).filter(finite);
    if (!Object.hasOwn(forward, 'mae5') && lows.length) {
      forward.mae5 = Math.min(...lows) / entry - 1;
      changed = true;
    }
    if (!Object.hasOwn(forward, 'mfe5') && highs.length) {
      forward.mfe5 = Math.max(...highs) / entry - 1;
      changed = true;
    }
  }
  return changed ? { ...sample, forward } : sample;
}

function statsFor(samples, horizon) {
  const key = 'r' + horizon;
  const rows = samples.filter(x => finite(x?.forward?.[key]));
  const returns = rows.map(x => x.forward[key]).sort((a, b) => a - b);
  const wins = returns.filter(x => x > 0);
  const losses = returns.filter(x => x < 0);
  const avg = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : null;
  const mid = Math.floor(returns.length / 2);
  const med = !returns.length ? null : returns.length % 2 ? returns[mid] : (returns[mid - 1] + returns[mid]) / 2;
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  return {
    horizon, n: returns.length, winRate: returns.length ? wins.length / returns.length : null,
    averageReturn: avg, medianReturn: med, best: returns.length ? returns.at(-1) : null,
    worst: returns.length ? returns[0] : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? null : null
  };
}

export function summarizeByRegime(samples = []) {
  const groups = new Map();
  for (const sample of Array.isArray(samples) ? samples : []) {
    const state = String(sample?.regimeState || sample?.market || 'UNKNOWN');
    if (!groups.has(state)) groups.set(state, []);
    groups.get(state).push(sample);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([state, rows]) => ({
    state, signalCount: rows.length,
    horizons: [1, 3, 5].map(h => statsFor(rows, h)),
    mae5Count: rows.filter(x => finite(x?.forward?.mae5)).length,
    averageMae5: (() => {
      const a = rows.map(x => x?.forward?.mae5).filter(finite);
      return a.length ? a.reduce((sum, v) => sum + v, 0) / a.length : null;
    })()
  }));
}
