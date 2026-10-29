import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const BASE = 'https://push2his.eastmoney.com';
const DEFAULT_LIMIT = 300;
const CONCURRENCY = 8;
const TIMEOUT_MS = 6500;

const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const num = value => finite(value) ? Number(value) : null;

function dateOnly(value) {
  const match = String(value ?? '').match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
}

function parseMaybeJsonp(text) {
  const value = String(text ?? '').trim();
  try { return JSON.parse(value); } catch {}
  const left = value.indexOf('('), right = value.lastIndexOf(')');
  if (left >= 0 && right > left) return JSON.parse(value.slice(left + 1, right));
  throw new Error('invalid-eastmoney-kline-json');
}

function rowsFromSnapshot(snapshot) {
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

export function collectCandidateCodes(snapshots) {
  const codes = new Set();
  for (const snapshot of Array.isArray(snapshots) ? snapshots : [snapshots]) {
    const strategies = snapshot?.strategies ?? {};
    for (const key of ['primaryTop', 'primaryFinalTop', 'legacyShadowTop', 'v15ObservationTop']) {
      for (const item of Array.isArray(strategies[key]) ? strategies[key] : []) {
        const code = String(typeof item === 'string' ? item : Array.isArray(item) ? item[0] : item?.code ?? '');
        if (/^(00|60)\d{4}$/.test(code)) codes.add(code);
      }
    }
    for (const values of Object.values(strategies.observationLanes ?? {})) {
      for (const item of Array.isArray(values) ? values : []) {
        const code = String(typeof item === 'string' ? item : Array.isArray(item) ? item[0] : item?.code ?? '');
        if (/^(00|60)\d{4}$/.test(code)) codes.add(code);
      }
    }
  }
  return [...codes].sort();
}

export function deriveLimitUpPrice(prevClose, code, name = '') {
  if (!finite(prevClose) || Number(prevClose) <= 0) return null;
  if (!/^(00|60)\d{4}$/.test(String(code))) return null;
  if (/(?:ST|退)/i.test(String(name))) return null;
  return Math.round(Number(prevClose) * 1.1 * 100 + 1e-8) / 100;
}

export function parseDailyBars(code, rawRows, name = '') {
  const parsed = (Array.isArray(rawRows) ? rawRows : []).map(value => {
    const fields = Array.isArray(value) ? value : String(value ?? '').split(',');
    return {
      date: dateOnly(fields[0]),
      open: num(fields[1]),
      close: num(fields[2]),
      high: num(fields[3]),
      low: num(fields[4]),
      volume: num(fields[5]),
      amount: num(fields[6]),
      pct: num(fields[8]),
      change: num(fields[9]),
      turnover: num(fields[10])
    };
  }).filter(bar => bar.date && bar.close > 0 && bar.high > 0 && bar.low > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const enoughHistory = parsed.length >= 60;
  return parsed.map((bar, index) => {
    const prevClose = index > 0 ? parsed[index - 1].close : null;
    const limitUpPrice = enoughHistory && index >= 5 ? deriveLimitUpPrice(prevClose, code, name) : null;
    const limitUpVerified = limitUpPrice !== null && finite(bar.high);
    return {
      ...bar,
      prevClose,
      limitUpPrice,
      limitUpVerified,
      isLimitUp: limitUpVerified ? Number(bar.high) >= limitUpPrice - 0.001 : undefined,
      labelMethod: limitUpVerified ? 'raw-daily-high-vs-normal-main-board-10pct-limit' : null
    };
  });
}

function shanghaiDate(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
}

function isContinuousSession(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {timeZone:'Asia/Shanghai',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now));
  const get = key => parts.find(part => part.type === key)?.value;
  const minute = Number(get('hour')) * 60 + Number(get('minute'));
  return ['Mon','Tue','Wed','Thu','Fri'].includes(get('weekday')) && ((minute >= 570 && minute < 690) || (minute >= 780 && minute < 900));
}

function klineUrl(code) {
  const secid = /^(60)\d{4}$/.test(code) ? '1.' + code : '0.' + code;
  const params = new URLSearchParams({
    secid, klt: '101', fqt: '0', beg: '0', end: '20500101', lmt: '120',
    fields1: 'f1,f2,f3,f4,f5,f6',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61'
  });
  return BASE + '/api/qt/stock/kline/get?' + params.toString();
}

async function fetchOne(code, name, fetchImpl = fetch, timeoutMs = TIMEOUT_MS) {
  let lastError = 'unknown-error';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(klineUrl(code), {
        signal: controller.signal,
        cache: 'no-store',
        headers: {accept:'application/json,text/javascript,*/*;q=0.8', referer:'https://quote.eastmoney.com/'}
      });
      if (!response.ok) throw new Error('upstream-http-' + response.status);
      const payload = parseMaybeJsonp(await response.text());
      const rows = payload?.data?.klines;
      if (!Array.isArray(rows) || rows.length < 6) throw new Error('insufficient-daily-bars');
      return {code, name, bars: parseDailyBars(code, rows, name), source: 'eastmoney-unadjusted-daily'};
    } catch (error) {
      lastError = controller.signal.aborted ? 'timeout' : String(error?.message ?? error);
      if (attempt === 2) break;
      await new Promise(resolve => setTimeout(resolve, 350));
    } finally {
      clearTimeout(timer);
    }
  }
  return {code, name, error: lastError};
}

