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

async function fetchParsed(url, timeoutMs = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      headers: {
        accept: 'application/json,text/javascript,*/*;q=0.8',
        'user-agent': UA,
        referer: 'https://quote.eastmoney.com/'
      }
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return parseMaybeJson(await response.text());
  } finally {
    clearTimeout(timer);
  }
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
      pn:'1', pz:'600', po:'1', np:'1', fid:'f3',
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

async function fetchConceptRanking() {
  const firstSpec = conceptRankingUrl();
  const first = await fetchFromHosts(PUSH_HOSTS, firstSpec.path, firstSpec.params, 9000);
  const total = n(first?.data?.total) ?? 0;
  const pageCount = Math.max(1, Math.min(6, Math.ceil(total / 100)));
  const pages = [first];
  if (pageCount > 1) {
    const rest = await mapLimit(
      Array.from({length:pageCount - 1}, (_, index) => index + 2),
      2,
      async page => {
        await sleep(120);
        return fetchFromHosts(PUSH_HOSTS, firstSpec.path,
          {...firstSpec.params, pn:String(page)}, 9000);
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

async function fetchStockConcepts(code) {
  const json = await fetchFromHosts(PUSH_HOSTS, '/api/qt/slist/get', {
    secid:secid(code), spt:'3', pi:'0', pz:'200', po:'1',
    fields:'f12,f14,f3,f128,f140,f141', ut:UT
  }, 7000);
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
  const json = await fetchFromHosts(PUSH_HOSTS, '/api/qt/ulist.np/get', {
    secids:codes.map(secid).join(','),
    fields:'f12,f14,f3,f124',
    fltt:'2', invt:'2', ut:UT
  }, 7000);
  const diff = json?.data?.diff;
  const rows = Array.isArray(diff) ? diff : diff && typeof diff === 'object' ? Object.values(diff) : [];
  return new Map(rows.map(row => [String(row?.f12 ?? ''), {
    name:String(row?.f14 ?? ''), pct:n(row?.f3), quoteTimestamp:n(row?.f124)
  }]));
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
  /ST板块/, /风险警示/, /次新股/
];

function isNarrativeTheme(row = {}) {
  const name = String(row.name ?? '');
  return String(row.code ?? '').startsWith('BK') &&
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
  const candidateRankIndex = resolvedCandidateCode
    ? members.findIndex(row => row.code === candidateCode) : -1;
  const memberLeader = members[0] ?? null;
  const leaderCode = base.leaderCode || memberLeader?.code || null;
  const leaderName = base.leaderName || memberLeader?.name || null;
  const leaderChangePct = base.leaderChangePct ?? memberLeader?.pct ?? null;
  const leaderStatus = resolvedCandidateCode && resolvedCandidateCode === leaderCode ? 'leader' :
    candidateRankIndex >= 0 && candidateRankIndex < 3 ? 'core' :
    candidateRankIndex >= 0 && candidateRankIndex < 5 ? 'front' : 'follower';
  const candidatePremiumPct = candidatePct !== null && base.changePct !== null
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
    imaginationScore:research.researchQuality.imagination.complete
      ? research.imaginationResearch.marketSize * 0.25 +
        research.imaginationResearch.penetrationGap * 0.20 +
        research.imaginationResearch.policyRunway * 0.20 +
        research.imaginationResearch.technologyOptionality * 0.20 +
        research.imaginationResearch.companyCapture * 0.15 : null,
    imaginationEvidence:research.imaginationResearch.evidence ?? [],
    researchQuality:research.researchQuality,
    researchVersion:research.version,
    researchDiagnostics:{
      newsCount:research.news.length,
      narrative:research.researchQuality.narrative,
      imagination:research.researchQuality.imagination
    },
    source:{
      provider:'eastmoney',
      conceptRanking:true,
      membership:true,
      themeMembers:memberRows.length > 0,
      news:true,
      flowHistory:rows.length > 0,
      researchRequired:research.researchQuality.narrative.complete &&
        research.researchQuality.imagination.complete ? [] :
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
  themeStrength
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
    selectedThemesPerStock:2,
    maxResearchThemes:24,
    asOfMode:requestedAsOf ? 'caller-supplied' : 'server-capture',
    asOf:captureAsOf
  };

  try {
    const [conceptRows, quotes] = await Promise.all([
      fetchConceptRanking(),
      fetchCandidateQuotes(codes)
    ]);
    diagnostics.conceptRows = conceptRows.length;
    const conceptMap = new Map(conceptRows.map(row => [row.code, row]));

    const memberships = await mapLimit(codes, 4, async code => {
      await sleep(120);
      try {
        return {code, concepts:await fetchStockConcepts(code)};
      } catch (error) {
        diagnostics.membershipFailures += 1;
        return {code, concepts:[], error:error?.message ?? String(error)};
      }
    });

    const selectedByStock = new Map();
    const uniqueThemeCodes = new Set();
    for (const membership of memberships) {
      const matched = membership.concepts
        .map(ref => conceptMap.get(ref.code))
        .filter(isNarrativeTheme)
        .sort((a,b) => themeStrength(b) - themeStrength(a) || a.code.localeCompare(b.code))
        .slice(0,2);
      selectedByStock.set(membership.code, matched);
      matched.forEach(theme => uniqueThemeCodes.add(theme.code));
    }

    const rankedResearchThemes = [...uniqueThemeCodes]
      .map(code => conceptMap.get(code))
      .filter(Boolean)
      .sort((a,b) => themeStrength(b) - themeStrength(a) || a.code.localeCompare(b.code))
      .slice(0, diagnostics.maxResearchThemes);
    const researchThemeCodes = new Set(rankedResearchThemes.map(theme => theme.code));

    const flowMap = new Map();
    await mapLimit([...researchThemeCodes], 5, async boardCode => {
      await sleep(120);
      try {
        flowMap.set(boardCode, await fetchThemeFlow(boardCode));
      } catch {
        diagnostics.flowFailures += 1;
        flowMap.set(boardCode, []);
      }
    });

    const memberMap = new Map();
    const newsMap = new Map();
    await mapLimit(rankedResearchThemes, 4, async base => {
      await sleep(120);
      try {
        memberMap.set(base.code, await fetchThemeMembers(base.code));
      } catch {
        memberMap.set(base.code, []);
        diagnostics.researchFailures += 1;
      }
      try {
        newsMap.set(base.code, await fetchThemeNews(base.name));
      } catch {
        newsMap.set(base.code, []);
        diagnostics.researchFailures += 1;
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
    const asOfValues = Object.values(themeBySymbol).flat()
      .map(theme => theme.asOf).filter(Boolean).sort();

    res.statusCode = 200;
    res.setHeader('content-type','application/json; charset=utf-8');
    res.setHeader('cache-control','s-maxage=30, stale-while-revalidate=60');
    res.end(JSON.stringify({
      schema:'v12-psychology-source-v1',
      version:'V12 Psychology Market Evidence Phase 3 Behavioral',
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
