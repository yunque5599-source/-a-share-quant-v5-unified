import { performance } from 'node:perf_hooks';

export function parseUpstream(text) {
  const raw = String(text ?? '').trim();
  try { return JSON.parse(raw); } catch {}
  const a = raw.indexOf('('), b = raw.lastIndexOf(')');
  if (a >= 0 && b > a) return JSON.parse(raw.slice(a + 1, b));
  throw new Error('invalid JSON/JSONP');
}
const rowsOf = value => Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : [];
const finite = value => value !== null && value !== '' && value !== '-' && Number.isFinite(Number(value));
function shapeOf(value, depth = 0) {
  if (depth > 2) return Array.isArray(value) ? {type:'array',length:value.length} : typeof value;
  if (Array.isArray(value)) return {type:'array',length:value.length,sample:value.length ? shapeOf(value[0], depth + 1) : null};
  if (value === null) return 'null';
  if (typeof value !== 'object') return typeof value;
  const keys = Object.keys(value).sort();
  return {type:'object',keys:keys.slice(0,40),keyCount:keys.length,
    samples:Object.fromEntries(keys.slice(0,12).map(key => [key, shapeOf(value[key], depth + 1)]))};
}
function invalidFields(message, payload) {
  const error = new Error(message);
  error.structure = shapeOf(payload);
  throw error;
}
export function summarizeStructure(value) { return shapeOf(value); }
export function inspectFields(url, text) {
  const u = new URL(url), path = u.pathname;
  if (u.hostname === 'vip.stock.finance.sina.com.cn') {
    const rows = parseUpstream(text);
    if (!Array.isArray(rows) || !rows.some(r => /^\d{6}$/.test(r.code) && finite(r.trade) && finite(r.changepercent))) invalidFields('Sina quote fields unavailable', rows);
    return {rows:rows.length, quality:'degraded', missing:['capital-flow','industry','verified-timestamp']};
  }
  if (u.hostname === 'web.ifzq.gtimg.cn') {
    const box = Object.values(parseUpstream(text).data ?? {})[0] ?? {};
    const rows = box.qfqday ?? box.day ?? [];
    if (rows.length < 35 || rows.some(row => !/^\d{4}-\d{2}-\d{2}$/.test(row[0]) || !finite(row[2]) || Number(row[2]) <= 0)) invalidFields('Tencent OHLC fields unavailable', {data:parseUpstream(text).data, rows});
    return {rows:rows.length, quality:'degraded', missing:['verified-turnover-amount','capital-flow']};
  }
  const json = parseUpstream(text);
  if (path === '/search/jsonp') {
    const articles = json.result?.cmsArticleWebOld;
    if (!Array.isArray(articles)) invalidFields('news article list missing', json);
    return {rows:articles.length, quality:articles.length ? 'available' : 'incomplete'};
  }
  if (path.includes('kline/get') || path.includes('daykline/get')) {
    const rows = json.data?.klines;
    if (!Array.isArray(rows) || !rows.length || !rows.some(line => {
      const a = String(line).split(',');
      return /^\d{4}-\d{2}-\d{2}$/.test(a[0]) && finite(a[path.includes('daykline') ? 1 : 2]);
    })) invalidFields('historical rows/fields unavailable', json);
    return {rows:rows.length, quality:'available'};
  }
  if (path.includes('clist/get') || path.includes('ulist.np/get') || path.includes('slist/get')) {
    const rows = rowsOf(json.data?.diff);
    if (!rows.length) invalidFields('quote/member rows unavailable', json);
    if (!rows.some(row => row.f12 && (path.includes('slist') || finite(row.f3)))) invalidFields('quote identifiers/change missing', {data:json?.data, diff:json?.data?.diff, rows});
    return {rows:rows.length, quality:'available'};
  }
  return {rows:null, quality:'unvalidated'};
}

/** Scoped to the research CLI process. Production handlers/files are unchanged. */
export async function withResearchSources(operation, {
  fetchImpl = globalThis.fetch, attempts = 2, timeoutMs = 6000,
  backoffMs = 200, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  diagnostics = []
} = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url ?? input);
    let last;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const start = performance.now();
      const entry = {host:new URL(url).host, path:new URL(url).pathname, attempt, httpStatus:null,
        status:'SOURCE_UNAVAILABLE', elapsedMs:0};
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
        const response = await fetchImpl(input, {...init, signal, cache:'no-store'});
        entry.httpStatus = response.status;
        if (!response.ok) throw new Error('HTTP ' + response.status);
        // Clone validation never consumes the body supplied to the existing handler.
        const text = await response.clone().text();
        const fields = inspectFields(url, text);
        Object.assign(entry, fields, {status:fields.quality === 'incomplete' ? 'INCOMPLETE' : 'AVAILABLE'});
        entry.elapsedMs = Math.round(performance.now() - start);
        diagnostics.push(entry);
        return response;
      } catch (error) {
        last = error;
        entry.error = String(error.message ?? error);
        if (error?.structure) entry.responseStructure = error.structure;
        entry.elapsedMs = Math.round(performance.now() - start);
        diagnostics.push(entry);
        const retryable = entry.httpStatus === null || [408,429,500,502,503,504].includes(entry.httpStatus);
        if (!retryable || init.signal?.aborted || attempt === attempts) break;
      } finally { clearTimeout(timer); }
      await sleep(backoffMs * 2 ** (attempt - 1));
    }
    throw last ?? new Error('SOURCE_UNAVAILABLE');
  };
  try { return await operation(diagnostics); }
  finally { globalThis.fetch = original; }
}
export async function invokeHandler(handler, url) {
  return new Promise((resolve, reject) => {
    const res = {statusCode:200, setHeader() {},
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({statusCode:this.statusCode, body}); },
      send(body) { try { resolve({statusCode:this.statusCode, body:typeof body === 'string' ? JSON.parse(body) : body}); }
        catch (error) { reject(error); } },
      end(body) { this.send(body); }
    };
    Promise.resolve(handler({method:'GET', url}, res)).catch(reject);
  });
}
export function requireResponse(name, result) {
  if (!result || result.statusCode !== 200 || !result.body || result.body.error) {
    const error = new Error(name + ': SOURCE_UNAVAILABLE HTTP ' + result?.statusCode);
    error.status = 'SOURCE_UNAVAILABLE';
    throw error;
  }
  return result.body;
}
