import {extractNarrativeTags} from '../research/v16/narrative_theme.js';

export const config = {maxDuration: 30};

const EM_HOSTS = [
  'https://push2.eastmoney.com',
  'https://7.push2.eastmoney.com',
  'https://43.push2.eastmoney.com',
  'https://89.push2.eastmoney.com'
];
const MARKET_FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048';
const MARKET_FIELDS = 'f12,f14,f2,f3,f6,f8,f10,f62,f100,f124';
const INDEXES = [
  {key: 'shanghai', name: '上证指数', secid: '1.000001'},
  {key: 'shenzhen', name: '深证成指', secid: '0.399001'},
  {key: 'chinext', name: '创业板指', secid: '0.399006'},
  {key: 'star50', name: '科创50', secid: '1.000688'},
  {key: 'csi1000', name: '中证1000', secid: '1.000852'}
];
const US_SYMBOLS = {
  indices: {nasdaqComposite: '^IXIC', nasdaq100: '^NDX', sox: '^SOX'},
  stocks: {NVDA: 'NVDA', AMD: 'AMD', AVGO: 'AVGO', MU: 'MU', SNDK: 'SNDK', MSFT: 'MSFT', AMZN: 'AMZN', GOOGL: 'GOOGL', META: 'META'},
  etfs: {smh: 'SMH', soxx: 'SOXX', qqq: 'QQQ'}
};

const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const num = value => finite(value) ? Number(value) : null;

