import { buildAutomaticPsychologyResearch } from '../research/v11-short-alpha/psychology_narrative.js';

export const config = { maxDuration: 60 };

const PUSH_HOSTS = [
  'https://push2delay.eastmoney.com',
  'https://push2.eastmoney.com',
  'https://7.push2.eastmoney.com',
  'https://43.push2.eastmoney.com',
  'https://89.push2.eastmoney.com'
];
const HIST_HOSTS = [
  'https://push2his.eastmoney.com',
  'https://7.push2his.eastmoney.com'
];
const NEWS_HOSTS = ['https://search-api-web.eastmoney.com'];
const UA = 'Mozilla/5.0 AShareQuant/V12-Psychology';
const UT = 'bd1d9ddb04089700cf9c27f6f7426281';

const n = value => {
  if (value === null || value === undefined || value === '' || value === '-') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

function parseMaybeJson(text) {
  const raw = String(text ?? '').trim();
  if (!raw) throw new Error('empty upstream response');
  try { return JSON.parse(raw); } catch {}
  const left = raw.indexOf('(');
  const right = raw.lastIndexOf(')');
  if (left >= 0 && right > left) return JSON.parse(raw.slice(left + 1, right));
  throw new Error('invalid upstream response');
}

async function fetchParsed(url, timeoutMs = 7000, referer = 'https://quote.eastmoney.com/') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      headers: {
        accept: 'application/json,text/javascript,*/*;q=0.8',
        'user-agent': UA,
        referer
      }
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return parseMaybeJson(await response.text());
  } finally {
    clearTimeout(timer);
  }
}

function decodeResponseText(buffer, contentType = '') {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const declared = String(contentType).match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1]?.toLowerCase();
  const encodings = [...new Set([declared, 'utf-8', 'gbk'].filter(Boolean))];
  let bestText = '';
  let bestReplacementCount = Infinity;
  for (const encoding of encodings) {
    try {
      const decoded = new TextDecoder(encoding).decode(bytes);
      const replacementCount = (decoded.match(/\uFFFD/g) ?? []).length;
      if (replacementCount < bestReplacementCount) {
        bestText = decoded;
        bestReplacementCount = replacementCount;
      }
      if (replacementCount === 0) return decoded;
    } catch {}
  }
  if (bestText) return bestText;
  return new TextDecoder().decode(bytes);
}

async function fetchText(url, timeoutMs = 7000, referer = 'https://basic.10jqka.com.cn/') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal:controller.signal,
      cache:'no-store',
      headers:{
        accept:'text/html,application/xhtml+xml,*/*;q=0.8',
        'user-agent':UA,
        referer
      }
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return decodeResponseText(await response.arrayBuffer(), response.headers.get('content-type') ?? '');
  } finally {
    clearTimeout(timer);
  }
}

function normalizeThemeName(value) {
  return String(value ?? '').trim().toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .replace(/概念$/u, '');
}

