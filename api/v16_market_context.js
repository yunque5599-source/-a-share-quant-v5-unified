import {extractNarrativeTags} from '../research/v16/narrative_theme.js';
import {summarizeLimitPools, summarizeLhbContext} from '../research/v16/flow_lhb.js';

export const config = {maxDuration: 300};

const EM_HOSTS = [
  'https://push2.eastmoney.com',
  'https://7.push2.eastmoney.com',
  'https://43.push2.eastmoney.com',
  'https://89.push2.eastmoney.com'
];
const MARKET_FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048';
const MARKET_FIELDS = 'f12,f14,f2,f3,f5,f6,f8,f9,f10,f15,f16,f17,f18,f20,f21,f23,f24,f25,f62,f100,f124,f184';
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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
      headers: {'user-agent': 'Mozilla/5.0 AShareQuant/10.1.8-S', 'accept': 'application/json,text/javascript,*/*;q=0.8', ...headers}
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
    pn: String(page), pz: String(pageSize), po: '1', np: '1', fltt: '2', invt: '2', ut: 'bd1d9ddb04089700cf9c27f6f7426281',
    fid: 'f6', fs: MARKET_FS, fields: MARKET_FIELDS
  });
  return host + '/api/qt/clist/get?' + params.toString();
}
let nextMarketRequestAt = 0;
async function waitForMarketRequestSlot() {
  const now = Date.now();
  const startAt = Math.max(now, nextMarketRequestAt);
  nextMarketRequestAt = startAt + 4000;
  if (startAt > now) await sleep(startAt - now);
}

async function fetchMarketPage(page, pageSize = 100, attempt = 0) {
  const host = EM_HOSTS[(page - 1 + attempt) % EM_HOSTS.length];
  await waitForMarketRequestSlot();
  const payload = await fetchJson(marketPageUrl(host, page, pageSize), 3500, {referer: 'https://quote.eastmoney.com/'});
  if (!Array.isArray(payload?.data?.diff)) throw new Error('market page missing data.diff');
  return payload;
}

async function fetchMarketPageWithRetry(page, pageSize = 100) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fetchMarketPage(page, pageSize, attempt);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('market data source unavailable');
}

export async function collectMarketUniversePages({
  firstPage, fetchPage, pageSize = 100, maxPages = 80, concurrency = 4
}) {
  const total = Number(firstPage?.data?.total) || 0;
  if (!total) throw new Error('market universe total unavailable');
  if (typeof fetchPage !== 'function') throw new TypeError('fetchPage must be a function');
  const pageCount = Math.ceil(total / pageSize);
  const pagesToFetch = Math.min(maxPages, pageCount);
  const rest = await mapLimit(
    Array.from({length: Math.max(0, pagesToFetch - 1)}, (_, index) => index + 2),
    concurrency,
    page => fetchPage(page)
  );
  const pages = [{page: 1, payload: firstPage}];
  const failures = [];
  rest.forEach((result, index) => {
    const page = index + 2;
    if (result?.error) failures.push({page, error: result.error});
    else if (!Array.isArray(result?.data?.diff)) failures.push({page, error: 'market page missing data.diff'});
    else if (Number(result?.data?.total) !== total) failures.push({page, error: 'universe-total-changed'});
    else pages.push({page, payload: result});
  });
  const byCode = new Map();
  for (const {payload} of pages) {
    for (const row of payload.data.diff) {
      const code = String(row?.f12 ?? '');
      if (/^\d{6}$/.test(code)) byCode.set(code, row);
    }
  }
  const coverage = total ? byCode.size / total : 0;
  return {
    total,
    rows: [...byCode.values()],
    pagesFetched: pages.length,
    pageCount,
    pagesRequested: pagesToFetch,
    failures,
    coverage,
    complete: failures.length === 0 && pages.length === pageCount && coverage >= 0.99
  };
}

