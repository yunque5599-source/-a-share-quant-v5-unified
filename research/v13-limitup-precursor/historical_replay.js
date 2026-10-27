import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { boardForCode, rankCandidates } from './precursor_score.js';

const MARKET_HOSTS = [
  'https://push2.eastmoney.com',
  'https://push2delay.eastmoney.com',
  'https://7.push2.eastmoney.com',
  'https://43.push2.eastmoney.com'
];
const HISTORY_HOSTS = [
  'https://push2his.eastmoney.com',
  'https://7.push2his.eastmoney.com',
  'https://43.push2his.eastmoney.com'
];
const MARKET_SEGMENTS = [
  { key: 'SZ_MAIN', fs: 'm:0+t:6' },
  { key: 'CHINEXT', fs: 'm:0+t:80' },
  { key: 'SH_MAIN', fs: 'm:1+t:2' },
  { key: 'STAR', fs: 'm:1+t:23' },
  { key: 'BSE', fs: 'm:0+t:81' }
];
const MARKET_FIELDS = 'f12,f14,f2,f3,f6,f8,f10,f20,f24,f62,f184,f100';
const USER_AGENT = 'Mozilla/5.0 AShareQuant/V13-historical-replay';
const TARGETS_PATH = resolve('research/v13-limitup-precursor/target_symbols.json');

function parseArgs(argv) {
  const out = { asOf: process.env.AS_OF || '2026-10-20', outDir: 'output/v13-history-replay', concurrency: 6 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--as-of' && argv[i + 1]) out.asOf = argv[++i];
    else if (argv[i] === '--out-dir' && argv[i + 1]) out.outDir = argv[++i];
    else if (argv[i] === '--concurrency' && argv[i + 1]) out.concurrency = Math.max(1, Math.min(32, Number(argv[++i]) || 14));
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out.asOf) || !Number.isFinite(Date.parse(out.asOf + 'T00:00:00Z'))) {
    throw new Error('--as-of must be a valid YYYY-MM-DD date');
  }
  return out;
}

