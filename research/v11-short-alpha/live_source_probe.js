import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import marketHandler from '../../api/market.js';
import psychologyHandler from '../../api/psychology_universe.js';
import { withResearchSources, invokeHandler, requireResponse } from './research_sources.js';

export function knownProbes() {
  const push = ['push2delay.eastmoney.com','push2.eastmoney.com','7.push2.eastmoney.com','43.push2.eastmoney.com','89.push2.eastmoney.com'];
  const hist = ['push2his.eastmoney.com','7.push2his.eastmoney.com','43.push2his.eastmoney.com'];
  const url = (host, path, params) => 'https://' + host + path + '?' + new URLSearchParams(params);
  const rank = {pn:'1',pz:'5',po:'1',np:'1',fid:'f6',fs:'m:0+t:6,m:1+t:2',fltt:'2',invt:'2',fields:'f12,f14,f2,f3,f5,f6,f8,f9,f10,f20,f21,f23,f24,f25,f62,f184,f100'};
  const concept = {...rank, fid:'f3',fs:'m:90+t:3+f:!50'};
  const probes = push.flatMap(host => [
    {purpose:'market-ranking',url:url(host,'/api/qt/clist/get',rank)},
    {purpose:'concept-ranking',url:url(host,'/api/qt/clist/get',concept)}
  ]);
  for (const host of hist) {
    probes.push({purpose:'stock-kline',url:url(host,'/api/qt/stock/kline/get',{
      secid:'1.600519',klt:'101',fqt:'1',beg:'20260101',end:'20500101',lmt:'35',
      fields1:'f1,f2,f3,f4,f5,f6',fields2:'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61'
    })});
    probes.push({purpose:'stock-flow',url:url(host,'/api/qt/stock/fflow/daykline/get',{
      secid:'1.600519',klt:'101',lmt:'20',fields1:'f1,f2,f3,f7',
      fields2:'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63'
    })});
  }
  probes.push({purpose:'sina-degraded-ranking',url:url('vip.stock.finance.sina.com.cn',
    '/quotes_service/api/json_v2.php/Market_Center.getHQNodeData',
    {page:'1',num:'10',sort:'changepercent',asc:'0',node:'hs_a',symbol:'',_s_r_a:'setlen'})});
  probes.push({purpose:'tencent-degraded-kline',url:'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600519,day,,,35,qfq'});
  probes.push({purpose:'theme-news',url:url('search-api-web.eastmoney.com','/search/jsonp',{
    cb:'v12Psychology',param:JSON.stringify({uid:'',keyword:'人工智能',type:['cmsArticleWebOld'],
      client:'web',clientType:'web',clientVersion:'curr',
      param:{cmsArticleWebOld:{searchScope:'default',sort:'default',pageIndex:1,pageSize:5,preTag:'',postTag:''}}})
  })});
  return probes;
}

export async function probeSources({fetchImpl = globalThis.fetch, handlers = {market:marketHandler, psychology:psychologyHandler}} = {}) {
  const diagnostics = [];
  const hostResults = [];
  let market = null, psychology = null;
  await withResearchSources(async () => {
    const probes = knownProbes();
    // Bounded batches: real requests to existing URLs, not new fallback contracts.
    for (let index = 0; index < probes.length; index += 4) {
      await Promise.all(probes.slice(index,index + 4).map(async probe => {
        try { await (await fetch(probe.url)).text(); hostResults.push({purpose:probe.purpose,host:new URL(probe.url).host,status:'AVAILABLE'}); }
        catch (error) { hostResults.push({purpose:probe.purpose,host:new URL(probe.url).host,status:'SOURCE_UNAVAILABLE',error:error.message}); }
      }));
    }
    try { market = requireResponse('ranked_candidates', await invokeHandler(handlers.market,'/api/market?action=ranked_candidates')); }
    catch (error) { market = {status:'SOURCE_UNAVAILABLE',error:error.message}; }
    const codes = (market.data?.candidates ?? []).map(row => String(row.f12)).filter(code => /^(00|60)\d{4}$/.test(code)).slice(0,8);
    try {
      if (codes.length < 5) throw new Error('insufficient real market candidates; no substitute candidate list');
      psychology = requireResponse('psychology_universe', await invokeHandler(handlers.psychology,
        '/api/psychology_universe?codes=' + codes.join(',')));
    } catch (error) { psychology = {status:'SOURCE_UNAVAILABLE',error:error.message}; }
  }, {fetchImpl,diagnostics,attempts:2,timeoutMs:4000});
  const themes = psychology.data?.themes ?? [];
  const diag = psychology.diagnostics ?? psychology.data?.diagnostics ?? {};
  const usable = (market.data?.candidates?.length ?? 0) >= 5 && (diag.conceptRows ?? 0) > 0 && themes.length > 0;
  return {schema:'v12-source-probe-v2',probedAt:new Date().toISOString(),
    status:usable ? 'AVAILABLE_WITH_QUALITY_CHECK_REQUIRED' : 'SOURCE_UNAVAILABLE',
    market:{candidateCount:market.data?.candidates?.length ?? 0,method:market.data?.method ?? market.method ?? null,
      listsOk:market.data?.listsOk ?? null,failures:market.data?.failures ?? [],error:market.error ?? null},
    psychology:{conceptRows:diag.conceptRows ?? 0,themeCount:themes.length,
      researchFailures:diag.researchFailures ?? null,error:psychology.error ?? null},
    hostResults,upstreamRequests:diagnostics,
    fallbackPolicy:'Sina/Tencent are diagnostics of existing degraded paths only; no new fallback is admitted as a qualified V12 sample.'};
}
async function main(args) {
  const report = await probeSources();
  const output = args.indexOf('--output');
  if (output >= 0) await writeFile(resolve(args[output + 1]),JSON.stringify(report,null,2) + '\n');
  console.log(JSON.stringify(report,null,2));
  if (report.status === 'SOURCE_UNAVAILABLE') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2));