async function fetchMarketUniverse() {
  const collectionStartedAt = new Date().toISOString();
  // Eastmoney's clist endpoint returns at most 100 rows per page; fetch all
  // required pages and rotate hosts to avoid concentrating requests on one host.
  const pageSize = 100;
  const first = await fetchMarketPageWithRetry(1, pageSize);
  const result = await collectMarketUniversePages({
    firstPage: first,
    fetchPage: page => fetchMarketPageWithRetry(page, pageSize),
    pageSize,
    maxPages: 80,
    concurrency: 2
  });
  return {
    ...result,
    collectionStartedAt,
    collectionFinishedAt: new Date().toISOString()
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
    if (!themeKeys.length || !/^\d{6}$/.test(code)) return null;
    const pct = num(row?.f3);
    return {
      code, name, themeKeys, pct,
      amount: num(row?.f6),
      turnoverPct: num(row?.f8),
      industry: String(row?.f100 ?? ''),
      eligibleForTrading: !/(?:\*?ST|退)/i.test(name),
      nearLimitUpProxy: pct !== null && pct >= limitPct(code, name) - 0.15
    };
  }).filter(Boolean);
  const stockRows = rows.map(row => {
    const code = String(row?.f12 ?? '');
    const name = String(row?.f14 ?? code);
    const timestamp = num(row?.f124);
    const timestampMs = timestamp === null ? null : timestamp > 1e12 ? timestamp : timestamp * 1000;
    return {
      code,name,
      price:num(row?.f2),pct:num(row?.f3),amount:num(row?.f6),turn:num(row?.f8),
      mcap:num(row?.f20),floatCap:num(row?.f21),pct60:num(row?.f24),ytd:num(row?.f25),
      mainNet:num(row?.f62),mainPct:num(row?.f184),industry:String(row?.f100 ?? '行业未知'),
      open:num(row?.f17),high:num(row?.f15),low:num(row?.f16),prevClose:num(row?.f18),
      quoteAt:timestampMs && Number.isFinite(timestampMs) ? new Date(timestampMs).toISOString() : null,
      specialTreatment:/(?:\*?ST|退)/i.test(name),
      mainBoard:/^(00|60)\d{4}$/.test(code)
    };
  }).filter(row => /^\d{6}$/.test(row.code));
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
    stockRows,
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
      collectionStartedAt: universe?.collectionStartedAt ?? null,
      collectionFinishedAt: universe?.collectionFinishedAt ?? null,
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


const PUSH2EX_HOST = 'https://push2ex.eastmoney.com';
const DATACENTER_HOST = 'https://datacenter-web.eastmoney.com';

async function fetchLimitPool(endpoint, tradeDate) {
  const pageSize = 200;
  const fetchPage = async pageIndex => {
    const params = new URLSearchParams({
      ut: '7eea3edcaed734bea9cbfc24409ed989',
      dpt: 'wz.ztzt',
      Pageindex: String(pageIndex),
      pagesize: String(pageSize),
      sort: 'fbt:asc',
      date: String(tradeDate).replace(/-/g, '')
    });
    const payload = await fetchJson(PUSH2EX_HOST + '/' + endpoint + '?' + params.toString(), 7000,
      {referer: 'https://quote.eastmoney.com/'});
    if (!Array.isArray(payload?.data?.pool)) throw new Error(endpoint + ': data.pool unavailable');
    return payload.data;
  };
  const first = await fetchPage(0);
  const rows = [...first.pool];
  const reportedTotal = num(first.total ?? first.tc ?? first.totalCount ?? first.count);
  const totalKnown = reportedTotal !== null && reportedTotal >= 0;
  const pageCount = totalKnown && reportedTotal > 0 ? Math.ceil(reportedTotal / pageSize) : 1;
  const maxPages = 10;
  const failures = [];
  const pagesToFetch = Math.min(pageCount,maxPages);
  for (let pageIndex=1; pageIndex<pagesToFetch; pageIndex++) {
    try {
      const page = await fetchPage(pageIndex);
      rows.push(...page.pool);
    } catch (error) {
      failures.push({pageIndex,error:String(error?.message??error)});
    }
  }
  const complete = failures.length===0 && pageCount<=maxPages
    && (totalKnown ? rows.length>=reportedTotal : rows.length<pageSize);
  return {
    status:complete?'AVAILABLE':'PARTIAL',
    rows,
    total:totalKnown?reportedTotal:null,
    pageCount,
    pagesFetched:pagesToFetch-failures.length,
    failures
  };
}