function decodeHtmlText(value) {
  return String(value ?? '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;|&#xA0;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

function parseThsStockConcepts(html) {
  const output = [];
  const seen = new Set();
  for (const match of String(html ?? '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(cell => decodeHtmlText(cell[1]));
    if (cells.length < 2 || !/^\d{1,3}$/.test(cells[0])) continue;
    const name = cells[1].replace(/^(?:概念名称|名称)$/u, '').trim();
    if (!name || name.length > 60 || /概念解析|龙头股|序号/u.test(name)) continue;
    const key = normalizeThemeName(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push({name, normalizedName:key, source:'10jqka'});
  }
  return output;
}

function parseSinaConceptNodes(tree) {
  const output = new Map();
  const walk = value => {
    if (!Array.isArray(value)) return;
    if (value.length >= 3 && typeof value[0] === 'string' &&
        typeof value[2] === 'string' && /^(?:gn_|chgn_)/.test(value[2])) {
      const name = String(value[0]).trim();
      const normalizedName = normalizeThemeName(name);
      if (normalizedName && !output.has(normalizedName)) {
        output.set(normalizedName, {name, code:value[2], normalizedName, source:'sina'});
      }
    }
    for (const child of value) walk(child);
  };
  walk(tree);
  return output;
}

function parseSinaNodeMembers(rows) {
  const values = Array.isArray(rows) ? rows : [];
  return values.map(row => {
    const code = String(row?.code ?? row?.symbol ?? '').match(/\d{6}/)?.[0] ?? '';
    return {
      code,
      name:String(row?.name ?? ''),
      pct:n(row?.changepercent),
      amountCny:n(row?.amount),
      price:n(row?.trade),
      quoteTime:String(row?.ticktime ?? '')
    };
  }).filter(row => /^(0|6)\d{5}$/.test(row.code) && row.pct !== null);
}

async function fetchThsStockConcepts(code) {
  const html = await fetchText('https://basic.10jqka.com.cn/' + code + '/concept.html', 3500);
  const concepts = parseThsStockConcepts(html);
  if (!concepts.length) throw new Error('10jqka concept page yielded no parseable concept rows');
  return concepts;
}

async function fetchSinaConceptNodes() {
  const tree = await fetchParsed(
    'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodes',
    3500,
    'https://vip.stock.finance.sina.com.cn/'
  );
  const nodes = parseSinaConceptNodes(tree);
  if (!nodes.size) throw new Error('Sina concept node tree yielded no gn_/chgn_ nodes');
  return nodes;
}

async function fetchSinaNodeMembers(nodeCode, maxPages = 2) {
  const pages = await mapLimit(
    Array.from({length:maxPages}, (_, index) => index + 1),
    2,
    async page => {
      const url = new URL('https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData');
      url.search = new URLSearchParams({
        node:nodeCode, sort:'symbol', asc:'1',
        page:String(page), num:'80', _s_r_a:'page'
      }).toString();
      const rows = await fetchParsed(url.toString(), 3500, 'https://vip.stock.finance.sina.com.cn/');
      return parseSinaNodeMembers(rows);
    }
  );
  const deduped = new Map();
  for (const row of pages.flat()) if (!deduped.has(row.code)) deduped.set(row.code, row);
  return [...deduped.values()];
}

async function fetchSinaThsConceptFallback(codes, maxThemes = 24, concurrency = 4) {
  const membershipConcurrency = Math.max(6, Math.min(8, concurrency));
  const boardConcurrency = Math.max(4, Math.min(6, concurrency));
  const [nodesResult, membershipsResult] = await Promise.allSettled([
    fetchSinaConceptNodes(),
    mapLimit(codes, membershipConcurrency, async code => {
      await sleep(100);
      try {
        return {code, concepts:await fetchThsStockConcepts(code)};
      } catch (error) {
        return {code, concepts:[], error:error?.message ?? String(error)};
      }
    })
  ]);
  if (nodesResult.status !== 'fulfilled') {
    throw new Error('Sina concept node source failed: ' + String(nodesResult.reason?.message ?? nodesResult.reason));
  }
  if (membershipsResult.status !== 'fulfilled') {
    throw new Error('10jqka stock-concept source failed: ' + String(membershipsResult.reason?.message ?? membershipsResult.reason));
  }
  const nodes = nodesResult.value;
  const rawMemberships = membershipsResult.value;
  const counts = new Map();
  const mappedByCode = new Map();
  let membershipFailures = 0;
  let unmappedConcepts = 0;
  for (const item of rawMemberships) {
    if (item.error) membershipFailures += 1;
    const matched = [];
    for (const concept of item.concepts) {
      const node = nodes.get(concept.normalizedName);
      if (!node) { unmappedConcepts += 1; continue; }
      matched.push({code:'SINA:' + node.code, name:node.name});
      counts.set(node.code, (counts.get(node.code) ?? 0) + 1);
    }
    mappedByCode.set(item.code, matched);
  }
  const rankedNodeCodes = [...counts.entries()]
    .sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.min(maxThemes, 8))
    .map(([code]) => code);
  const themeRows = await mapLimit(rankedNodeCodes, boardConcurrency, async nodeCode => {
    await sleep(100);
    try {
      const members = await fetchSinaNodeMembers(nodeCode, 2);
      if (!members.length) return null;
      const returns = members.map(row => row.pct).filter(Number.isFinite);
      const upCount = returns.filter(value => value > 0).length;
      const downCount = returns.filter(value => value < 0).length;
      const flatCount = returns.filter(value => value === 0).length;
      const averageChange = returns.length
        ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null;
      const amountCny = members.reduce((sum, row) => sum + (row.amountCny ?? 0), 0);
      const leader = [...members].sort((a,b) => (b.pct ?? -Infinity) - (a.pct ?? -Infinity))[0];
      const node = [...nodes.values()].find(item => item.code === nodeCode);
      return {
        code:'SINA:' + nodeCode,
        name:node?.name ?? nodeCode,
        changePct:averageChange === null ? null : Number(averageChange.toFixed(4)),
        amountCny,
        mainNetCny:null,
        mainNetPct:null,
        upCount, downCount, flatCount,
        memberCount:members.length,
        leaderCode:leader?.code ?? '',
        leaderName:leader?.name ?? '',
        leaderChangePct:leader?.pct ?? null,
        quoteTimestamp:null,
        provider:'sina+10jqka',
        changePctMethod:'sample-member-average',
        memberCoverage:'first-two-pages-up-to-160',
        sinaMembers:members.map(row => ({code:row.code,name:row.name,pct:row.pct,amountCny:row.amountCny,turnoverPct:null,mainNetCny:null}))
      };
    } catch {
      return null;
    }
  });
  const concepts = themeRows.filter(Boolean);
  if (!concepts.length) throw new Error('Sina/10jqka fallback could not validate any matched concept member lists');
  const conceptMap = new Map(concepts.map(theme => [theme.code, theme]));
  const memberships = rawMemberships.map(item => ({
    code:item.code,
    concepts:(mappedByCode.get(item.code) ?? []).filter(concept => conceptMap.has(concept.code))
  }));
  return {
    concepts,
    memberships,
    diagnostics:{
      conceptSource:'sina-node-aggregate',
      membershipSource:'10jqka-stock-concepts-mapped-to-sina',
      membershipFailures,
      unmappedConcepts,
      requestedMemberships:codes.length,
      mappedMemberships:memberships.filter(item => item.concepts.length > 0).length,
      boardMemberCoverage:'first-two-pages-up-to-160',
      boardChangeMethod:'sample-member-average'
    }
  };
}

async function fetchFromHosts(hosts, path, params, timeoutMs = 7000) {
  let lastError = null;
  for (const host of hosts) {
    try {
      const url = new URL(path, host);
      url.search = new URLSearchParams(params).toString();
      return await fetchParsed(url.toString(), timeoutMs);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error('all upstream hosts failed: ' + (lastError?.message ?? 'unknown'));
}

function parseCodes(value, max = 30) {
  return [...new Set(String(value ?? '').split(',').map(item => item.trim())
    .filter(code => /^(0|6)\d{5}$/.test(code)))].slice(0, max);
}

function secid(code) {
  return /^(6)/.test(code) ? '1.' + code : '0.' + code;
}

function summarizeSourceCoverage(diagnostics = {}) {
  const requested = Number(diagnostics.requestedCodes) || 0;
  const concepts = Number(diagnostics.conceptRows) || 0;
  const quotes = Number(diagnostics.quoteRows) || 0;
  const themes = Number(diagnostics.themeCount) || 0;
  const researchThemes = Number(diagnostics.researchThemes) || 0;
  const membershipFailures = Number(diagnostics.membershipFailures) || 0;
  const flowFailures = Number(diagnostics.flowFailures) || 0;
  const researchFailures = Number(diagnostics.researchFailures) || 0;
  const failures = Array.isArray(diagnostics.sourceFailures) ? diagnostics.sourceFailures : [];
  const warnings = [...failures];
  if (requested > 0 && concepts === 0) warnings.push('concept-ranking-empty');
  if (requested > 0 && quotes === 0) warnings.push('candidate-quotes-empty');
  else if (requested > 0 && quotes < requested) warnings.push('candidate-quotes-partial:' + quotes + '/' + requested);
  if (requested > 0 && themes === 0) warnings.push('theme-evidence-empty');
  if (requested > 0 && membershipFailures >= requested) warnings.push('all-stock-theme-membership-requests-failed');
  else if (requested > 0 && membershipFailures > 0) warnings.push('stock-theme-membership-partial-failures:' + membershipFailures + '/' + requested);
  if (researchThemes > 0 && flowFailures >= researchThemes) warnings.push('all-theme-flow-requests-failed');
  if (researchThemes > 0 && researchFailures >= researchThemes * 2) warnings.push('all-theme-member-and-news-research-failed');
  const degraded = warnings.length > 0;
  return {
    status: degraded ? 'DEGRADED_SOURCE_COVERAGE' : 'SOURCE_COVERAGE_AVAILABLE',
    degraded,
    warnings: [...new Set(warnings)]
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function mapLimit(items, limit, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({length:Math.min(limit, Math.max(1, items.length))}, run));
  return output;
}

function conceptRankingUrl() {
  return {
    path:'/api/qt/clist/get',
    params:{
      pn:'1', pz:'100', po:'1', np:'1', fid:'f3',
      fs:'m:90+t:3+f:!50',
      fltt:'2', invt:'2', ut:UT,
      fields:'f2,f3,f6,f8,f12,f14,f62,f100,f104,f105,f106,f124,f128,f134,f136,f140,f184'
    }
  };
}

function normalizeConceptRow(row) {
  return {
    code:String(row?.f12 ?? ''),
    name:String(row?.f14 ?? ''),
    changePct:n(row?.f3),
    amountCny:n(row?.f6),
    mainNetCny:n(row?.f62),
    mainNetPct:n(row?.f184),
    upCount:n(row?.f104),
    downCount:n(row?.f105),
    flatCount:n(row?.f106),
    memberCount:n(row?.f134),
    leaderName:String(row?.f128 ?? ''),
    leaderCode:String(row?.f140 ?? ''),
    leaderChangePct:n(row?.f136),
    quoteTimestamp:n(row?.f124)
  };
}

function isConceptBoardRow(row = {}) {
  return String(row.code ?? '').startsWith('BK') && row.changePct !== null;
}

async function fetchConceptRanking(maxPages = 6) {
  const firstSpec = conceptRankingUrl();
  const conceptHosts = PUSH_HOSTS;
  const first = await fetchFromHosts(conceptHosts, firstSpec.path, firstSpec.params, 2500);
  const total = n(first?.data?.total) ?? 0;
  const pageCount = Math.max(1, Math.min(maxPages, Math.ceil(total / 100)));
  const pages = [first];
  if (pageCount > 1) {
    const rest = await mapLimit(
      Array.from({length:pageCount - 1}, (_, index) => index + 2),
      3,
      async page => {
        await sleep(120);
        return fetchFromHosts(conceptHosts, firstSpec.path,
          {...firstSpec.params, pn:String(page)}, 2500);
      }
    );
    pages.push(...rest);
  }
  return pages.flatMap(json => {
    const diff = json?.data?.diff;
    const rows = Array.isArray(diff) ? diff :
      diff && typeof diff === 'object' ? Object.values(diff) : [];
    return rows.map(normalizeConceptRow).filter(isConceptBoardRow);
  });
}

const conceptRankingCaptureCache = new Map();

async function fetchConceptRankingForCapture(maxPages = 6, captureKey = '') {
  const key = String(captureKey ?? '').trim();
  if (!key) return {rows:await fetchConceptRanking(maxPages),cacheHit:false,cacheAgeMs:0};

  const now = Date.now();
  for (const [cacheKey, entry] of conceptRankingCaptureCache) {
    if (entry.expiresAt <= now) conceptRankingCaptureCache.delete(cacheKey);
  }
  let entry = conceptRankingCaptureCache.get(key);
  if (entry && entry.maxPages >= maxPages && entry.expiresAt > now) {
    const cacheAgeMs = Math.max(0, now - entry.createdAt);
    if (entry.promise) {
      try {
        return {rows:await entry.promise,cacheHit:true,cacheAgeMs};
      } catch (error) {
        const cachedError = new Error(String(error?.message ?? error));
        cachedError.cacheHit = true;
        cachedError.cacheAgeMs = cacheAgeMs;
        throw cachedError;
      }
    }
    if (entry.error) {
      const cachedError = new Error(String(entry.error?.message ?? entry.error));
      cachedError.cacheHit = true;
      cachedError.cacheAgeMs = cacheAgeMs;
      throw cachedError;
    }
    if (Array.isArray(entry.rows)) return {rows:entry.rows,cacheHit:true,cacheAgeMs};
  }

  entry = {
    maxPages,
    createdAt:now,
    expiresAt:now + 5 * 60 * 1000,
    rows:null,
    error:null,
    promise:null
  };
  const promise = fetchConceptRanking(maxPages).then(rows => {
    entry.rows = rows;
    entry.expiresAt = Date.now() + (rows.length ? 5 * 60 * 1000 : 60 * 1000);
    return rows;
  }).catch(error => {
    entry.error = error;
    entry.expiresAt = Date.now() + 5 * 60 * 1000;
    throw error;
  }).finally(() => {
    entry.promise = null;
  });
  entry.promise = promise;
  conceptRankingCaptureCache.set(key, entry);
  while (conceptRankingCaptureCache.size > 20) {
    conceptRankingCaptureCache.delete(conceptRankingCaptureCache.keys().next().value);
  }
  return {rows:await promise,cacheHit:false,cacheAgeMs:0};
}

async function fetchStockConcepts(code) {
  const json = await fetchFromHosts(PUSH_HOSTS.slice(0, 3), '/api/qt/slist/get', {
    secid:secid(code), spt:'3', pi:'0', pz:'200', po:'1',
    fields:'f12,f14,f3,f128,f140,f141', ut:UT
  }, 2500);
  const diff = json?.data?.diff;
  const rows = Array.isArray(diff) ? diff : diff && typeof diff === 'object' ? Object.values(diff) : [];
  return rows.map(row => ({
    code:String(row?.f12 ?? ''),
    name:String(row?.f14 ?? '')
  })).filter(row => String(row.code).startsWith('BK'));
}

async function fetchThemeFlow(boardCode) {
  const json = await fetchFromHosts(HIST_HOSTS, '/api/qt/stock/fflow/daykline/get', {
    secid:'90.' + boardCode, klt:'101', lmt:'20',
    fields1:'f1,f2,f3,f7',
    fields2:'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63'
  }, 8000);
  const rows = Array.isArray(json?.data?.klines) ? json.data.klines : [];
  return rows.map(line => {
    const a = String(line).split(',');
    return {
      date:a[0] ?? null,
      mainNetCny:n(a[1]),
      mainNetPct:n(a[6]),
      price:n(a[11]),
      changePct:n(a[12])
    };
  }).filter(row => row.date && row.mainNetCny !== null && row.changePct !== null);
}

function normalizeThemeMemberRow(row) {
  return {
    code:String(row?.f12 ?? ''),
    name:String(row?.f14 ?? ''),
    pct:n(row?.f3),
    amountCny:n(row?.f6),
    turnoverPct:n(row?.f8),
    mainNetCny:n(row?.f62)
  };
}

function isThemeMemberRow(row = {}) {
  return /^\d{6}$/.test(String(row.code ?? '')) && row.pct !== null;
}

async function fetchThemeMembers(boardCode) {
  const json = await fetchFromHosts(PUSH_HOSTS, '/api/qt/clist/get', {
    pn:'1', pz:'100', po:'1', np:'1', fid:'f3',
    fs:'b:' + boardCode + '+f:!50',
    fltt:'2', invt:'2', ut:UT,
    fields:'f2,f3,f6,f8,f12,f14,f20,f62,f124'
  }, 7000);
  const diff = json?.data?.diff;
  const rows = Array.isArray(diff) ? diff :
    diff && typeof diff === 'object' ? Object.values(diff) : [];
  return rows.map(normalizeThemeMemberRow).filter(isThemeMemberRow);
}

async function fetchThemeNews(themeName) {
  const param = JSON.stringify({
    uid:'',
    keyword:String(themeName ?? '').trim(),
    type:['cmsArticleWebOld'],
    client:'web',
    clientType:'web',
    clientVersion:'curr',
    param:{
      cmsArticleWebOld:{
        searchScope:'default',
        sort:'default',
        pageIndex:1,
        pageSize:30,
        preTag:'',
        postTag:''
      }
    }
  });
  const json = await fetchFromHosts(NEWS_HOSTS, '/search/jsonp', {
    cb:'v12Psychology',
    param
  }, 7000);
  const articles = Array.isArray(json?.result?.cmsArticleWebOld)
    ? json.result.cmsArticleWebOld : [];
  return articles.map(item => ({
    date:String(item?.date ?? ''),
    title:String(item?.title ?? ''),
    content:String(item?.content ?? ''),
    mediaName:String(item?.mediaName ?? ''),
    url:String(item?.url ?? '')
  })).filter(item => item.title);
}

async function fetchCandidateQuotes(codes) {
  if (!codes.length) return new Map();
  const json = await fetchFromHosts(PUSH_HOSTS.slice(0, 3), '/api/qt/ulist.np/get', {
    secids:codes.map(secid).join(','),
    fields:'f12,f14,f3,f124',
    fltt:'2', invt:'2', ut:UT
  }, 2500);
  const diff = json?.data?.diff;
  const rows = Array.isArray(diff) ? diff : diff && typeof diff === 'object' ? Object.values(diff) : [];
  return new Map(rows.map(row => [String(row?.f12 ?? ''), {
    name:String(row?.f14 ?? ''), pct:n(row?.f3), quoteTimestamp:n(row?.f124), source:'eastmoney'
  }]));
}

function parseTencentCandidateQuotes(raw, requestedCodes = []) {
  const requested = new Set(requestedCodes);
  const output = new Map();
  for (const match of String(raw ?? '').matchAll(/v_(?:sh|sz)(\d{6})="([^"]*)"/g)) {
    const code = match[1];
    if (!requested.has(code)) continue;
    const fields = match[2].split('~');
    const current = n(fields[3]);
    const previousClose = n(fields[4]);
    if (current === null || previousClose === null || previousClose <= 0) continue;
    const date = fields.find(value => /^\d{4}\/\d{2}\/\d{2}$/.test(value));
    const timeIndex = date ? fields.indexOf(date) + 1 : -1;
    const time = timeIndex >= 0 && /^\d{2}:\d{2}:\d{2}$/.test(fields[timeIndex])
      ? fields[timeIndex] : null;
    const parsedTimestamp = date && time ? Date.parse(date.replaceAll('/', '-') + 'T' + time + '+08:00') : NaN;
    output.set(code, {
      name:String(fields[1] ?? ''),
      pct:Number(((current / previousClose - 1) * 100).toFixed(4)),
      quoteTimestamp:Number.isFinite(parsedTimestamp) ? Math.floor(parsedTimestamp / 1000) : null,
      source:'tencent'
    });
  }
  return output;
}

async function fetchTencentCandidateQuotes(codes, timeoutMs = 7000) {
  if (!codes.length) return new Map();
  const symbols = codes.map(code => (/^(6)/.test(code) ? 'sh' : 'sz') + code).join(',');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch('https://qt.gtimg.cn/q=' + symbols, {
      signal:controller.signal,
      cache:'no-store',
      headers:{
        accept:'text/plain,*/*;q=0.8',
        'user-agent':UA,
        referer:'https://gu.qq.com/'
      }
    });
    if (!response.ok) throw new Error('Tencent quote HTTP ' + response.status);
    const result = parseTencentCandidateQuotes(await response.text(), codes);
    if (!result.size) throw new Error('Tencent quote returned no valid requested symbols');
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function cumulativeReturn(rows) {
  if (rows.length < 5 || rows.slice(-5).some(row => row.changePct === null)) return null;
  return (rows.slice(-5).reduce((factor, row) =>
    factor * (1 + row.changePct / 100), 1) - 1) * 100;
}

function priorCumulativeReturn(rows) {
  if (rows.length < 10 || rows.slice(-10, -5).some(row => row.changePct === null)) return null;
  return (rows.slice(-10, -5).reduce((factor, row) =>
    factor * (1 + row.changePct / 100), 1) - 1) * 100;
}

function averageMainPct(rows, start, end) {
  const slice = rows.slice(start, end).map(row => row.mainNetPct)
    .filter(value => value !== null);
  return slice.length >= Math.min(4, Math.max(1, end - start))
    ? slice.reduce((sum, value) => sum + value, 0) / slice.length : null;
}

function sourceAsOf(rows, fallback) {
  const dates = rows.map(row => row.date).filter(Boolean).sort();
  return dates.at(-1) ?? fallback;
}

function validCaptureAsOf(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

const NON_NARRATIVE_THEME_PATTERNS = [
  /历史新高/, /昨日打二板/, /昨日涨停/, /昨日连板/, /昨日首板/,
  /融资融券/, /HS300/i, /上证50/, /上证180/, /央视50/,
  /沪股通/, /深股通/, /科创板做市商/, /MSCI/i, /富时罗素/,
  /百元股/, /高价股/, /低价股/, /低市盈率/, /高市盈率/,
  /低市净率/, /破净/, /高股息/, /红利股/, /机构重仓/,
  /基金重仓/, /QFII重仓/, /社保重仓/, /养老金/, /超跌/,
  /ST板块/, /风险警示/, /次新股/,
  /东方财富热股/, /题材股/, /人气股/, /热门板块/, /热门概念/,
  /市场热点/, /股性活跃/, /高活跃/, /龙虎榜/, /高换手/,
  /主力资金/, /资金流入/, /涨幅排名/, /跌幅排名/
];

function isNarrativeTheme(row = {}) {
  const name = String(row.name ?? '');
  const code = String(row.code ?? '');
  return (code.startsWith('BK') || code.startsWith('SINA:')) &&
    !NON_NARRATIVE_THEME_PATTERNS.some(pattern => pattern.test(name));
}

function themeStrength(row) {
  const flow = row.mainNetPct === null ? 50 : Math.max(0, Math.min(100, 50 + row.mainNetPct * 8));
  const breadthTotal = (row.upCount ?? 0) + (row.downCount ?? 0) + (row.flatCount ?? 0);
  const breadth = breadthTotal > 0 ? row.upCount / breadthTotal * 100 : 50;
  const change = row.changePct === null ? 50 : Math.max(0, Math.min(100, 50 + row.changePct * 5));
  return flow * 0.45 + breadth * 0.30 + change * 0.25;
}

function enrichTheme(base, flowRows, memberRows, newsRows, candidatePct, candidateCode, candidateName, asOf) {
  const snapshotDate = Number.isFinite(base.quoteTimestamp) &&
    base.quoteTimestamp >= 1e9 && base.quoteTimestamp <= 2.2e9
    ? new Date(base.quoteTimestamp * 1000).toISOString().slice(0,10) : asOf;
  const rows = [...flowRows].filter(row => !snapshotDate || row.date <= snapshotDate)
    .sort((a,b) => a.date.localeCompare(b.date));
  const members = [...memberRows].sort((a,b) =>
    (b.pct ?? -Infinity) - (a.pct ?? -Infinity) || a.code.localeCompare(b.code));
  const memberCount = base.memberCount ??
    ((base.upCount ?? 0) + (base.downCount ?? 0) + (base.flatCount ?? 0));
  const resolvedCandidateCode = String(candidateCode ?? '').trim();
  const sampledFallback = base.provider === 'sina+10jqka';
  const candidateRankIndex = !sampledFallback && resolvedCandidateCode
    ? members.findIndex(row => row.code === candidateCode) : -1;
  const memberLeader = sampledFallback ? null : members[0] ?? null;
  const leaderCode = sampledFallback ? null : base.leaderCode || memberLeader?.code || null;
  const leaderName = sampledFallback ? null : base.leaderName || memberLeader?.name || null;
  const leaderChangePct = sampledFallback ? null : base.leaderChangePct ?? memberLeader?.pct ?? null;
  const hasMemberRankEvidence = !sampledFallback && members.length > 0;
  const leaderStatus = sampledFallback ? null :
    resolvedCandidateCode && resolvedCandidateCode === leaderCode ? 'leader' :
    candidateRankIndex >= 0 && candidateRankIndex < 3 ? 'core' :
    candidateRankIndex >= 0 && candidateRankIndex < 5 ? 'front' :
    hasMemberRankEvidence ? 'follower' : null;
  const candidatePremiumPct = !sampledFallback && candidatePct !== null && base.changePct !== null
    ? candidatePct - base.changePct : null;
  const research = buildAutomaticPsychologyResearch({
    ...base,
    asOf,
    candidateCode:resolvedCandidateCode,
    candidateName,
    leaderCode,
    leaderName,
    leaderChangePct,
    candidatePremiumPct
  }, newsRows, members);
  const upCount = base.upCount ?? members.filter(row => row.pct > 0).length;
  const downCount = base.downCount ?? members.filter(row => row.pct < 0).length;
  const strongCount = members.filter(row => row.pct >= 5).length;
  const limitUpCount = members.filter(row => row.pct >= 9.5).length;
  return {
    code:base.code,
    name:base.name,
    asOf,
    changePct:base.changePct,
    mainNetCny:base.mainNetCny,
    mainNetPct:base.mainNetPct,
    upCount,
    downCount,
    flatCount:base.flatCount,
    memberCount,
    strongCount,
    limitUpCount,
    candidateCode,
    candidateName,
    candidateRank:candidateRankIndex >= 0 ? candidateRankIndex + 1 : null,
    leaderCode,
    leaderName,
    leaderChangePct,
    leaderStatus,
    candidatePremiumPct,
    leaderPremiumPct:leaderChangePct !== null && base.changePct !== null
      ? leaderChangePct - base.changePct : null,
    change5dPct:cumulativeReturn(rows),
    prior5dPct:priorCumulativeReturn(rows),
    recentMainNetPct:averageMainPct(rows, -5, rows.length),
    priorMainNetPct:averageMainPct(rows, -10, -5),
    narrativeScore:research.researchQuality.narrative.complete
      ? research.narrativeResearch.novelty * 0.25 +
        research.narrativeResearch.credibility * 0.25 +
        research.narrativeResearch.propagation * 0.20 +
        research.narrativeResearch.persistence * 0.15 +
        research.narrativeResearch.expectationGap * 0.15 : null,
    narrativeEvidence:research.narrativeResearch.evidence ?? [],
    imaginationScore:research.imaginationResearch.score ?? null,
    imaginationConfidence:research.imaginationResearch.confidence ?? 0,
    imaginationEvidence:research.imaginationResearch.evidence ?? [],
    researchQuality:research.researchQuality,
    researchVersion:research.version,
    researchDiagnostics:{
      newsCount:research.news.length,
      narrative:research.researchQuality.narrative,
      imagination:research.researchQuality.imagination
    },
    source:{
      provider:base.provider ?? 'eastmoney',
      conceptRanking:true,
      changePctMethod:base.changePctMethod ?? 'provider-board-quote',
      memberCoverage:base.memberCoverage ?? 'provider-member-list',
      leaderEvidenceQuality:sampledFallback ? 'sample-only-not-qualified'
        : members.length > 0 || base.leaderCode ? 'provider-board-members' : 'unavailable',
      membership:memberRows.length > 0,
      themeMembers:memberRows.length > 0,
      news:true,
      flowHistory:rows.length > 0,
      researchRequired:research.researchQuality.narrative.complete &&
        research.imaginationResearch.score !== null ? [] :
        ['narrativeScore','imaginationScore']
    },
    flowHistory:rows.slice(-10),
    news:research.news.slice(0, 10)
  };
}

export const _internal = {
  normalizeConceptRow,
  isConceptBoardRow,
  normalizeThemeMemberRow,
  isThemeMemberRow,
  isNarrativeTheme,
  themeStrength,
  summarizeSourceCoverage,
  parseTencentCandidateQuotes,
  normalizeThemeName,
  parseThsStockConcepts,
  parseSinaConceptNodes,
  parseSinaNodeMembers,
  decodeResponseText,
  fetchConceptRanking,
  fetchConceptRankingForCapture,
  fetchCandidateQuotes,
  fetchTencentCandidateQuotes,
  fetchStockConcepts,
  fetchThemeFlow,
  fetchThemeMembers,
  fetchThemeNews,
  fetchThsStockConcepts,
  fetchSinaConceptNodes,
  fetchSinaNodeMembers,
  fetchSinaThsConceptFallback,
  enrichTheme
};

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const codes = parseCodes(url.searchParams.get('codes'), 30);
  const requestedAsOf = validCaptureAsOf(url.searchParams.get('asOf'));
  const captureAsOf = requestedAsOf ?? new Date().toISOString();
  if (!codes.length) {
    res.statusCode = 400;
    res.setHeader('content-type','application/json; charset=utf-8');
    res.end(JSON.stringify({error:'codes must contain up to 30 main-board stock codes'}));
    return;
  }

  const diagnostics = {
    requestedCodes:codes.length,
    conceptRows:0,
    membershipFailures:0,
    flowFailures:0,
    themeCount:0,
    researchThemes:0,
    researchFailures:0,
    themeMemberFailures:0,
    themeNewsFailures:0,
    themeRequestFailureSamples:[],
    sourceFailures:[],
    sourceDegraded:false,
    sourceWarnings:[],
    quoteRows:0,
    quoteSource:null,
    conceptSource:null,
    membershipSource:null,
    conceptRankingCacheHit:false,
    conceptRankingCacheAgeMs:0,
    selectedThemesPerStock:2,
    maxResearchThemes:24,
    asOfMode:requestedAsOf ? 'caller-supplied' : 'server-capture',
    asOf:captureAsOf
  };

  try {
    const liveMode = url.searchParams.get('mode') === 'live';
    const selectedThemesPerStock = liveMode ? 1 : 2;
    const maxResearchThemes = liveMode ? 6 : 24;
    const membershipConcurrency = 6;
    const researchConcurrency = liveMode ? 3 : 4;

    diagnostics.selectedThemesPerStock = selectedThemesPerStock;
    diagnostics.maxResearchThemes = maxResearchThemes;
    const [conceptResult, quoteResult] = await Promise.allSettled([
      fetchConceptRankingForCapture(liveMode ? 3 : 6, captureAsOf),
      fetchCandidateQuotes(codes)
    ]);
    let conceptRows = conceptResult.status === 'fulfilled' ? conceptResult.value.rows : [];
    diagnostics.conceptRankingCacheHit = conceptResult.status === 'fulfilled'
      ? conceptResult.value.cacheHit === true : conceptResult.reason?.cacheHit === true;
    diagnostics.conceptRankingCacheAgeMs = conceptResult.status === 'fulfilled'
      ? Number(conceptResult.value.cacheAgeMs) || 0 : Number(conceptResult.reason?.cacheAgeMs) || 0;
    let memberships = null;
    let quotes = quoteResult.status === 'fulfilled' ? quoteResult.value : new Map();
    if (conceptResult.status === 'fulfilled' && conceptRows.length > 0) {
      diagnostics.conceptSource = 'eastmoney';
    } else {
      const primaryReason = conceptResult.status === 'rejected'
        ? String(conceptResult.reason?.message ?? conceptResult.reason)
        : 'empty concept ranking response';
      diagnostics.sourceFailures.push('concept-ranking-eastmoney: ' + primaryReason);
      try {
        const fallback = await fetchSinaThsConceptFallback(codes, maxResearchThemes, membershipConcurrency);
        conceptRows = fallback.concepts;
        memberships = fallback.memberships;
        diagnostics.conceptSource = fallback.diagnostics.conceptSource;
        diagnostics.membershipSource = fallback.diagnostics.membershipSource;
        diagnostics.membershipFailures += fallback.diagnostics.membershipFailures;
        diagnostics.sourceWarnings.push('concept-ranking-fell-back-to-sina-and-10jqka');
        diagnostics.sourceWarnings.push('sina-board-members-sampled-first-two-pages-up-to-160');
        diagnostics.sourceWarnings.push('sina-theme-change-is-sample-member-average-not-official-board-index');
        if (fallback.diagnostics.unmappedConcepts > 0) {
          diagnostics.sourceWarnings.push('sina-ths-unmapped-concepts:' + fallback.diagnostics.unmappedConcepts);
        }
        if (fallback.diagnostics.mappedMemberships < codes.length) {
          diagnostics.sourceWarnings.push('fallback-membership-partial:' + fallback.diagnostics.mappedMemberships + '/' + codes.length);
        }
      } catch (fallbackError) {
        diagnostics.sourceFailures.push('concept-ranking-fallback-sina-ths: ' + String(fallbackError?.message ?? fallbackError));
        diagnostics.conceptSource = 'unavailable';
        diagnostics.membershipSource = 'unavailable';
      }
    }
    if (diagnostics.conceptSource === 'eastmoney') diagnostics.membershipSource = 'eastmoney';
    if (quoteResult.status === 'fulfilled') {
      diagnostics.quoteSource = 'eastmoney';
    } else {
      try {
        quotes = await fetchTencentCandidateQuotes(codes);
        diagnostics.quoteSource = 'tencent';
        diagnostics.sourceWarnings.push('candidate-quotes-fell-back-to-tencent');
      } catch (fallbackError) {
        diagnostics.sourceFailures.push('candidate-quotes-eastmoney: ' + String(quoteResult.reason?.message ?? quoteResult.reason));
        diagnostics.sourceFailures.push('candidate-quotes-tencent: ' + String(fallbackError?.message ?? fallbackError));
      }
    }
    diagnostics.quoteRows = quotes.size;
    diagnostics.conceptRows = conceptRows.length;
    const conceptMap = new Map(conceptRows.map(row => [row.code, row]));

    if (!memberships) {
      memberships = conceptRows.length ? await mapLimit(codes, membershipConcurrency, async code => {
        await sleep(120);
        try {
          return {code, concepts:await fetchStockConcepts(code)};
        } catch (primaryError) {
          try {
            const thsConcepts = await fetchThsStockConcepts(code);
            const byName = new Map(conceptRows.map(theme => [normalizeThemeName(theme.name), theme]));
            const concepts = thsConcepts.map(theme => byName.get(theme.normalizedName))
              .filter(Boolean).map(theme => ({code:theme.code, name:theme.name}));
            diagnostics.sourceWarnings.push('stock-membership-fell-back-to-10jqka:' + code);
            if (!concepts.length) diagnostics.membershipFailures += 1;
            return {code, concepts};
          } catch (fallbackError) {
            diagnostics.membershipFailures += 1;
            return {code, concepts:[], error:String(primaryError?.message ?? primaryError) + '; 10jqka: ' + String(fallbackError?.message ?? fallbackError)};
          }
        }
      }) : codes.map(code => ({code, concepts:[]}));
    }

    const selectedByStock = new Map();
    const uniqueThemeCodes = new Set();
    for (const membership of memberships) {
      const matched = membership.concepts
        .map(ref => conceptMap.get(ref.code))
        .filter(isNarrativeTheme)
        .sort((a,b) => themeStrength(b) - themeStrength(a) || a.code.localeCompare(b.code))
        .slice(0, selectedThemesPerStock);
      selectedByStock.set(membership.code, matched);
      matched.forEach(theme => uniqueThemeCodes.add(theme.code));
    }

    const rankedResearchThemes = [...uniqueThemeCodes]
      .map(code => conceptMap.get(code))
      .filter(Boolean)
      .sort((a,b) => themeStrength(b) - themeStrength(a) || a.code.localeCompare(b.code))
      .slice(0, maxResearchThemes);
    const researchThemeCodes = new Set(rankedResearchThemes.map(theme => theme.code));

    const flowMap = new Map();
    await mapLimit([...researchThemeCodes], researchConcurrency, async boardCode => {
      if (String(boardCode).startsWith('SINA:')) {
        diagnostics.flowFailures += 1;
        flowMap.set(boardCode, []);
        return;
      }
      await sleep(120);
      try {
        flowMap.set(boardCode, await fetchThemeFlow(boardCode));
      } catch (error) {
        diagnostics.flowFailures += 1;
        if (diagnostics.themeRequestFailureSamples.length < 10) {
          diagnostics.themeRequestFailureSamples.push({
            source:'theme-flow',themeCode:boardCode,
            error:String(error?.message ?? error).slice(0,180)
          });
        }
        flowMap.set(boardCode, []);
      }
    });

    const memberMap = new Map();
    const newsMap = new Map();
    await mapLimit(rankedResearchThemes, researchConcurrency, async base => {
      await sleep(120);
      const membersPromise = String(base.code).startsWith('SINA:')
        ? Promise.resolve(Array.isArray(base.sinaMembers) ? base.sinaMembers : [])
        : fetchThemeMembers(base.code);
      const [membersResult, newsResult] = await Promise.allSettled([
        membersPromise,
        fetchThemeNews(base.name)
      ]);
      if (membersResult.status === 'fulfilled') {
        memberMap.set(base.code, membersResult.value);
      } else {
        memberMap.set(base.code, []);
        diagnostics.researchFailures += 1;
        diagnostics.themeMemberFailures += 1;
        if (diagnostics.themeRequestFailureSamples.length < 10) {
          diagnostics.themeRequestFailureSamples.push({
            source:'theme-members',themeCode:base.code,
            error:String(membersResult.reason?.message ?? membersResult.reason).slice(0,180)
          });
        }
      }
      if (newsResult.status === 'fulfilled') {
        newsMap.set(base.code, newsResult.value);
      } else {
        newsMap.set(base.code, []);
        diagnostics.researchFailures += 1;
        diagnostics.themeNewsFailures += 1;
        if (diagnostics.themeRequestFailureSamples.length < 10) {
          diagnostics.themeRequestFailureSamples.push({
            source:'theme-news',themeCode:base.code,themeName:base.name,
            error:String(newsResult.reason?.message ?? newsResult.reason).slice(0,180)
          });
        }
      }
    });
    diagnostics.researchThemes = rankedResearchThemes.length;

    const fallbackAsOf = captureAsOf;
    const themeBySymbol = {};
    const allThemes = new Map();
    for (const code of codes) {
      const candidatePct = quotes.get(code)?.pct ?? null;
      const candidateName = quotes.get(code)?.name ?? null;
      const themes = (selectedByStock.get(code) ?? []).map(base => {
        if (!researchThemeCodes.has(base.code)) {
          const theme = enrichTheme(base, [], [], [], candidatePct, code, candidateName, fallbackAsOf);
          theme.source.researchRequired = ['research-not-selected'];
          allThemes.set(theme.code, theme);
          return theme;
        }
        const rows = flowMap.get(base.code) ?? [];
        const flowAsOf = sourceAsOf(rows, fallbackAsOf);
        const theme = enrichTheme(base, rows, memberMap.get(base.code) ?? [],
          newsMap.get(base.code) ?? [], candidatePct, code, candidateName, fallbackAsOf);
        theme.flowAsOf = flowAsOf;
        allThemes.set(theme.code, theme);
        return theme;
      });
      themeBySymbol[code] = themes;
    }

    diagnostics.themeCount = allThemes.size;
    const finalCoverage = summarizeSourceCoverage(diagnostics);
    diagnostics.sourceDegraded = finalCoverage.degraded;
    diagnostics.sourceWarnings = [...new Set([...diagnostics.sourceWarnings, ...finalCoverage.warnings])];
    const asOfValues = Object.values(themeBySymbol).flat()
      .map(theme => theme.asOf).filter(Boolean).sort();

    res.statusCode = 200;
    res.setHeader('content-type','application/json; charset=utf-8');
    res.setHeader('cache-control','s-maxage=30, stale-while-revalidate=60');
    res.end(JSON.stringify({
      schema:'v12-psychology-source-v1',
      version:'V12 Psychology Market Evidence Phase 3 Behavioral',
      status:finalCoverage.status,
      degraded:finalCoverage.degraded,
      asOf:fallbackAsOf,
      data:{
        themeBySymbol,
        themes:[...allThemes.values()]
      },
      diagnostics,
      researchPolicy:{
        psychologyCanBeComputed:true,
        mode:'automatic-news-proxy-with-evidence-gates',
        reason:'Narrative and imagination are derived from dated public news, theme membership, leader evidence and market data; behavioral psychology is derived from capital-price alignment, participation breadth and FOMO balance. Incomplete evidence remains null and cannot enter V12.',
        requiredFields:['narrativeScore','narrativeEvidence','imaginationScore','imaginationEvidence'],
        behavioralInputs:['mainNetPct','changePct','upCount','downCount','flatCount','leaderChangePct']
      }
    }));
  } catch (error) {
    res.statusCode = 502;
    res.setHeader('content-type','application/json; charset=utf-8');
    res.end(JSON.stringify({
      schema:'v12-psychology-source-v1',
      error:error?.message ?? String(error),
      diagnostics
    }));
  }
}