function send(res, status, body, maxAge = 60) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'public, s-maxage=' + maxAge + ', stale-while-revalidate=120');
  res.status(status).send(JSON.stringify(body));
}
function parseMaybeJsonp(text) {
  const value = String(text ?? '').trim();
  try { return JSON.parse(value); } catch {}
  const start = value.indexOf('(');
  const end = value.lastIndexOf(')');
  if (start >= 0 && end > start) return JSON.parse(value.slice(start + 1, end));
  throw new Error('invalid JSON/JSONP payload');
}
async function fetchText(url, timeout = 5000, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {'user-agent': 'Mozilla/5.0 AShareQuantV16/1.0', 'accept': 'application/json,text/plain,*/*', ...headers}
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}
async function fetchJson(url, timeout = 5000, headers = {}) {
  return parseMaybeJsonp(await fetchText(url, timeout, headers));
}
async function mapLimit(items, limit, fn) {
  const output = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      try { output[index] = await fn(items[index], index); }
      catch (error) { output[index] = {error: String(error?.message ?? error)}; }
    }
  }
  await Promise.all(Array.from({length: Math.min(Math.max(1, limit), Math.max(1, items.length))}, worker));
  return output;
}
function marketPageUrl(host, page, pageSize) {
  const params = new URLSearchParams({
    pn: String(page), pz: String(pageSize), po: '1', np: '1', fltt: '2', invt: '2',
    fid: 'f6', fs: MARKET_FS, fields: MARKET_FIELDS
  });
  return host + '/api/qt/clist/get?' + params.toString();
}
async function fetchMarketPage(page, pageSize = 500) {
  let lastError;
  for (let index = 0; index < EM_HOSTS.length; index++) {
    const host = EM_HOSTS[index];
    try {
      const payload = await fetchJson(marketPageUrl(host, page, pageSize), 4500, {referer: 'https://quote.eastmoney.com/'});
      if (Array.isArray(payload?.data?.diff)) return payload;
      throw new Error('market page missing data.diff');
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('market data source unavailable');
}
async function fetchMarketUniverse() {
  const pageSize = 500;
  const first = await fetchMarketPage(1, pageSize);
  const total = Number(first?.data?.total) || 0;
  if (!total) throw new Error('market universe total unavailable');
  const pageCount = Math.min(12, Math.ceil(total / pageSize));
  const rest = await mapLimit(Array.from({length: Math.max(0, pageCount - 1)}, (_, index) => index + 2), 4,
    page => fetchMarketPage(page, pageSize));
  const pages = [{page: 1, payload: first}];
  const failures = [];
  rest.forEach((result, index) => {
    if (result?.error) failures.push({page: index + 2, error: result.error});
    else if (Number(result?.data?.total) !== total) failures.push({page: index + 2, error: 'universe-total-changed'});
    else pages.push({page: index + 2, payload: result});
  });
  const byCode = new Map();
  for (const {page, payload} of pages) {
    for (const row of payload.data.diff) {
      const code = String(row?.f12 ?? '');
      if (/^\d{6}$/.test(code)) byCode.set(code, row);
    }
  }
  return {
    total,
    rows: [...byCode.values()],
    pagesFetched: pages.length,
    pageCount,
    failures,
    coverage: total ? byCode.size / total : 0,
    complete: failures.length === 0 && pages.length === pageCount && byCode.size / total >= 0.95
  };
}
function limitPct(code, name) {
  if (/(?:\*?ST|退)/i.test(String(name ?? ''))) return 5;
  if (/^(30|68)/.test(code)) return 20;
  if (/^(4|8|92)/.test(code)) return 30;
  return 10;
}
export function summarizeMarketUniverse(universe) {
  const rows = Array.isArray(universe?.rows) ? universe.rows : [];
  let up = 0, down = 0, flat = 0, knownPct = 0, amountCny = 0;
  let limitUpProxy = 0, limitDownProxy = 0;
  const industries = new Map();
  let latestQuoteTimestamp = null;
  for (const row of rows) {
    const code = String(row?.f12 ?? '');
    const name = String(row?.f14 ?? code);
    const pct = num(row?.f3);
    const amount = num(row?.f6);
    const flow = num(row?.f62);
    const industry = String(row?.f100 ?? '').trim() || '行业未知';
    if (pct !== null) {
      knownPct++;
      if (pct > 0.01) up++;
      else if (pct < -0.01) down++;
      else flat++;
      const band = limitPct(code, name);
      if (pct >= band - 0.15) limitUpProxy++;
      if (pct <= -band + 0.15) limitDownProxy++;
    }
    if (amount !== null && amount > 0) amountCny += amount;
    const timestamp = num(row?.f124);
    if (timestamp !== null) latestQuoteTimestamp = Math.max(latestQuoteTimestamp ?? 0, timestamp);
    if (!industries.has(industry)) industries.set(industry, []);
    industries.get(industry).push({pct, flow});
  }
  const breadth = {
    up, down, flat, knownPct,
    upRatio: knownPct ? up / knownPct : null,
    universe: universe?.complete ? 'full-market' : 'partial-market',
    fullMarket: universe?.complete === true,
    coverage: Number(universe?.coverage ?? 0),
    totalReported: Number(universe?.total ?? 0),
    uniqueSymbols: rows.length
  };
  const validMarketReturns = rows.map(row => num(row?.f3)).filter(Number.isFinite);
  const marketAveragePct = validMarketReturns.length ? validMarketReturns.reduce((sum, value) => sum + value, 0) / validMarketReturns.length : null;
  const leaders = rows.map(row => ({
    code: String(row?.f12 ?? ''), name: String(row?.f14 ?? ''), industry: String(row?.f100 ?? ''), pct: num(row?.f3)
  })).filter(row => /^\d{6}$/.test(row.code) && row.pct !== null && !/(?:\*?ST|退)/i.test(row.name))
    .sort((a, b) => b.pct - a.pct).slice(0, 20).map(row => ({
      ...row,
      relativeStrengthPct: marketAveragePct === null ? null : row.pct - marketAveragePct
    }));
  const narrativeStocks = rows.map(row => {
    const code = String(row?.f12 ?? '');
    const name = String(row?.f14 ?? code);
    const themeKeys = extractNarrativeTags(name);
    if (!themeKeys.length || !/^\\d{6}$/.test(code)) return null;
    const pct = num(row?.f3);
    return {
      code, name, themeKeys, pct,
      amount: num(row?.f6),
      turnoverPct: num(row?.f8),
      industry: String(row?.f100 ?? ''),
      nearLimitUpProxy: pct !== null && pct >= limitPct(code, name) - 0.15
    };
  }).filter(Boolean);
  const sectorRows = [...industries.entries()].map(([name, members]) => {
    const validReturns = members.map(row => row.pct).filter(Number.isFinite);
    const validFlows = members.map(row => row.flow).filter(Number.isFinite);
    const sectorAverage = validReturns.length ? validReturns.reduce((sum, value) => sum + value, 0) / validReturns.length : null;
    const sectorLeader = validReturns.length ? Math.max(...validReturns) : null;
    return {
      key: name,
      label: name,
      constituentCount: members.length,
      d1Pct: sectorAverage,
      leaderRelativeStrengthPct: sectorLeader === null || sectorAverage === null ? null : sectorLeader - sectorAverage,
      advancersRatio: validReturns.length ? validReturns.filter(value => value > 0).length / validReturns.length : null,
      positiveFlowRatio: validFlows.length ? validFlows.filter(value => value > 0).length / validFlows.length : null,
      netFlowCny: validFlows.length ? validFlows.reduce((sum, value) => sum + value, 0) : null,
      sourceScope: 'eastmoney-industry-constituent-proxy'
    };
  }).filter(row => row.constituentCount >= 5).sort((a, b) => (b.d1Pct ?? -Infinity) - (a.d1Pct ?? -Infinity));
  sectorRows.forEach((row, index) => { row.rankToday = index + 1; });
  const quoteTimestampMs = latestQuoteTimestamp === null ? null
    : latestQuoteTimestamp > 1e12 ? latestQuoteTimestamp : latestQuoteTimestamp * 1000;
  return {
    breadth,
    turnover: {amountCny: amountCny || null},
    sentiment: {
      limitUpCount: limitUpProxy,
      limitDownCount: limitDownProxy,
      brokenBoardRate: 'NOT_MEASURABLE',
      nextDayPremiumPct: 'NOT_MEASURABLE',
      limitLabelQuality: 'APPROXIMATE_PROXY',
      newListingRuleUncertainty: 'NOT_FILTERED'
    },
    sectors: sectorRows,
    narrativeStocks,
    narrativeSourceScope: universe?.complete === true ? 'full-market' : 'partial-market',
    leaders,
    marketAveragePct,
    source: {
      provider: 'Eastmoney',
      total: universe?.total ?? 0,
      uniqueSymbols: rows.length,
      pagesFetched: universe?.pagesFetched ?? 0,
      pageCount: universe?.pageCount ?? 0,
      coveragePct: Number(((universe?.coverage ?? 0) * 100).toFixed(2)),
      complete: universe?.complete === true,
      failures: universe?.failures ?? [],
      latestQuoteTimestamp: quoteTimestampMs ? new Date(quoteTimestampMs).toISOString() : null
    }
  };
}
function indexKlineUrl(secid) {
  const params = new URLSearchParams({
    secid, klt: '101', fqt: '1', beg: '20260101', end: '20500101', lmt: '80',
    fields1: 'f1,f2,f3,f4,f5,f6',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61'
  });
  return 'https://push2his.eastmoney.com/api/qt/stock/kline/get?' + params.toString();
}
export function summarizeIndexKline(index, payload) {
  const strings = payload?.data?.klines;
  if (!Array.isArray(strings) || strings.length < 2) return {...index, status: 'NOT_MEASURABLE'};
  const bars = strings.map(value => {
    const parts = String(value).split(',');
    return {date: parts[0], open: num(parts[1]), close: num(parts[2]), high: num(parts[3]), low: num(parts[4]), volume: num(parts[5]), amount: num(parts[6])};
  }).filter(bar => bar.date && bar.close !== null && bar.close > 0);
  if (bars.length < 2) return {...index, status: 'NOT_MEASURABLE'};
  const closes = bars.map(bar => bar.close);
  const latest = bars.at(-1);
  const previous = bars.at(-2);
  const average = count => {
    const sample = closes.slice(-count);
    return sample.length === count ? sample.reduce((sum, value) => sum + value, 0) / count : null;
  };
  const ma5 = average(5), ma10 = average(10), ma20 = average(20);
  const trend5Pct = closes.length >= 6 ? (latest.close / closes.at(-6) - 1) * 100 : null;
  const trend20Pct = closes.length >= 21 ? (latest.close / closes.at(-21) - 1) * 100 : null;
  return {
    ...index,
    status: 'AVAILABLE',
    date: latest.date,
    close: latest.close,
    changePct: (latest.close / previous.close - 1) * 100,
    trend5Pct,
    trend20Pct,
    ma5, ma10, ma20,
    aboveMa5: ma5 === null ? null : latest.close >= ma5,
    aboveMa10: ma10 === null ? null : latest.close >= ma10,
    aboveMa20: ma20 === null ? null : latest.close >= ma20,
    barCount: bars.length
  };
}
async function fetchIndex(index) {
  const payload = await fetchJson(indexKlineUrl(index.secid), 5000, {referer: 'https://quote.eastmoney.com/'});
  return summarizeIndexKline(index, payload);
}
function dateInZone(timestampSeconds, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(timestampSeconds * 1000));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return values.year + '-' + values.month + '-' + values.day;
}
export function parseYahooDailyChange(payload, symbol, aShareCalendarDate) {
  const result = payload?.chart?.result?.[0];
  const timestamps = result?.timestamp;
  const closes = result?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(timestamps) || !Array.isArray(closes)) return {symbol, status: 'NOT_MEASURABLE'};
  const timeZone = result?.meta?.exchangeTimezoneName || 'America/New_York';
  const bars = timestamps.map((timestamp, index) => ({
    date: dateInZone(timestamp, timeZone),
    close: num(closes[index])
  })).filter(bar => bar.close !== null && bar.close > 0 && bar.date < aShareCalendarDate)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (bars.length < 2) return {symbol, status: 'NOT_MEASURABLE', eligibleBarCount: bars.length};
  const previous = bars.at(-2), latest = bars.at(-1);
  return {
    symbol,
    status: 'AVAILABLE',
    date: latest.date,
    close: latest.close,
    previousClose: previous.close,
    pct: (latest.close / previous.close - 1) * 100,
    source: 'Yahoo Finance chart',
    eligibleBarCount: bars.length
  };
}
async function fetchYahooSymbol(symbol, aShareCalendarDate) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol)
    + '?range=7d&interval=1d&events=div%2Csplits';
  const payload = await fetchJson(url, 6500, {referer: 'https://finance.yahoo.com/'});
  return parseYahooDailyChange(payload, symbol, aShareCalendarDate);
}
function chinaDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return values.year + '-' + values.month + '-' + values.day;
}
function chinaClock() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const hour = Number(values.hour), minute = Number(values.minute);
  return {
    text: String(values.hour).padStart(2, '0') + ':' + String(values.minute).padStart(2, '0'),
    closeFinalized: hour > 15 || (hour === 15 && minute >= 10)
  };
}
async function fetchUsMarket(aShareCalendarDate) {
  const specs = Object.entries(US_SYMBOLS).flatMap(([group, values]) =>
    Object.entries(values).map(([key, symbol]) => ({group, key, symbol}))
  );
  const results = await mapLimit(specs, 8, spec => fetchYahooSymbol(spec.symbol, aShareCalendarDate));
  const output = {asOf: null, indices: {}, stocks: {}, etfs: {}, policyEvents: [], policyEventStatus: 'NOT_MEASURABLE'};
  const failures = [];
  const dates = [];
  results.forEach((result, index) => {
    const spec = specs[index];
    if (result?.error || result?.status !== 'AVAILABLE') {
      failures.push({symbol: spec.symbol, error: result?.error ?? result?.status ?? 'unknown'});
      return;
    }
    output[spec.group][spec.key] = {pct: result.pct, date: result.date, close: result.close, previousClose: result.previousClose};
    dates.push(result.date);
  });
  output.asOf = dates.length ? dates.sort().at(-1) : null;
  output.source = {provider: 'Yahoo Finance chart', requested: specs.length, available: dates.length, failures};
  return output;
}