async function fetchDataCenterReport(reportName, tradeDate, {pageSize = 500, maxPages = 10} = {}) {
  const makeUrl = page => {
    const params = new URLSearchParams({
      reportName,
      columns: 'ALL',
      source: 'WEB',
      client: 'WEB',
      pageNumber: String(page),
      pageSize: String(pageSize),
      sortColumns: reportName === 'RPT_DAILYBILLBOARD_DETAILSNEW' ? 'BILLBOARD_NET_AMT' : 'TRADE_DATE',
      sortTypes: reportName === 'RPT_DAILYBILLBOARD_DETAILSNEW' ? '-1' : '-1',
      filter: "(TRADE_DATE='" + String(tradeDate) + "')"
    });
    return DATACENTER_HOST + '/api/data/v1/get?' + params.toString();
  };
  const first = await fetchJson(makeUrl(1), 8000, {referer: 'https://data.eastmoney.com/stock/tradedetail.html'});
  const firstResult = first?.result;
  if (!firstResult || !Array.isArray(firstResult.data)) throw new Error(reportName + ': result.data unavailable');
  const count = Number(firstResult.count);
  const reportedPages = Number(firstResult.pages);
  if (firstResult.data.length === 0 && count === 0) {
    return {status: 'AVAILABLE_EMPTY', rows: [], count: 0, pagesFetched: 1, pageCount: 0, failures: []};
  }
  if (firstResult.data.length === 0 && !Number.isFinite(count)) {
    throw new Error(reportName + ': empty response without reported count');
  }
  const pageCount = Number.isFinite(reportedPages) && reportedPages > 0
    ? reportedPages
    : Number.isFinite(count) && count > 0 ? Math.ceil(count / pageSize) : 1;
  const rows = [...firstResult.data];
  const failures = [];
  const pagesToFetch = Math.min(pageCount, maxPages);
  for (let page = 2; page <= pagesToFetch; page++) {
    try {
      const payload = await fetchJson(makeUrl(page), 8000, {referer: 'https://data.eastmoney.com/stock/tradedetail.html'});
      if (!Array.isArray(payload?.result?.data)) throw new Error('page result.data unavailable');
      rows.push(...payload.result.data);
    } catch (error) {
      failures.push({page, error: String(error?.message ?? error)});
    }
  }
  const allPagesFetched = pageCount <= maxPages && failures.length === 0;
  const coverage = Number.isFinite(count) && count > 0 ? rows.length / count : allPagesFetched ? 1 : 0;
  return {
    status: allPagesFetched && coverage >= 0.95 ? 'AVAILABLE' : 'PARTIAL',
    rows,
    count: Number.isFinite(count) ? count : rows.length,
    pagesFetched: pagesToFetch - failures.length,
    pageCount,
    coverage,
    failures
  };
}

async function fetchLimitPools(tradeDate) {
  if (!tradeDate) return {
    tradeDate: null, limitUpRows: null, brokenRows: null, limitDownRows: null,
    sourceStatus: {limitUp:'NOT_MEASURABLE',broken:'NOT_MEASURABLE',limitDown:'NOT_MEASURABLE'},
    diagnostics:{}
  };
  const specs = [
    ['limitUp','getTopicZTPool'],
    ['broken','getTopicZBPool'],
    ['limitDown','getTopicDTPool']
  ];
  const results = await mapLimit(specs, 3, ([, endpoint]) => fetchLimitPool(endpoint, tradeDate));
  const output = {tradeDate,sourceStatus:{},limitUpRows:null,brokenRows:null,limitDownRows:null,diagnostics:{}};
  results.forEach((result,index)=>{
    const [key] = specs[index];
    if (result?.error) {
      output.sourceStatus[key] = 'NOT_MEASURABLE';
      output.diagnostics[key] = {error:String(result.error)};
    } else {
      output.sourceStatus[key] = result.status;
      output[key === 'limitUp' ? 'limitUpRows' : key === 'broken' ? 'brokenRows' : 'limitDownRows'] = result.rows;
      output.diagnostics[key] = {
        total:result.total,pageCount:result.pageCount,pagesFetched:result.pagesFetched,
        failures:result.failures??[]
      };
    }
  });
  return output;
}