export async function fetchV15Bars({snapshots, fetchImpl = fetch, concurrency = CONCURRENCY, maxCodes = DEFAULT_LIMIT, now = Date.now} = {}) {
  const list = Array.isArray(snapshots) ? snapshots : [snapshots];
  const codeSet = collectCandidateCodes(list);
  const names = new Map();
  for (const snapshot of list) {
    for (const row of rowsFromSnapshot(snapshot)) {
      const code = String(row?.code ?? '');
      if (code && row?.name && !names.has(code)) names.set(code, String(row.name));
    }
  }
  const codes = codeSet.slice(0, Math.max(1, Math.min(1000, Math.floor(Number(maxCodes) || DEFAULT_LIMIT))));
  const results = new Array(codes.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.max(1, Math.min(16, Math.floor(Number(concurrency) || CONCURRENCY)))}, async () => {
    while (next < codes.length) {
      const index = next++;
      results[index] = await fetchOne(codes[index], names.get(codes[index]) ?? '', fetchImpl);
    }
  }));
  const currentDate = shanghaiDate(now());
  const inSession = isContinuousSession(now());
  const dailyBarsByCode = {};
  const failures = [];
  let barCount = 0;
  for (const result of results) {
    if (result.error) {
      failures.push({code: result.code, error: result.error});
      continue;
    }
    // Do not use a partially formed current-day candle while the exchange is open.
    const bars = result.bars.filter(bar => !(inSession && bar.date === currentDate));
    dailyBarsByCode[result.code] = bars;
    barCount += bars.length;
  }
  return {
    schema: 'ashare-v15-daily-bars-v1',
    generatedAt: new Date(now()).toISOString(),
    source: 'Eastmoney unadjusted daily K-line; limit-up labels derived from daily high and normal 10% main-board price limit',
    labelCaveat: 'ST status changes, IPO no-limit sessions, corporate actions, and exceptional price-limit rules require date-specific verification. Labels with insufficient history or ST names are left unknown.',
    currentPartialCandleExcluded: inSession,
    requestedCodeCount: codes.length,
    discoveredCodeCount: codeSet.length,
    truncatedByMaxCodes: codeSet.length > codes.length,
    returnedCodeCount: Object.keys(dailyBarsByCode).length,
    barCount,
    failures,
    dailyBarsByCode,
    intradayBarsByCode: {}
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function runBarsCli(args = process.argv.slice(2)) {
  const snapshotPaths = args.filter(arg => !arg.startsWith('--'));
  const outArg = args.find(arg => arg.startsWith('--out='));
  const maxArg = args.find(arg => arg.startsWith('--max-codes='));
  if (!snapshotPaths.length) throw new Error('Usage: node research/fetch_v15_bars.js snapshot1.json [snapshot2.json ...] [--out=daily_bars.json] [--max-codes=300]');
  const snapshots = [];
  for (const path of snapshotPaths) {
    const document = await readJson(path);
    if (Array.isArray(document)) snapshots.push(...document);
    else if (Array.isArray(document?.snapshots)) snapshots.push(...document.snapshots);
    else snapshots.push(document);
  }
  const maxCodes = maxArg ? Number(maxArg.slice('--max-codes='.length)) : DEFAULT_LIMIT;
  const result = await fetchV15Bars({snapshots, maxCodes});
  const outPath = outArg ? outArg.slice('--out='.length) : 'v15_daily_bars.json';
  await writeFile(resolve(outPath), JSON.stringify(result, null, 2) + '\n', 'utf8');
  process.stdout.write(JSON.stringify({
    outPath: resolve(outPath),
    requestedCodeCount: result.requestedCodeCount,
    discoveredCodeCount: result.discoveredCodeCount,
    returnedCodeCount: result.returnedCodeCount,
    barCount: result.barCount,
    failureCount: result.failures.length,
    truncatedByMaxCodes: result.truncatedByMaxCodes,
    labelCaveat: result.labelCaveat
  }, null, 2) + '\n');
  return result;
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedAsScript) {
  runBarsCli().catch(error => {
    process.stderr.write(String(error?.message ?? error) + '\n');
    process.exitCode = 2;
  });
}
