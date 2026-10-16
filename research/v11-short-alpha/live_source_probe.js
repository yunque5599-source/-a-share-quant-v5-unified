import handler from '../../api/psychology_universe.js';

function invoke(url) {
  return new Promise((resolve, reject) => {
    let body = '';
    const req = {method:'GET', url};
    const res = {
      statusCode:200,
      setHeader() {},
      end(value = '') {
        body = String(value);
        resolve({statusCode:this.statusCode, body});
      }
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

const codes = process.env.V12_PROBE_CODES || '600519,000001';
const result = await invoke('/api/psychology_universe?codes=' + encodeURIComponent(codes));

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
  schema:payload.schema,
  asOf:payload.asOf,
  requestedCodes:diagnostics.requestedCodes,
  conceptRows:diagnostics.conceptRows,
  themeCount:diagnostics.themeCount,
  researchThemes:diagnostics.researchThemes,
  researchFailures:diagnostics.researchFailures,
  quality
}, null, 2));