async function fetchLhbContext(tradeDate) {
  if (!tradeDate) return {tradeDate,dailyRows:[],seatRows:[],dailyStatus:'NOT_MEASURABLE',seatStatus:'NOT_MEASURABLE'};
  const [daily, seats] = await Promise.all([
    fetchDataCenterReport('RPT_DAILYBILLBOARD_DETAILSNEW',tradeDate)
      .catch(error=>({status:'NOT_MEASURABLE',rows:[],error:String(error?.message??error)})),
    fetchDataCenterReport('RPT_OPERATEDEPT_TRADE_DETAILS',tradeDate)
      .catch(error=>({status:'NOT_MEASURABLE',rows:[],error:String(error?.message??error)}))
  ]);
  return {
    tradeDate,
    dailyRows:daily.rows??[],
    seatRows:seats.rows??[],
    dailyStatus:daily.status??'NOT_MEASURABLE',
    seatStatus:seats.status??'NOT_MEASURABLE',
    dailyDiagnostics:{count:daily.count??null,pagesFetched:daily.pagesFetched??0,pageCount:daily.pageCount??0,coverage:daily.coverage??null,error:daily.error??null},
    seatDiagnostics:{count:seats.count??null,pagesFetched:seats.pagesFetched??0,pageCount:seats.pageCount??0,coverage:seats.coverage??null,error:seats.error??null}
  };
}

