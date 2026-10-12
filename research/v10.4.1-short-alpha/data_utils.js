export function finiteNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
    ? value : null;
}

export function round(value) {
  return Math.round(value * 1e6) / 1e6;
}

export function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}

export function normalizeSessions(input) {
  if (!Array.isArray(input) || !input.length) {
    throw new TypeError('sessions must be a non-empty explicit trading calendar');
  }
  const dates = input.map(item => validDate(typeof item === 'string' ? item : item?.date));
  if (dates.some(date => date === null) || new Set(dates).size !== dates.length) {
    throw new TypeError('sessions must contain unique valid YYYY-MM-DD dates');
  }
  return [...dates].sort();
}

export function priceRows(raw) {
  if (Array.isArray(raw)) return raw;
  const rows = raw?.data?.klines ?? raw?.klines ?? raw?.rows;
  return Array.isArray(rows) ? rows : [];
}

// Eastmoney daily kline order: date, open, close, high, low, volume, amount.
export function priceIndex(raw) {
  const index = new Map();
  const duplicateDates = new Set();
  for (const row of priceRows(raw)) {
    const fields = typeof row === 'string' ? row.split(',') : row;
    const date = validDate(Array.isArray(fields) ? fields[0] : fields?.date);
    if (!date) continue;
    if (index.has(date)) {
      duplicateDates.add(date);
      continue;
    }
    const close = finiteNumber(Array.isArray(fields) ? fields[2] : fields?.close ?? fields?.price);
    index.set(date, close !== null && close > 0 ? close : null);
  }
  // Ambiguous duplicate quotes are not silently selected.
  for (const date of duplicateDates) index.set(date, null);
  return { index, duplicateDates: [...duplicateDates] };
}