export default async function handler(req, res) {
  try {
    const calendarDate = chinaDate();
    const localClock = chinaClock();
    const [universeResult, indexResults, us] = await Promise.all([
      fetchMarketUniverse(),
      mapLimit(INDEXES, 5, fetchIndex),
      fetchUsMarket(calendarDate)
    ]);
    const universe = summarizeMarketUniverse(universeResult);
    const indices = indexResults.filter(row => row && row.status === 'AVAILABLE');
    const indexFailures = indexResults.flatMap((row, index) => !row || row.status !== 'AVAILABLE' ? [INDEXES[index]?.key ?? 'unknown'] : []);
    const aShareSessionDate = indices.find(row => row.key === 'shanghai')?.date ?? null;
    const body = {
      schema: 'ashare-v16-market-context-v1',
      capturedAt: new Date().toISOString(),
      chinaCalendarDate: calendarDate,
      chinaLocalTime: localClock.text,
      chinaCloseFinalized: localClock.closeFinalized,
      aShareSessionDate,
      aShare: {
        indices,
        breadth: universe.breadth,
        turnover: universe.turnover,
        sentiment: universe.sentiment,
        sectors: universe.sectors,
        narrativeStocks: universe.narrativeStocks,
        narrativeSourceScope: universe.narrativeSourceScope,
        leaders: universe.leaders,
        marketAveragePct: universe.marketAveragePct,
        source: universe.source,
        dataStatus: aShareSessionDate === calendarDate ? (localClock.closeFinalized ? 'FINALIZED_SESSION' : 'INTRADAY_PROVISIONAL') : 'LAST_AVAILABLE_SESSION',
        indexFailures
      },
      us,
      capabilities: {
        fullMarketBreadth: universe.breadth.fullMarket ? 'MEASURABLE' : 'PARTIAL',
        indexTrend: indices.length >= 3 ? 'MEASURABLE' : 'PARTIAL',
        exactLimitUpDown: 'APPROXIMATE_PROXY',
        brokenBoardRate: 'NOT_MEASURABLE',
        nextDayPremium: 'NOT_MEASURABLE',
        auction: 'NOT_MEASURABLE',
        first15Minutes: 'NOT_MEASURABLE',
        vwap: 'NOT_MEASURABLE',
        orderBookAndCancellation: 'NOT_MEASURABLE',
        policyEvents: 'NOT_MEASURABLE',
        themeMembership: 'NOT_MEASURABLE'
      },
      limitations: [
        'A-share limit-up/down counts are approximate percentage-band proxies; new-listing special rules are not filtered.',
        'Industry breadth is a constituent-sample proxy, not verified concept/theme membership.',
        'Yahoo Finance daily bars are filtered to dates strictly before the China calendar date to prevent same-date US data leakage.',
        'No daily close is substituted for auction, first-15-minute, VWAP, broken-board or order-book evidence.'
      ]
    };
    return send(res, 200, body, 60);
  } catch (error) {
    return send(res, 502, {
      schema: 'ashare-v16-market-context-error-v1',
      status: 'SOURCE_UNAVAILABLE',
      error: String(error?.message ?? error),
      capturedAt: new Date().toISOString()
    }, 0);
  }
}
