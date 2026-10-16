import handler from '../../api/psychology_universe.js';
import marketHandler from '../../api/market.js';

function invoke(handler, url) {
  return new Promise((resolve, reject) => {
    let body = '';
    const req = {method:'GET', url};
    const res = {
      statusCode:200,
      setHeader() {},
      status(code) { this.statusCode = code; return this; },
      send(value) {
        body = typeof value === 'string' ? value : JSON.stringify(value);
        resolve({statusCode:this.statusCode, body});
      },
      end(value = '') {
        body = String(value);
        resolve({statusCode:this.statusCode, body});
      }
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

const marketResult = await invoke(marketHandler, '/api/market?action=ranked_candidates');
const marketPayload = marketResult.statusCode === 200 ? JSON.parse(marketResult.body) : null;
if (!marketPayload) {
  console.warn('LIVE_MARKET_WARNING: ranked_candidates unavailable: ' + marketResult.body);
}
const liveCodes = (marketPayload?.data?.candidates ?? [])
  .map(row => String(row?.f12 ?? ''))
  .filter(code => /^(00|60)\d{4}$/.test(code))
  .slice(0, 8);
const codes = process.env.V12_PROBE_CODES ||
  (liveCodes.length >= 2 ? liveCodes.join(',') : '600519,000001');
const result = await invoke(handler, '/api/psychology_universe?codes=' + encodeURIComponent(codes));

if (result.statusCode !== 200) {
  throw new Error('psychology_universe returned HTTP ' + result.statusCode + ': ' + result.body);
}

const payload = JSON.parse(result.body);
const themes = payload?.data?.themes ?? [];
const diagnostics = payload?.diagnostics ?? {};
const quality = themes.map(theme => ({
  code:theme.code,
  name:theme.name,
  candidateCode:theme.candidateCode,
  leaderStatus:theme.leaderStatus,
  newsCount:theme.news?.length ?? 0,
  narrativeComplete:theme.researchQuality?.narrative?.complete ?? false,
  imaginationComplete:theme.researchQuality?.imagination?.complete ?? false
}));

if (payload.schema !== 'v12-psychology-source-v1') {
  throw new Error('unexpected schema: ' + payload.schema);
}
if ((diagnostics.conceptRows ?? 0) <= 0) {
  throw new Error('live concept-board source returned zero rows');
}
if (themes.length <= 0 || (diagnostics.themeCount ?? 0) <= 0) {
  throw new Error('live theme mapping returned zero themes');
}
if (quality.every(item => item.newsCount === 0)) {
  console.warn('LIVE_SOURCE_WARNING: no dated theme news returned; narrative/imagination may remain incomplete');
}

console.log(JSON.stringify({
  status:'LIVE_SOURCE_OK',
  market:{
    available:marketResult.statusCode === 200,
    candidateCount:marketPayload?.data?.candidateCount ?? 0,
    listsOk:marketPayload?.data?.listsOk ?? 0,
    listsTotal:marketPayload?.data?.listsTotal ?? 0,
    failures:marketPayload?.data?.failures ?? []
  },
  schema:payload.schema,
  asOf:payload.asOf,
  requestedCodes:diagnostics.requestedCodes,
  conceptRows:diagnostics.conceptRows,
  themeCount:diagnostics.themeCount,
  researchThemes:diagnostics.researchThemes,
  researchFailures:diagnostics.researchFailures,
  quality
}, null, 2));