function parseMaybeJsonp(text) {
  const raw = String(text ?? '').trim();
  try { return JSON.parse(raw); } catch {}
  const first = raw.indexOf('(');
  const last = raw.lastIndexOf(')');
  if (first >= 0 && last > first) return JSON.parse(raw.slice(first + 1, last));
  throw new Error('invalid JSON/JSONP response');
}
function rowsOf(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  return [];
}
function asNumber(value) {
  if (value === null || value === undefined || value === '' || value === '-') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function nextCalendarDay(ymd) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10).replaceAll('-', '');
}
function normalizeDate(value) {
  const s = String(value ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}
function codeToSecid(code) {
  return /^(6|68)/.test(String(code)) ? '1.' + code : '0.' + code;
}
function codeToTencent(code) {
  return /^(6|68)/.test(String(code)) ? 'sh' + code : 'sz' + code;
}

async function fetchJson(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': USER_AGENT,
        'accept': 'application/json,text/javascript,text/plain,*/*;q=0.8',
        'referer': 'https://quote.eastmoney.com/'
      },
      cache: 'no-store'
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return parseMaybeJsonp(await response.text());
  } finally {
    clearTimeout(timer);
  }
}
async function fetchFromHosts(buildUrl, hosts, validate, timeoutMs = 5000) {
  let lastError = null;
  for (const host of hosts) {
    try {
      const json = await fetchJson(buildUrl(host), timeoutMs);
      if (validate(json)) return { json, host };
      lastError = new Error('upstream response shape/data invalid');
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('all upstream hosts failed');
}

export async function mapLimit(items, limit, worker, onProgress = null) {
  const output = new Array(items.length);
  let nextIndex = 0;
  let finished = 0;
  async function runWorker() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      try { output[index] = await worker(items[index], index); }
      catch (error) { output[index] = { error: String(error?.message ?? error), inputKey: typeof items[index] === 'object' ? (items[index]?.code ?? items[index]?.page ?? null) : items[index] }; }
      finished++;
      if (onProgress) onProgress(finished, items.length, output[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runWorker));
  return output;
}

export async function writeNdjson(filePath, rows) {
  const stream = createWriteStream(filePath, { encoding: 'utf8' });
  const finished = once(stream, 'finish');
  try {
    for (const row of rows) {
      if (!stream.write(JSON.stringify(row) + '\n')) await once(stream, 'drain');
    }
    stream.end();
    await finished;
  } catch (error) {
    stream.destroy();
    throw error;
  }
}

async function fetchUniversePage(page, pageSize, segmentFs, segmentKey = 'unknown', {timeoutMs=7000,maxAttempts=4,sortOrder=1} = {}) {
  const buildUrl = host => {
    const p = new URLSearchParams({
      pn: String(page), pz: String(pageSize), po: String(sortOrder), np: '1',
      fltt: '2', invt: '2', fid: 'f12', fs: segmentFs, fields: MARKET_FIELDS
    });
    return host + '/api/qt/clist/get?' + p;
  };
  let lastError = null;
  for (let attempt = 1; attempt <= Math.max(1, Number(maxAttempts) || 1); attempt++) {
    try {
      const result = await fetchFromHosts(buildUrl, MARKET_HOSTS,
        json => Number.isInteger(Number(json?.data?.total)) && !!json?.data?.diff &&
          (Array.isArray(json.data.diff) || typeof json.data.diff === 'object')
          && rowsOf(json.data.diff).length > 0, timeoutMs);
      return { total: Number(result.json.data.total), rows: rowsOf(result.json.data.diff) };
    } catch (error) {
      lastError = error;
      if (attempt < Math.max(1, Number(maxAttempts) || 1)) await new Promise(resolve => setTimeout(resolve, Math.min(1000, 250 * (2 ** (attempt - 1)))));
    }
  }
  throw new Error('market segment ' + segmentKey + ' page ' + page + ' failed after ' + Math.max(1, Number(maxAttempts) || 1) + ' attempts: ' + String(lastError?.message ?? lastError));
}

export function isUniverseSegmentCoverageSufficient(collected, minimumPct = 90) {
  if (!collected || !Number.isFinite(Number(collected.total)) || Number(collected.total) <= 0) return false;
  let rows = Number(collected.collected);
  if (Array.isArray(collected.rows)) {
    const codes = collected.rows.map(row=>String(row?.f12??'')).filter(Boolean);
    rows = codes.length ? new Set(codes).size : collected.rows.length;
  }
  return Number.isFinite(rows) && rows >= Number(collected.total) * (Number(minimumPct) / 100);
}

export async function fetchUniverse({ concurrency = 4, pageSize = 100, priorityCodes = [], timeoutMs = 7000, maxAttempts = 4 } = {}) {
  const firstPages = [];
  for (const segment of MARKET_SEGMENTS) {
    try {
      firstPages.push({ segment, first: await fetchUniversePage(1, pageSize, segment.fs, segment.key, {timeoutMs,maxAttempts}) });
    } catch (error) {
      throw new Error('could not establish first page for segment ' + segment.key + ': ' + String(error?.message ?? error));
    }
  }
  const tasks = [];
  const segmentRows = new Map();
  let providerTotal = 0;
  let pageCount = 0;
  for (const { segment, first } of firstPages) {
    providerTotal += first.total;
    segmentRows.set(segment.key, { total: first.total, rows: [...first.rows] });
    const pages = Math.ceil(first.total / pageSize);
    // Some market filters return a valid total but cap forward pagination near
    // 5,000 rows. For oversized segments, combine the forward head and reverse
    // tail, then deduplicate by symbol before evaluating coverage.
    const forwardPages = pages > 50 ? 50 : pages;
    for (let page = 2; page <= forwardPages; page++) tasks.push({segment,page,sortOrder:1});
    if (pages > 50) {
      const reversePages = Math.min(pages, Math.ceil(Math.max(0, first.total - 50 * pageSize) / pageSize) + 2);
      for (let page = 1; page <= reversePages; page++) tasks.push({segment,page,sortOrder:0});
      pageCount += forwardPages + reversePages;
    } else {
      pageCount += pages;
    }
  }
  const pageResults = await mapLimit(tasks, concurrency,
    async task => {
      try {
        return {segmentKey:task.segment.key,page:task.page,
          ...(await fetchUniversePage(task.page,pageSize,task.segment.fs,task.segment.key,{timeoutMs,maxAttempts,sortOrder:task.sortOrder??1}))};
      } catch (error) {
        return {segmentKey:task.segment.key,page:task.page,error:String(error?.message??error)};
      }
    },
    (done, all) => { if (done % 20 === 0 || done === all) console.log('[universe] pages ' + done + '/' + all); });
  const failedPages = pageResults.filter(result => result?.error);
  for (const result of pageResults) {
    const target = segmentRows.get(result.segmentKey);
    if (target && !result.error) target.rows.push(...(result.rows ?? []));
  }
  for (const segment of MARKET_SEGMENTS) {
    const collected = segmentRows.get(segment.key);
    if (!isUniverseSegmentCoverageSufficient(collected, 90)) {
      throw new Error('segment coverage mismatch for ' + segment.key + ': collected ' +
        (collected?.rows.length ?? 0) + ' of ' + (collected?.total ?? 0));
    }
  }
  const allRows = [...segmentRows.values()].flatMap(segment => segment.rows);
  const seen = new Map();
  for (const row of allRows) {
    const code = String(row?.f12 ?? '');
    if (!/^(00|30|60|68|43|83|87|92)\d{4}$/.test(code)) continue;
    if (!seen.has(code)) {
      seen.set(code, {
        code, name: String(row?.f14 ?? code),
        industry: String(row?.f100 ?? '').trim(),
        board: boardForCode(code),
        price: asNumber(row?.f2), pct: asNumber(row?.f3),
        amount: asNumber(row?.f6), turnoverRate: asNumber(row?.f8), volumeRatio: asNumber(row?.f10),
        marketCap: asNumber(row?.f20), pct60: asNumber(row?.f24),
        mainNet: asNumber(row?.f62), mainPct: asNumber(row?.f184)
      });
    }
  }
  if (seen.size < 3000) throw new Error('filtered universe unexpectedly small: ' + seen.size);
  const priorityRank = new Map(priorityCodes.map((code, index) => [String(code), index]));
  return {
    rows: [...seen.values()].sort((a, b) => {
      const rankA = priorityRank.has(a.code) ? priorityRank.get(a.code) : Number.MAX_SAFE_INTEGER;
      const rankB = priorityRank.has(b.code) ? priorityRank.get(b.code) : Number.MAX_SAFE_INTEGER;
      return rankA - rankB || a.code.localeCompare(b.code);
    }),
    providerTotal, pageCount,
    failedPages:failedPages.map(({segmentKey,page,error})=>({segmentKey,page,error})),
    segmentTotals: Object.fromEntries([...segmentRows.entries()].map(([key, value]) => [key, { total: value.total, collected: value.rows.length, coveragePct:Number((value.rows.length/Math.max(1,value.total)*100).toFixed(2)) }]))
  };
}

export function parseKlineRows(rawRows, asOf) {
  const cutoff = String(asOf ?? '').slice(0, 10);
  const byDate = new Map();
  for (const raw of Array.isArray(rawRows) ? rawRows : []) {
    const fields = typeof raw === 'string' ? raw.split(',') : raw;
    const date = normalizeDate(Array.isArray(fields) ? fields[0] : fields?.date);
    if (!date || (cutoff && date > cutoff)) continue;
    const get = (index, key) => Array.isArray(fields) ? asNumber(fields[index]) : asNumber(fields?.[key]);
    const open = get(1, 'open');
    const close = get(2, 'close');
    const high = get(3, 'high');
    const low = get(4, 'low');
    const volume = get(5, 'volume');
    const amount = get(6, 'amount');
    const turnoverRate = get(10, 'turnoverRate');
    if (!(close > 0) || !(high > 0) || !(low > 0) || high < low) continue;
    byDate.set(date, {
      date, open: open ?? close, close, high, low,
      volume: volume ?? 0, amount: amount ?? 0,
      ...(turnoverRate !== null ? { turnoverRate } : {})
    });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
export function parseFlowRows(rawRows, asOf, bars = []) {
  const cutoff = String(asOf ?? '').slice(0, 10);
  const amountByDate = new Map(bars.map(bar => [bar.date, bar.amount]));
  const byDate = new Map();
  for (const raw of Array.isArray(rawRows) ? rawRows : []) {
    const fields = typeof raw === 'string' ? raw.split(',') : raw;
    const date = normalizeDate(Array.isArray(fields) ? fields[0] : fields?.date);
    if (!date || (cutoff && date > cutoff)) continue;
    const mainNet = Array.isArray(fields) ? asNumber(fields[1]) : asNumber(fields?.mainNet ?? fields?.main);
    const mainPct = Array.isArray(fields) ? asNumber(fields[6]) : asNumber(fields?.mainPct ?? fields?.pct);
    if (mainNet === null && mainPct === null) continue;
    byDate.set(date, {
      date, mainNet: mainNet ?? 0, mainPct: mainPct ?? 0,
      amount: amountByDate.get(date) ?? 0
    });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function klineUrl(code, host, asOf) {
  const p = new URLSearchParams({
    secid: codeToSecid(code), klt: '101', fqt: '0',
    beg: '20180101', end: nextCalendarDay(asOf), lmt: '180',
    fields1: 'f1,f2,f3,f4,f5,f6',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61'
  });
  return host + '/api/qt/stock/kline/get?' + p;
}
function flowUrl(code, host) {
  const p = new URLSearchParams({
    secid: codeToSecid(code), klt: '101', lmt: '30',
    fields1: 'f1,f2,f3,f7',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63'
  });
  return host + '/api/qt/stock/fflow/daykline/get?' + p;
}
async function fetchTencentKline(code, asOf) {
  const tc = codeToTencent(code);
  const url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' +
    encodeURIComponent(tc + ',day,,,' + '180' + ',qfq');
  const json = await fetchJson(url, 7000);
  const box = json?.data?.[tc] ?? {};
  const rows = box.qfqday ?? box.day ?? [];
  const bars = parseKlineRows(rows.map(row => [
    row?.[0], row?.[1], row?.[2], row?.[3], row?.[4], row?.[5],
    Number.isFinite(Number(row?.[2])) && Number.isFinite(Number(row?.[5])) ? Number(row[2]) * Number(row[5]) * 100 : 0
  ].join(',')), asOf);
  if (bars.length < 25) throw new Error('Tencent fallback returned fewer than 25 pre-cutoff bars');
  return { bars, source: 'tencent-qfq-fallback' };
}
async function fetchBarsForStock(stock, asOf) {
  let bars = [];
  let eastmoneyError = null;
  try {
    const result = await fetchFromHosts(host => klineUrl(stock.code, host, asOf), HISTORY_HOSTS,
      json => Array.isArray(json?.data?.klines), 4500);
    bars = parseKlineRows(result.json.data.klines, asOf);
    if (bars.length >= 25) return { ...stock, bars, klineSource: 'eastmoney-unadjusted', klineHost: result.host };
  } catch (error) { eastmoneyError = String(error?.message ?? error); }
  try {
    const fallback = await fetchTencentKline(stock.code, asOf);
    return { ...stock, bars: fallback.bars, klineSource: fallback.source, klineHost: 'web.ifzq.gtimg.cn' };
  } catch (error) {
    return { ...stock, bars, klineSource: 'insufficient', klineError: String(error?.message ?? error), eastmoneyError };
  }
}
async function fetchFlowsForStock(stock, asOf) {
  try {
    const result = await fetchFromHosts(host => flowUrl(stock.code, host), HISTORY_HOSTS,
      json => Array.isArray(json?.data?.klines), 4500);
    const flows = parseFlowRows(result.json.data.klines, asOf, stock.bars);
    return { ...stock, flows, flowSource: 'eastmoney', flowHost: result.host };
  } catch (error) {
    return { ...stock, flows: [], flowSource: 'unavailable', flowError: String(error?.message ?? error) };
  }
}

function median(values) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  const middle = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[middle] : (xs[middle - 1] + xs[middle]) / 2;
}
function thresholdForCode(code) {
  const board = boardForCode(code);
  if (board === 'CHINEXT' || board === 'STAR') return 19.0;
  if (board === 'BSE') return 28.5;
  return 9.3;
}
function stockPreEventMetrics(stock) {
  const bars = stock.bars ?? [];
  if (bars.length < 6) return null;
  const last = bars.at(-1);
  const prev = bars.at(-2);
  const prev3 = bars.at(-4);
  const prev5 = bars.at(-6);
  return {
    dailyPct: prev?.close > 0 ? (last.close / prev.close - 1) * 100 : null,
    r3Pct: prev3?.close > 0 ? (last.close / prev3.close - 1) * 100 : null,
    r5Pct: prev5?.close > 0 ? (last.close / prev5.close - 1) * 100 : null
  };
}
export function addHistoricalIndustryContext(stocks) {
  const byIndustry = new Map();
  for (const stock of stocks) {
    const industry = String(stock.industry ?? '').trim();
    const metrics = stockPreEventMetrics(stock);
    if (!industry || !metrics) continue;
    const group = byIndustry.get(industry) ?? [];
    group.push({ code: stock.code, metrics, threshold: thresholdForCode(stock.code) });
    byIndustry.set(industry, group);
  }
  const stats = new Map();
  for (const [industry, group] of byIndustry) {
    const r3 = group.map(row => row.metrics.r3Pct).filter(Number.isFinite);
    const r5 = group.map(row => row.metrics.r5Pct).filter(Number.isFinite);
    const upRatio = r3.length ? r3.filter(value => value > 0).length / r3.length : null;
    const limitUpCount = group.filter(row => Number.isFinite(row.metrics.dailyPct) && row.metrics.dailyPct >= row.threshold).length;
    stats.set(industry, {
      return3Pct: median(r3), return5Pct: median(r5), upRatio, limitUpCount,
      members: group
    });
  }
  return stocks.map(stock => {
    const industry = String(stock.industry ?? '').trim();
    const groupStats = stats.get(industry);
    const own = stockPreEventMetrics(stock);
    if (!groupStats || !own) return { ...stock, sector: {} };
    const peerReturns = groupStats.members.map(row => row.metrics.r5Pct).filter(Number.isFinite);
    const below = peerReturns.filter(value => value < own.r5Pct).length;
    const equal = peerReturns.filter(value => value === own.r5Pct).length;
    const leaderScore = peerReturns.length ? 100 * (below + equal / 2) / peerReturns.length : null;
    return {
      ...stock,
      sector: {
        ...(Number.isFinite(groupStats.return3Pct) ? { return3Pct: groupStats.return3Pct } : {}),
        ...(Number.isFinite(groupStats.return5Pct) ? { return5Pct: groupStats.return5Pct } : {}),
        ...(Number.isFinite(groupStats.upRatio) ? { upRatio: groupStats.upRatio } : {}),
        limitUpCount: groupStats.limitUpCount,
        ...(Number.isFinite(leaderScore) ? { leaderScore } : {})
      }
    };
  });
}

function compactResult(row, rank) {
  return {
    rank, code: row.code, name: row.name, board: row.board, asOf: row.asOf,
    price: row.price, currentPct: row.currentPct, score: row.score,
    grossScore: row.grossScore, riskPenalty: row.riskPenalty,
    confidence: row.confidence, setup: row.setup, scorePath: row.scorePath,
    discoveryEligible: row.discoveryEligible, executionEligible: row.executionEligible,
    components: row.components, features: row.features, riskFlags: row.riskFlags
  };
}
function eventTargetsForDate(targets, asOf) {
  return (Array.isArray(targets?.targets) ? targets.targets : [])
    .filter(target => !target.signalDate || target.signalDate === asOf);
}
function makeTargetReport(target, ranked, scoredCodes, candidateCodes) {
  const index = ranked.findIndex(row => row.code === target.code);
  const result = index >= 0 ? ranked[index] : null;
  const wasInCandidateData = candidateCodes.has(target.code);
  return {
    code: target.code, name: target.name, board: target.board,
    signalDate: target.signalDate ?? null, outcomeDate: target.outcomeDate ?? null,
    knownOutcome: target.outcome ?? null,
    rank: result ? index + 1 : null,
    inTop10: !!result && index < 10,
    inTop30: !!result && index < 30,
    inTop50: !!result && index < 50,
    score: result?.score ?? null, scorePath: result?.scorePath ?? null,
    setup: result?.setup ?? null, confidence: result?.confidence ?? null,
    components: result?.components ?? null, features: result?.features ?? null,
    riskFlags: result?.riskFlags ?? [],
    scored: scoredCodes.has(target.code),
    missingReason: result ? null : wasInCandidateData ? 'excluded_by_scorer' : 'historical_bars_unavailable_or_insufficient'
  };
}

export function isTrueLimitUpOutcome(outcome) {
  return /^limit_up(?:_|$)/i.test(String(outcome ?? ''));
}

export function assessReplayQuality({ universeCount = 0, barSuccessCount = 0, targetCodes = [], scoredCodes = [] } = {}) {
  const denominator = Math.max(1, Number(universeCount) || 0);
  const barCoverageRatio = Math.max(0, Number(barSuccessCount) || 0) / denominator;
  const scored = new Set([...scoredCodes].map(String));
  const missingTargetCodes = targetCodes.map(String).filter(code => !scored.has(code));
  const reasons = [];
  if (barCoverageRatio < 0.90) reasons.push('historical-bar-coverage-below-90pct');
  if (missingTargetCodes.length) reasons.push('one-or-more-audit-targets-not-scored');
  return {
    status: reasons.length ? 'NOT_MEASURABLE' : 'MEASURABLE',
    measurable: reasons.length === 0,
    minimumBarCoveragePct: 90,
    barCoveragePct: Number((barCoverageRatio * 100).toFixed(2)),
    missingTargetCodes,
    reasons
  };
}

export async function runHistoricalReplay({ asOf, outDir = 'output/v13-history-replay', concurrency = 6 } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(asOf ?? ''))) throw new Error('runHistoricalReplay requires asOf YYYY-MM-DD');
  const startedAt = new Date().toISOString();
  const targetsFile = JSON.parse(await readFile(TARGETS_PATH, 'utf8'));
  const targets = eventTargetsForDate(targetsFile, asOf);
  console.log('[replay] collecting current symbol list; historical bars will be cutoff at ' + asOf);
  console.log('[replay] audit target symbols are prioritized for data collection only; they do not alter scoring or ranking');
  const universe = await fetchUniverse({
    concurrency: Math.min(4, concurrency), pageSize: 100,
    priorityCodes: targets.map(target => target.code)
  });
  console.log('[replay] universe rows=' + universe.rows.length + ', providerTotal=' + universe.providerTotal + ', segments=' + JSON.stringify(universe.segmentTotals));

  const barFailures = [];
  const barResults = await mapLimit(universe.rows, concurrency, async stock => {
    const result = await fetchBarsForStock(stock, asOf);
    if ((result.bars?.length ?? 0) < 25) barFailures.push({ code: stock.code, name: stock.name, error: result.klineError ?? 'fewer-than-25-bars' });
    return result;
  }, (done, all) => {
    if (done % 100 === 0 || done === all) console.log('[bars] ' + done + '/' + all);
  });
  for (const row of barResults) {
    if (row?.error) barFailures.push({ code: row.inputKey ?? null, name: null, error: row.error });
  }
  let stocks = barResults.filter(stock => Array.isArray(stock?.bars) && stock.bars.length >= 25);
  const barsSuccessCount = stocks.length;
  const barCoveragePct = Number((barsSuccessCount / Math.max(1, universe.rows.length) * 100).toFixed(2));
  console.log('[replay] stocks with >=25 pre-cutoff bars=' + barsSuccessCount + '/' + universe.rows.length +
    ' (' + barCoveragePct + '%), failed/short=' + (universe.rows.length - barsSuccessCount));

  stocks = addHistoricalIndustryContext(stocks);
  const flowFailures = [];
  stocks = await mapLimit(stocks, concurrency, async stock => {
    const result = await fetchFlowsForStock(stock, asOf);
    if (result.flowSource !== 'eastmoney' || result.flows.length < 3) {
      flowFailures.push({ code: stock.code, name: stock.name, source: result.flowSource, rows: result.flows.length, error: result.flowError ?? null });
    }
    return result;
  }, (done, all) => {
    if (done % 100 === 0 || done === all) console.log('[flows] ' + done + '/' + all);
  });

  const candidates = stocks.map(stock => ({
    code: stock.code, name: stock.name, industry: stock.industry, asOf,
    isST: /ST|退/i.test(stock.name),
    bars: stock.bars, flows: stock.flows, sector: stock.sector,
    amount: stock.bars.at(-1)?.amount,
    turnoverRate: stock.bars.at(-1)?.turnoverRate
  }));
  const ranked = rankCandidates(candidates, { asOf });
  const rankedWithPosition = ranked.map((row, index) => ({ ...row, rank: index + 1 }));
  const scoredCodes = new Set(ranked.map(row => row.code));
  const candidateCodes = new Set(candidates.map(row => row.code));
  const quality = assessReplayQuality({
    universeCount: universe.rows.length,
    barSuccessCount: barsSuccessCount,
    targetCodes: targets.map(target => target.code),
    scoredCodes
  });
  const targetReports = targets.map(target => makeTargetReport(target, ranked, scoredCodes, candidateCodes));
  const trueLimitUpTargets = targetReports.filter(target => isTrueLimitUpOutcome(target.knownOutcome));
  const flowRowsAtLeast3Count = stocks.filter(stock => stock.flows.length >= 3).length;
  const flowCoveragePct = Number((flowRowsAtLeast3Count / Math.max(1, stocks.length) * 100).toFixed(2));
  const report = {
    model: 'V13-limitup-precursor-research',
    asOf,
    validation: {
      ...quality,
      targetCount: targets.length,
      targetScoredCount: targetReports.filter(target => target.scored).length,
      flowCoveragePct,
      flowCoverageWarning: flowCoveragePct < 60 ? 'flow-history-coverage-below-60pct' : null,
      rankingStatus: quality.measurable ? 'ELIGIBLE_FOR_RECALL_EVALUATION' : 'DIAGNOSTIC_ONLY'
    },
    startedAt, completedAt: new Date().toISOString(),
    dataPolicy: {
      priceBars: 'Eastmoney unadjusted daily K-lines; rows after asOf excluded before scoring',
      fundFlows: 'Eastmoney daily main-flow rows; rows after asOf excluded before scoring',
      industryContext: 'Industry labels are from the current symbol-list response; all industry breadth/returns are rebuilt from bars cut off at asOf',
      universe: 'Current provider listing used as a proxy for the historical 2026-10-20 universe; not an exchange-certified point-in-time constituent snapshot',
      targetOutcomes: 'Used only for post-ranking audit; never passed into candidate features',
      targetCollectionOrder: 'Audit target codes are fetched first to protect diagnostics from late-run provider throttling; scoring weights and rank logic are unchanged',
      futureLeakageGuard: 'K-line and flow rows dated after asOf are excluded by parsers and the scorer'
    },
    coverage: {
      providerUniverseTotal: universe.providerTotal,
      filteredCurrentUniverseCount: universe.rows.length,
      barSuccessCount: barsSuccessCount,
      barCoveragePct,
      barFailureOrShortCount: Math.max(0, universe.rows.length - barsSuccessCount),
      scoredCandidateCount: ranked.length,
      flowRowsAtLeast3Count,
      flowUnavailableOrShortCount: flowFailures.length,
      eastmoneyKlineCount: stocks.filter(stock => stock.klineSource === 'eastmoney-unadjusted').length,
      tencentFallbackKlineCount: stocks.filter(stock => stock.klineSource === 'tencent-qfq-fallback').length,
      sectorContextCoverageCount: stocks.filter(stock => Object.keys(stock.sector ?? {}).length >= 3).length,
      flowCoveragePct,
      barFailureSample: barFailures.slice(0, 30),
      flowFailureSample: flowFailures.slice(0, 30)
    },
    targetCapture: {
      status: quality.status,
      allFourTop10: quality.measurable ? targetReports.length === 4 && targetReports.every(target => target.inTop10) : null,
      allFourTop30: quality.measurable ? targetReports.length === 4 && targetReports.every(target => target.inTop30) : null,
      trueLimitUpTargetCount: trueLimitUpTargets.length,
      trueLimitUpTargetsTop10: quality.measurable ? trueLimitUpTargets.filter(target => target.inTop10).length : null,
      trueLimitUpTargetsTop30: quality.measurable ? trueLimitUpTargets.filter(target => target.inTop30).length : null,
      targets: targetReports
    },
    top10: rankedWithPosition.slice(0, 10).map((row, index) => compactResult(row, index + 1)),
    top30: rankedWithPosition.slice(0, 30).map((row, index) => compactResult(row, index + 1))
  };
  const outPath = resolve(outDir);
  await mkdir(outPath, { recursive: true });
  await writeFile(resolve(outPath, 'replay_report.json'), JSON.stringify(report, null, 2));
  await writeNdjson(resolve(outPath, 'replay_candidates.ndjson'), candidates);
  await writeFile(resolve(outPath, 'replay_ranked.json'), JSON.stringify(rankedWithPosition));
  await writeFile(resolve(outPath, 'collector_diagnostics.json'), JSON.stringify({
    asOf, startedAt, completedAt: new Date().toISOString(),
    universeProviderTotal: universe.providerTotal, currentUniverseCount: universe.rows.length,
    barsSuccessCount, barFailures, flowFailures,
    klineSourceCounts: stocks.reduce((acc, stock) => { acc[stock.klineSource] = (acc[stock.klineSource] ?? 0) + 1; return acc; }, {}),
    flowSourceCounts: stocks.reduce((acc, stock) => { acc[stock.flowSource] = (acc[stock.flowSource] ?? 0) + 1; return acc; }, {})
  }, null, 2));

  console.log('\n===== V13 HISTORICAL REPLAY SUMMARY =====');
  console.log(JSON.stringify({
    model: report.model, asOf,
    coverage: report.coverage,
    targetCapture: report.targetCapture,
    top10: report.top10.map(row => ({
      rank: row.rank, code: row.code, name: row.name, score: row.score,
      scorePath: row.scorePath, setup: row.setup, confidence: row.confidence
    })),
    top30: report.top30.map(row => ({
      rank: row.rank, code: row.code, name: row.name, score: row.score,
      scorePath: row.scorePath, setup: row.setup, confidence: row.confidence
    }))
  }, null, 2));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = parseArgs(process.argv.slice(2));
  try {
    await runHistoricalReplay(args);
  } catch (error) {
    const outPath = resolve(args.outDir);
    await mkdir(outPath, { recursive: true });
    const diagnostic = {
      model: 'V13-limitup-precursor-research',
      asOf: args.asOf,
      validation: {
        status: 'NOT_MEASURABLE',
        measurable: false,
        rankingStatus: 'DIAGNOSTIC_ONLY',
        reasons: ['collection-or-replay-failed'],
        error: String(error?.message ?? error)
      },
      completedAt: new Date().toISOString()
    };
    let reportExists = false;
    try { await readFile(resolve(outPath, 'replay_report.json'), 'utf8'); reportExists = true; } catch {}
    if (!reportExists) await writeFile(resolve(outPath, 'replay_report.json'), JSON.stringify(diagnostic, null, 2));
    await writeFile(resolve(outPath, 'run_failure.json'), JSON.stringify(diagnostic, null, 2));
    await writeFile(resolve(outPath, 'collector_diagnostics.json'), JSON.stringify(diagnostic, null, 2));
    console.error('[replay] NOT_MEASURABLE: ' + String(error?.stack ?? error));
    process.exitCode = 1;
  }
}