export async function collectV16MarketContext() {
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
  const lhbSessionFinalized = Boolean(aShareSessionDate) && (aShareSessionDate !== calendarDate || localClock.closeFinalized);
  const [poolRaw, lhbRaw] = await Promise.all([
    fetchLimitPools(aShareSessionDate),
    lhbSessionFinalized
      ? fetchLhbContext(aShareSessionDate)
      : Promise.resolve({tradeDate:aShareSessionDate,dailyRows:[],seatRows:[],dailyStatus:'PENDING_CLOSE',seatStatus:'PENDING_CLOSE'})
  ]);
  const limitPools = summarizeLimitPools({
    tradeDate:aShareSessionDate,
    limitUpRows:poolRaw.limitUpRows,
    brokenRows:poolRaw.brokenRows,
    limitDownRows:poolRaw.limitDownRows,
    sourceStatus:poolRaw.sourceStatus
  });
  limitPools.diagnostics = poolRaw.diagnostics ?? {};
  const lhb = summarizeLhbContext({
    tradeDate:aShareSessionDate,
    dailyRows:lhbRaw.dailyRows,
    seatRows:lhbRaw.seatRows,
    dailyStatus:lhbRaw.dailyStatus,
    seatStatus:lhbRaw.seatStatus,
    stockRows:universe.stockRows
  });
  lhb.diagnostics = {daily:lhbRaw.dailyDiagnostics??null,seats:lhbRaw.seatDiagnostics??null};
  const lhbSectorByName = new Map((lhb.sectors??[]).map(row=>[row.industry,row]));
  const sectors = universe.sectors.map(row=>{
    const evidence=lhbSectorByName.get(row.key);
    return {
      ...row,
      lhbNetBuyCny:evidence?.netBuyCny??null,
      lhbPositiveRatio:evidence?.stockCount?evidence.positiveCount/evidence.stockCount:null,
      lhbStockCount:evidence?.stockCount??0,
      lhbSourceStatus:lhb.status
    };
  });
  const sentiment = {
    ...universe.sentiment,
    limitUpCount:limitPools.limitUpCount??universe.sentiment.limitUpCount,
    limitDownCount:limitPools.limitDownCount??universe.sentiment.limitDownCount,
    brokenBoardRate:Number.isFinite(limitPools.brokenBoardRate)?limitPools.brokenBoardRate:'NOT_MEASURABLE',
    limitLabelQuality:limitPools.status==='AVAILABLE'?'EASTMONEY_POOL':'APPROXIMATE_PROXY',
    nextDayPremiumPct:'NOT_MEASURABLE',
    nextDayPositiveRatio:'NOT_MEASURABLE',
    lhbStatus:lhb.status,
    lhbPositiveStockRatio:lhb.positiveStockRatio,
    lhbInstitutionalPositiveStockRatio:lhb.institutionalPositiveStockRatio,
    lhbInstitutionStatus:lhb.institutionStatus
  };
  return {
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
      sentiment,
      sectors,
      stockRows: universe.stockRows,
      narrativeStocks: universe.narrativeStocks,
      narrativeSourceScope: universe.narrativeSourceScope,
      leaders: universe.leaders,
      marketAveragePct: universe.marketAveragePct,
      limitPools,
      lhb,
      lhbDiagnostics:{daily:lhbRaw.dailyDiagnostics??null,seats:lhbRaw.seatDiagnostics??null},
      source: universe.source,
      dataStatus: aShareSessionDate === calendarDate ? (localClock.closeFinalized ? 'FINALIZED_SESSION' : 'INTRADAY_PROVISIONAL') : 'LAST_AVAILABLE_SESSION',
      indexFailures
    },
    us,
    capabilities: {
      fullMarketBreadth: universe.breadth.fullMarket ? 'MEASURABLE' : 'PARTIAL',
      indexTrend: indices.length >= 3 ? 'MEASURABLE' : 'PARTIAL',
      exactLimitUpDown: limitPools.status==='AVAILABLE'?'MEASURABLE':limitPools.status,
      limitUpLadder:limitPools.sourceStatus.limitUp==='AVAILABLE'?'MEASURABLE':'NOT_MEASURABLE',
      brokenBoardRate:Number.isFinite(limitPools.brokenBoardRate)?'MEASURABLE':'NOT_MEASURABLE',
      limitUpDailyProxy:limitPools.sourceStatus.limitUp==='AVAILABLE'?'VENDOR_DAILY_PROXY_UNCALIBRATED':'NOT_MEASURABLE',
      intradaySealQuality:'NOT_MEASURABLE',
      orderBookCancellation:'NOT_MEASURABLE',
      nextSessionFollowThrough:'NOT_MEASURABLE',
      lhbDaily:lhb.dailyStatus,
      lhbSeatDetails:lhb.seatStatus,
      institutionalLhbFlow:lhb.institutionStatus,
      nextDayPremium: 'NOT_MEASURABLE',
      auction: 'NOT_MEASURABLE',
      first15Minutes: 'NOT_MEASURABLE',
      vwap: 'NOT_MEASURABLE',
      orderBookAndCancellation: 'NOT_MEASURABLE',
      policyEvents: 'NOT_MEASURABLE',
      nameThemeMembership: 'LEXICAL_MATCH_ONLY',
      industryThemeMembership: 'NOT_MEASURABLE',
      fundamentalOverlap: 'NOT_MEASURABLE'
    },
    limitations: [
      'Limit-up, broken-board and limit-down pools are vendor-provided Eastmoney event pools; they are not exchange-certified order-book records.',
      'LHB daily summaries and seat details are post-close Eastmoney DataCenter disclosures; missing or delayed reports remain NOT_MEASURABLE.',
      'LHB stock-level net amounts are deduplicated by security code; multiple abnormal-trading reasons are not summed.',
      'Institutional flow is only classified when a seat is explicitly labelled as an institution; ordinary brokerage seats are not guessed to be institutions or named hot-money traders.',
      'Next-day premium requires a prior-session limit-up cohort and at least 80% matched next-session close coverage; it is not inferred from same-day data.',
      'Industry breadth is a constituent-sample proxy, not verified concept/theme membership.',
      '羊／洋／阳, 狼 and 东方 name themes are lexical matches only; they do not establish industry or fundamental overlap.',
      'Full-market universe status requires all expected pages and at least 99% unique-code coverage.',
      'Yahoo Finance daily bars are filtered to dates strictly before the China calendar date to prevent same-date US data leakage.',
      'No daily close is substituted for auction, first-15-minute, VWAP, broken-board intraday sequence or order-book evidence.',
      'The daily limit-up quality proxy is not calibrated and does not alter selection weights; minute-level seal quality, Level-2 cancellation risk and next-session first-15-minute follow-through remain NOT_MEASURABLE until complete timestamped feeds are connected.',
      'Full stock rows are included for private point-in-time research archiving; the snapshot is multi-page and not atomic.'
    ]
  };
}
export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, {error:'METHOD_NOT_ALLOWED'}, 0);
  try {
    return send(res, 200, await collectV16MarketContext(), 60);
  } catch (error) {
    return send(res, 502, {
      schema: 'ashare-v16-market-context-error-v1',
      status: 'SOURCE_UNAVAILABLE',
      error: String(error?.message ?? error),
      capturedAt: new Date().toISOString()
    }, 0);
  }
}
