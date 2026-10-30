export const config = { maxDuration: 20 };

const HOSTS = [
  'https://push2.eastmoney.com',
  'https://7.push2.eastmoney.com',
  'https://43.push2.eastmoney.com'
];
const DEFAULT_SEGMENTS = Object.freeze([
  {key:'SZ_MAIN', fs:'m:0+t:6'},
  {key:'SH_MAIN', fs:'m:1+t:2'}
]);
const DEFAULT_FACTORS = Object.freeze([
  {key:'dayMomentum', fid:'f3'},
  {key:'amount', fid:'f6'},
  {key:'mainNet', fid:'f62'},
  {key:'mainPct', fid:'f184'}
]);
const FIELDS = 'f12,f14,f2,f3,f6,f8,f20,f24,f62,f100,f124,f184';
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 2;
const DEFAULT_TIMEOUT_MS = 3200;
const DEFAULT_SCAN_BUDGET_MS = 15000;

function n(value) {
  if (value === null || value === undefined || value === '' || value === '-') return NaN;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}
function isoQuoteTime(value) {
  const seconds = n(value);
  return Number.isFinite(seconds) && seconds >= 1e9 && seconds <= 2.2e9
    ? new Date(seconds * 1000).toISOString()
    : null;
}
function parseMaybeJsonp(value) {
  const text = String(value ?? '').trim();
  try { return JSON.parse(text); } catch {}
  const left = text.indexOf('('), right = text.lastIndexOf(')');
  if (left >= 0 && right > left) return JSON.parse(text.slice(left + 1, right));
  throw new Error('upstream-invalid-json');
}
function isMainBoard(code) {
  return /^(00|60)\d{4}$/.test(String(code ?? ''));
}
function shanghaiDate(ms) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit'
  }).format(new Date(ms));
}
function isContinuousSession(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone:'Asia/Shanghai', weekday:'short', hour:'2-digit', minute:'2-digit', hourCycle:'h23'
  }).formatToParts(new Date(ms));
  const get = key => parts.find(part => part.type === key)?.value;
  const minute = Number(get('hour')) * 60 + Number(get('minute'));
  return ['Mon','Tue','Wed','Thu','Fri'].includes(get('weekday'))
    && ((minute >= 570 && minute < 690) || (minute >= 780 && minute < 900));
}
function factorRankScore(position, observedCount) {
  if (!(observedCount > 1)) return 100;
  return Math.max(0, Math.min(100, 100 * (1 - (position - 1) / (observedCount - 1))));
}
function normalizeCandidate(raw, segment) {
  const code = String(raw?.f12 ?? '').trim();
  const name = String(raw?.f14 ?? '');
  const price = n(raw?.f2), pct = n(raw?.f3), amount = n(raw?.f6);
  if (!isMainBoard(code) || /(?:ST|退)/i.test(name) || !(price > 0) || !Number.isFinite(pct) || !(amount >= 0)) return null;
  return {
    code, name, price, pct, amount,
    turn: n(raw?.f8),
    mcap: n(raw?.f20),
    pct60: n(raw?.f24),
    mainNet: n(raw?.f62),
    mainPct: n(raw?.f184),
    industry: !raw?.f100 || raw.f100 === '-' ? '' : String(raw.f100),
    quoteAt: isoQuoteTime(raw?.f124),
    mainBoard: true,
    specialTreatment: false,
    discoverySegment: segment
  };
}
function jobKey(job) {
  return [job.segment.key, job.factor.key, job.page].join('|');
}
async function fetchPage(job, {
  fetchImpl, now, deadlineAt, pageSize, timeoutMs, hosts
}) {
  const started = now();
  let lastError = 'unknown-upstream-error';
  for (const host of hosts) {
    const remaining = deadlineAt - now();
    if (remaining < 600) throw new Error('scan-time-budget-exceeded');
    const url = new URL('/api/qt/clist/get', host);
    url.search = new URLSearchParams({
      pn: String(job.page),
      pz: String(pageSize),
      po: '1',
      np: '1',
      fltt: '2',
      invt: '2',
      fid: job.factor.fid,
      fs: job.segment.fs,
      fields: FIELDS
    }).toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(250, Math.min(timeoutMs, remaining - 250)));
    try {
      const response = await fetchImpl(url.toString(), {
        signal: controller.signal,
        cache: 'no-store',
        headers: {
          accept:'application/json,text/javascript,*/*;q=0.8',
          referer:'https://quote.eastmoney.com/',
          'user-agent':'Mozilla/5.0 AShareQuant/independent-observation-v1'
        }
      });
      if (!response.ok) throw new Error('upstream-http-' + response.status);
      const payload = parseMaybeJsonp(await response.text());
      const total = n(payload?.data?.total);
      const diff = payload?.data?.diff;
      const rows = Array.isArray(diff) ? diff : diff && typeof diff === 'object' ? Object.values(diff) : null;
      if (!Number.isInteger(total) || total < 0 || !Array.isArray(rows)) throw new Error('upstream-malformed-page');
      if (job.expectedTotal !== undefined && total !== job.expectedTotal) throw new Error('upstream-total-drift');
      const expected = Math.max(0, Math.min(pageSize, total - (job.page - 1) * pageSize));
      if (rows.length !== expected) throw new Error('upstream-short-page');
      return {page:job.page,total,rows,host,elapsedMs:now()-started};
    } catch (error) {
      lastError = controller.signal.aborted ? 'upstream-timeout' : String(error?.message ?? error);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastError);
}
async function mapLimit(items, concurrency, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({length:Math.max(1,Math.min(concurrency,items.length || 1))}, async () => {
    while (next < items.length) {
      const index = next++;
      try { out[index] = {ok:true, value:await fn(items[index])}; }
      catch (error) { out[index] = {ok:false, error:String(error?.message ?? error)}; }
    }
  }));
  return out;
}
function buildRecords(successfulPages, {pageSize, maxPages}) {
  const records = new Map();
  let excludedRestrictedCount = 0, excludedInvalidCount = 0, providerRows = 0;
  for (const {job, result} of successfulPages) {
    const observedCount = Math.max(1, Math.min(result.total, pageSize * maxPages));
    for (let offset = 0; offset < result.rows.length; offset++) {
      providerRows++;
      const raw = result.rows[offset];
      const candidate = normalizeCandidate(raw, job.segment.key);
      if (!candidate) {
        if (/(?:ST|退)/i.test(String(raw?.f14 ?? ''))) excludedRestrictedCount++;
        else excludedInvalidCount++;
        continue;
      }
      const position = (job.page - 1) * pageSize + offset + 1;
      const existing = records.get(candidate.code);
      const previousRank = n(existing?.factorRanks?.[job.factor.key]);
      const factorRanks = {
        ...(existing?.factorRanks ?? {}),
        [job.factor.key]:previousRank===null?position:Math.min(previousRank,position)
      };
      const factorScores = Object.entries(factorRanks).map(([key, rank]) => {
        const sameFactorPages = successfulPages.filter(item => item.job.factor.key === key && item.job.segment.key === job.segment.key);
        const totalForFactor = sameFactorPages.length
          ? Math.max(...sameFactorPages.map(item => item.result.total))
          : result.total;
        return factorRankScore(rank, Math.max(1, Math.min(totalForFactor, pageSize * maxPages)));
      });
      const newer = !existing || (Date.parse(candidate.quoteAt ?? '') > Date.parse(existing.quoteAt ?? ''));
      const merged = newer ? {...existing, ...candidate} : {...candidate, ...existing};
      records.set(candidate.code, {
        ...merged,
        factorRanks,
        discoveryFactors:Object.keys(factorRanks),
        rankHits:Object.keys(factorRanks).length,
        rankScore:factorScores.length ? factorScores.reduce((sum, score) => sum + score, 0) / factorScores.length : 50,
        independentDiscovery:true
      });
    }
  }
  return {records:[...records.values()], providerRows, excludedRestrictedCount, excludedInvalidCount};
}
function qualityFor(records, pageMeta, failures, startedAt, finishedAt, now, segments, factors, minObservationRecords) {
  const sameDate = records.filter(row => row.quoteAt && shanghaiDate(Date.parse(row.quoteAt)) === shanghaiDate(finishedAt));
  const fresh = sameDate.filter(row => {
    const lag = (finishedAt - Date.parse(row.quoteAt)) / 1000;
    return lag >= -60 && lag <= 180;
  });
  const quoteCoverage = records.filter(row => row.quoteAt).length / Math.max(1, records.length);
  const sameDateRatio = sameDate.length / Math.max(1, records.length);
  const freshRatio = fresh.length / Math.max(1, records.length);
  const requiredFirstPages = segments.map(segment =>
    pageMeta.some(item => item.segment === segment.key && item.factor === 'dayMomentum' && item.page === 1)
  );
  const availableFactorCount = factors.filter(factor =>
    segments.every(segment => pageMeta.some(item => item.segment === segment.key && item.factor === factor.key && item.page === 1))
  ).length;
  const errors = [];
  if (records.length < minObservationRecords) errors.push('too-few-unique-main-board-candidates');
  if (quoteCoverage < 0.90) errors.push('quote-timestamp-coverage-below-90pct');
  if (sameDateRatio < 0.85) errors.push('same-date-quote-coverage-below-85pct');
  if (freshRatio < 0.75) errors.push('fresh-quote-coverage-below-75pct');
  if (failures.length) errors.push('one-or-more-factor-pages-failed');
  if (requiredFirstPages.some(value => !value)) errors.push('missing-main-board-momentum-source');
  if (availableFactorCount < 3) errors.push('fewer-than-three-independent-factors-covered');
  if (finishedAt - startedAt > 12000) errors.push('collection-span-over-12s');
  if (!isContinuousSession(finishedAt)) errors.push('outside-continuous-trading');
  const usableForObservation = records.length >= minObservationRecords
    && quoteCoverage >= 0.65
    && sameDateRatio >= 0.65
    && freshRatio >= 0.60
    && requiredFirstPages.every(Boolean)
    && availableFactorCount >= 3
    && isContinuousSession(finishedAt);
  return {
    qualifiedForObservationPool:errors.length === 0,
    usableForObservation,
    errors,
    quoteCoverage,
    sameDateRatio,
    freshRatio,
    records:records.length,
    pageCount:pageMeta.length,
    failedPageCount:failures.length,
    requiredMomentumPagesPresent:requiredFirstPages.every(Boolean),
    availableFactorCount,
    collectionSpanMs:finishedAt-startedAt,
    providerDate:shanghaiDate(finishedAt),
    session:isContinuousSession(finishedAt)?'CONTINUOUS_TRADING':'OUTSIDE_SESSION',
    approximatePointInTime:true,
    notAtomicSnapshot:true
  };
}
export function createHandler({
  fetchImpl = fetch,
  now = () => Date.now(),
  segments = DEFAULT_SEGMENTS,
  factors = DEFAULT_FACTORS,
  pageSize = DEFAULT_PAGE_SIZE,
  maxPages = DEFAULT_MAX_PAGES,
  concurrency = 8,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxScanMs = DEFAULT_SCAN_BUDGET_MS,
  minObservationRecords = 150,
  hosts = HOSTS
} = {}) {
  async function collect() {
    const startedAt = now(), deadlineAt = startedAt + maxScanMs;
    const pageMeta = [], failures = [];
    const firstPageJobs = segments.flatMap(segment => factors.map(factor => ({segment,factor,page:1})));
    const firstResults = await mapLimit(firstPageJobs, concurrency, job =>
      fetchPage(job,{fetchImpl,now,deadlineAt,pageSize,timeoutMs,hosts})
    );
    const successfulPages = [];
    const secondPageJobs = [];
    for (let i = 0; i < firstResults.length; i++) {
      const job = firstPageJobs[i], outcome = firstResults[i];
      if (!outcome.ok) {
        failures.push({segment:job.segment.key,factor:job.factor.key,page:1,error:outcome.error});
        continue;
      }
      const result = outcome.value;
      successfulPages.push({job,result});
      pageMeta.push({segment:job.segment.key,factor:job.factor.key,page:1,total:result.total,count:result.rows.length,host:result.host,elapsedMs:result.elapsedMs});
      if (maxPages > 1 && result.total > pageSize) {
        secondPageJobs.push({...job,page:2,expectedTotal:result.total});
      }
    }
    const secondResults = await mapLimit(secondPageJobs, concurrency, job =>
      fetchPage(job,{fetchImpl,now,deadlineAt,pageSize,timeoutMs,hosts})
    );
    for (let i = 0; i < secondResults.length; i++) {
      const job = secondPageJobs[i], outcome = secondResults[i];
      if (!outcome.ok) {
        failures.push({segment:job.segment.key,factor:job.factor.key,page:2,error:outcome.error});
        continue;
      }
      const result = outcome.value;
      successfulPages.push({job,result});
      pageMeta.push({segment:job.segment.key,factor:job.factor.key,page:2,total:result.total,count:result.rows.length,host:result.host,elapsedMs:result.elapsedMs});
    }
    const built = buildRecords(successfulPages,{pageSize,maxPages});
    const finishedAt = now();
    const quality = qualityFor(built.records,pageMeta,failures,startedAt,finishedAt,now,segments,factors,minObservationRecords);
    return {
      schema:'ashare-v15-independent-ranked-main-board-v1',
      generatedAt:new Date(finishedAt).toISOString(),
      source:{
        provider:'Eastmoney-clist',
        scope:'top-ranked pages from independent Shanghai/Shenzhen main-board segments',
        factors:factors.map(factor=>({key:factor.key,fid:factor.fid})),
        pageSize,
        maxPages,
        notFullMarketUniverse:true,
        notExchangeCertified:true
      },
      status:quality.qualifiedForObservationPool?'QUALIFIED_OBSERVATION_POOL':quality.usableForObservation?'USABLE_WITH_WARNINGS':'UNUSABLE_OBSERVATION_POOL',
      usableForObservation:quality.usableForObservation,
      quality,
      asOf:{collectionStartedAt:new Date(startedAt).toISOString(),collectionFinishedAt:new Date(finishedAt).toISOString(),quoteTimestampField:'f124',notAtomicSnapshot:true},
      providerRows:built.providerRows,
      excludedRestrictedCount:built.excludedRestrictedCount,
      excludedInvalidCount:built.excludedInvalidCount,
      pageMeta,
      failures,
      records:built.records.sort((a,b)=>(b.rankScore-a.rankScore)||(b.rankHits-a.rankHits)||a.code.localeCompare(b.code)).map(row=>({
        ...row,
        price:Number.isFinite(row.price)?row.price:null,
        pct:Number.isFinite(row.pct)?row.pct:null,
        amount:Number.isFinite(row.amount)?row.amount:null,
        turn:Number.isFinite(row.turn)?row.turn:null,
        mcap:Number.isFinite(row.mcap)?row.mcap:null,
        pct60:Number.isFinite(row.pct60)?row.pct60:null,
        mainNet:Number.isFinite(row.mainNet)?row.mainNet:null,
        mainPct:Number.isFinite(row.mainPct)?row.mainPct:null
      }))
    };
  }
  return async function handler(req,res) {
    res.setHeader('Cache-Control','no-store, max-age=0');
    res.setHeader('Content-Type','application/json; charset=utf-8');
    if (req.method !== 'GET') return res.status(405).json({error:'METHOD_NOT_ALLOWED'});
    try {
      const result = await collect();
      if (!result.records.length) return res.status(503).json({...result,error:'NO_USABLE_OBSERVATION_CANDIDATES'});
      return res.status(200).json(result);
    } catch (error) {
      return res.status(503).json({
        schema:'ashare-v15-independent-ranked-main-board-v1',
        status:'SOURCE_FAILED',
        usableForObservation:false,
        error:String(error?.message ?? 'unknown-source-error').slice(0,180),
        records:[],
        failures:[],
        noPartialUniverse:true
      });
    }
  };
}
export default createHandler();
export const _internal = {n,isoQuoteTime,isMainBoard,shanghaiDate,isContinuousSession,normalizeCandidate,factorRankScore,qualityFor};
