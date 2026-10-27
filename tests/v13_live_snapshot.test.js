import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRows, isDailyBarCompleteAt, mapUniverseRowsToRankCandidates, selectCandidateFunnel, deriveLiveIndustryContext, normalizeDatedNews, classifyHeadlineCatalyst, buildPsychologySector, validateLiveSnapshot, applySnapshotQualityGate, isEntryReadyCandidate, isPreLimitUpCandidate, interleaveCodes, interleaveCatalystCodes, scoreCatalystConfirmed, buildWideNewsCandidate, flattenNewsPayload, buildStockNewsFallback, selectWideNewsScanUniverse, summarizePsychologySourceDiagnostics } from '../research/v13-limitup-precursor/live_snapshot.js';
import { buildNextSessionPlan, evaluateNextSessionEntry } from '../research/v13-limitup-precursor/next_session_plan.js';
import { buildNextDayActionPlan } from '../research/v13-limitup-precursor/next_day_action_plan.js';

test('parsers exclude future-dated rows and sort history',()=>{
 const bars=parseRows(['2026-10-21,10,10.5,10.6,9.9,200,2100000,0,0,0,4.2','2026-10-19,9,9.2,9.3,8.9,100,920000,0,0,0,2.1','2026-10-22,10.5,11,11.1,10.4,300,3300000,0,0,0,5.1'],'bar','2026-10-21T05:00:00Z');
 assert.deepEqual(bars.map(x=>x.date),['2026-10-19','2026-10-21']);assert.equal(bars[1].turnoverRate,4.2);
 const flows=parseRows(['2026-10-21,5000,0,0,0,0,2.4,0,0,0,0,0,0','2026-10-22,9000,0,0,0,0,5.0,0,0,0,0,0,0'],'flow','2026-10-21T05:00:00Z');
 assert.equal(flows.length,1);assert.equal(flows[0].mainNet,5000);assert.equal(flows[0].mainPct,2.4);
});
test('funnel diversifies consensus, momentum and capital-flow candidates and excludes ST',()=>{
 const rows=Array.from({length:200},(_,i)=>({f12:String(600000+i),f14:'样本'+i,rankScore:100-i/2,rankHits:i%4,f3:i,f62:i*1000}));
 rows.push({f12:'600999',f14:'*ST risk',rankScore:1000,f3:10,f62:10000});
 rows.push({f12:'000556',f14:'PT南洋',rankScore:999,f3:20,f62:20000});
 const result=selectCandidateFunnel(rows,120);assert.equal(result.length,120);assert.ok(!result.some(x=>x.f12==='600999'));assert.ok(!result.some(x=>x.f12==='000556'));
 assert.ok(result.some(x=>x.funnelLanes.includes('price-momentum')));assert.ok(result.some(x=>x.funnelLanes.includes('capital-inflow')));
});
test('untimed or future news is not used as a point-in-time catalyst',()=>{
 const news=normalizeDatedNews([{code:'AI',name:'AI',news:[{title:'Untimed'},{title:'Before',publishedAt:'2026-10-21T03:00:00Z'},{title:'After',publishedAt:'2026-10-22T08:00:00Z'}]}],'2026-10-22T06:00:00Z');
 assert.equal(news.length,3);assert.equal(news[0].usableAsPointInTimeCatalyst,false);assert.equal(news[1].usableAsPointInTimeCatalyst,true);assert.equal(news[2].usableAsPointInTimeCatalyst,false);
});
test('psychology-derived catalyst score requires a timestamp-verified news item',()=>{
 const base={code:'BK001',name:'AI theme',asOf:'2026-10-22T05:00:00Z',changePct:2,change5dPct:5,mainNetPct:1.5,upCount:70,downCount:20,memberCount:100,limitUpCount:4,leaderStatus:'leader',candidateRank:1,narrativeScore:80,imaginationScore:90};
 assert.equal(buildPsychologySector([{...base,news:[{title:'No date'}]}],'2026-10-22T06:00:00Z').sector.catalystScore,undefined);
 assert.equal(buildPsychologySector([{...base,news:[{title:'Dated',publishedAt:'2026-10-22T04:00:00Z'}]}],'2026-10-22T06:00:00Z').sector.catalystScore,85);
});
test('snapshot quality gate rejects missing coverage metrics rather than treating them as zero-risk',()=>{
 const base={schema:'v13-live-psychology-catalyst-snapshot-v1',snapshotId:'v13-missing-quality',
  capturedAt:'2026-10-22T06:00:00Z',asOf:'2026-10-22T06:00:00Z',
  candidates:Array.from({length:60},()=>({})),
  quality:{barHistoryCoveragePct:95,psychologyCoveragePct:80,datedNewsCoveragePct:0}};
 assert.equal(validateLiveSnapshot(base).valid,false);
 assert.ok(validateLiveSnapshot(base).reasons.includes('deep-source-coverage-metric-missing'));
  assert.ok(validateLiveSnapshot(base).reasons.includes('flow-signal-coverage-below-90-percent'));
 const missingBars={...base,quality:{deepSuccessPct:95,psychologyCoveragePct:80,datedNewsCoveragePct:0}};
 assert.equal(validateLiveSnapshot(missingBars).valid,false);
 assert.ok(validateLiveSnapshot(missingBars).reasons.includes('bar-history-coverage-below-90-percent'));
});
test('snapshot quality gate fails closed on incomplete sources',()=>{
 const s={schema:'v13-live-psychology-catalyst-snapshot-v1',snapshotId:'v13-1',capturedAt:'2026-10-22T06:00:00Z',asOf:'2026-10-22T06:00:00Z',candidates:Array.from({length:60},()=>({})),quality:{deepSuccessPct:95,barHistoryCoveragePct:95,flowSignalCoveragePct:95,psychologyCoveragePct:75}};
 assert.equal(validateLiveSnapshot(s).valid,true);assert.equal(validateLiveSnapshot({...s,quality:{...s.quality,psychologyCoveragePct:20}}).valid,false);
 const fallback=validateLiveSnapshot({...s,quality:{...s.quality,psychologyCoveragePct:0,datedNewsCoveragePct:82}});
 assert.equal(fallback.valid,true);assert.equal(fallback.status,'CAPTURED_WITH_NEWS_FALLBACK');
});

test('balanced shortlist interleaves momentum and early-opportunity ranks without duplicates',()=>{
 const result=interleaveCodes(['A','B','C','D'],['X','B','Y','Z'],6);
 assert.deepEqual(result,['A','X','B','Y','C','Z']);
 assert.equal(new Set(result).size,result.length);
});

test('unclassified recent news is retained for audit but does not receive a positive catalyst score',()=>{
 const rows=flattenNewsPayload({result:{cmsArticleWebOld:{list:[
  {title:'Timed headline',date:'2026-10-22 05:00:00',mediaName:'Wire',url:'https://example.com/a'},
  {title:'Untimed headline',url:'https://example.com/b'}
 ]}}});
 assert.equal(rows.length,2);
 const out=buildStockNewsFallback('600001','样本股',rows,'2026-10-22T06:00:00Z');
 assert.equal(out.overlay.datedNewsCount,1);
 assert.equal(out.sector.catalystScore,undefined);
 assert.equal(out.overlay.headlineCatalystScore,null);
 assert.ok(Number.isFinite(out.overlay.newsRecencyScore));
 assert.ok(out.overlay.warnings.some(x=>x.includes('rule-based headline classification is experimental')));
});

test('timestamp-verified positive and negative headline events are classified separately',()=>{
 const positive=classifyHeadlineCatalyst('公司AI赋能数字户外媒体业务发布并实现新业务落地');
 const realWorldStyle=classifyHeadlineCatalyst('兆讯传媒“跃然AI”发布 推进户外大屏内容服务AI化转型');
 const negative=classifyHeadlineCatalyst('公司被立案调查并收到行政处罚');
 const neutral=classifyHeadlineCatalyst('公司召开年度普通股东大会');
 assert.equal(positive.direction,'positive');
 assert.equal(realWorldStyle.direction,'positive');
 assert.ok(realWorldStyle.positiveCategories.includes('product_or_capacity'));
 assert.ok(positive.score>=60);
 assert.equal(negative.direction,'negative');
 assert.ok(negative.score<=40);
 assert.equal(neutral.direction,'unclassified');
 assert.equal(neutral.score,null);
 const out=buildStockNewsFallback('301102','兆讯传媒',[
  {title:'公司AI赋能数字户外媒体业务发布并实现新业务落地',publishedAt:'2026-10-22T04:00:00Z'},
  {title:'公司被立案调查并收到行政处罚',publishedAt:'2026-10-22T05:00:00Z'},
  {title:'公司中标重大合同',publishedAt:'2026-10-22T07:00:00Z'}
 ],'2026-10-22T06:00:00Z');
 assert.equal(out.overlay.datedNewsCount,2);
 assert.equal(out.overlay.positiveHeadlineCount,1);
 assert.equal(out.overlay.negativeHeadlineCount,1);
 assert.equal(out.overlay.catalystEvidence.some(x=>x.title.includes('中标重大合同')),false);
});


test('entry-ready gate is explicit and does not equate discovery with an entry',()=>{
 assert.equal(isEntryReadyCandidate({entryEligible:true}),true);
 assert.equal(isEntryReadyCandidate({entryEligible:false}),false);
 assert.equal(isEntryReadyCandidate({}),false);
});

test('overextended stocks are excluded from the early actionable shortlist but remain diagnosable',()=>{
 const extendedChiNext={code:'300839',currentPct:20,features:{r5Pct:64,distHigh20Pct:16},quote:{pct:20}};
 const earlyMainBoard={code:'600406',currentPct:2.15,features:{r5Pct:3.29,distHigh20Pct:0.65},quote:{pct:2.15}};
 assert.equal(isPreLimitUpCandidate(extendedChiNext,{stage:'extended'}),false);
 assert.equal(isPreLimitUpCandidate(earlyMainBoard,{stage:'early-base'}),true);
 assert.equal(isPreLimitUpCandidate({code:'600001',quote:{pct:8},features:{r5Pct:10,distHigh20Pct:4}}, {stage:'early-base'}),false);
 assert.equal(isPreLimitUpCandidate({code:'300001',quote:{pct:3},features:{r5Pct:27,distHigh20Pct:4}}, {stage:'early-base'}),false);
});

test('invalid source quality suppresses all recommendation rankings and preserves them as diagnostics',()=>{
 const snapshot={
  schema:'v13-live-psychology-catalyst-snapshot-v1',snapshotId:'v13-invalid',capturedAt:'2026-10-22T06:00:00Z',
  asOf:'2026-10-22T06:00:00Z',candidates:Array.from({length:60},()=>({})),
  quality:{deepSuccessPct:99,barHistoryCoveragePct:95,psychologyCoveragePct:0,datedNewsCoveragePct:0},
  rankings:{overall:[{code:'300839',name:'已大涨股票'}],trendTransition:[{code:'600001'}],emotionRepair:[{code:'300006'}]}
 };
 const result=applySnapshotQualityGate(snapshot);
 assert.equal(result.recommendationsAvailable,false);
 assert.equal(result.recommendationStatus,'SOURCE_UNAVAILABLE');
 assert.deepEqual(result.rankings,{overall:[],trendTransition:[],emotionRepair:[]});
 assert.equal(result.diagnosticRankings.overall[0].code,'300839');
});

test('valid source quality leaves gated rankings available',()=>{
 const snapshot={
  schema:'v13-live-psychology-catalyst-snapshot-v1',snapshotId:'v13-valid',capturedAt:'2026-10-22T06:00:00Z',
  asOf:'2026-10-22T06:00:00Z',candidates:Array.from({length:60},()=>({})),
  quality:{deepSuccessPct:99,barHistoryCoveragePct:95,flowSignalCoveragePct:95,psychologyCoveragePct:80,datedNewsCoveragePct:0},
  rankings:{overall:[{code:'600406',name:'测试股'}]}
 };
 const result=applySnapshotQualityGate(snapshot);
 assert.equal(result.recommendationsAvailable,true);
 assert.equal(result.recommendationStatus,'CAPTURED');
 assert.equal(result.rankings.overall[0].code,'600406');
});


test('timezone-naive A-share news timestamps are interpreted as China Standard Time',()=>{
 const rows=normalizeDatedNews([{code:'301102',name:'兆讯传媒',news:[
  {title:'Before cutoff',publishedAt:'2026-10-22 13:30:00'},
  {title:'After cutoff',publishedAt:'2026-10-22 14:30:00'},
  {title:'Date only',publishedAt:'2026-10-21'}
 ]}],'2026-10-22T06:00:00Z');
 assert.equal(rows[0].usableAsPointInTimeCatalyst,true);
 assert.equal(rows[0].publishedAt,'2026-10-22T05:30:00.000Z');
 assert.equal(rows[1].usableAsPointInTimeCatalyst,false);
 assert.equal(rows[2].usableAsPointInTimeCatalyst,true);
 assert.equal(rows[2].publishedAt,'2026-10-20T16:00:00.000Z');
});


test('catalyst-confirmed ranking requires verified positive news and a pre-limit-up eligible technical candidate',()=>{
 const base={code:'301102',name:'兆讯传媒',board:'CHINEXT',score:72,currentPct:3.2,
  components:{trend:70,volumePrice:82,flow:65,sector:75},
  features:{r3Pct:4.5,r5Pct:8.2}};
 const candidate={code:'301102',name:'兆讯传媒',board:'CHINEXT',headlineCatalystScore:78,
  headlineCatalystDirection:'positive',timestampVerified:true,preLimitUpEligible:true,
  quote:{pct:3.2},base,catalystEvidence:[{title:'AI产品发布',publishedAt:'2026-10-22T01:00:00Z'}]};
 const ranked=scoreCatalystConfirmed(candidate);
 assert.ok(ranked);
 assert.equal(ranked.code,'301102');
 assert.ok(ranked.score>70);
 assert.equal(scoreCatalystConfirmed({...candidate,timestampVerified:false}),null);
 assert.equal(scoreCatalystConfirmed({...candidate,headlineCatalystDirection:'mixed'}),null);
 assert.equal(scoreCatalystConfirmed({...candidate,preLimitUpEligible:false}),null);
});

test('catalyst blend reserves a limited share for event-confirmed candidates without duplicates',()=>{
 const result=interleaveCatalystCodes(
  ['A','B','C','D','E','F','G','H','I','J','K','L'],
  ['X','Y','B','Z'],10,2
 );
 assert.equal(result.length,10);
 assert.equal(new Set(result).size,10);
 assert.ok(result.includes('X'));
 assert.ok(result.includes('Y'));
 assert.ok(result.includes('A'));
});


test('live industry fallback ranks sector breadth, limit-up participation and within-sector leaders',()=>{
 const rows=[
  {f12:'600001',f14:'传媒A',f100:'传媒',f3:3.0},
  {f12:'600002',f14:'传媒B',f100:'传媒',f3:1.5},
  {f12:'300001',f14:'传媒C',f100:'传媒',f3:19.98},
  {f12:'600003',f14:'银行A',f100:'银行',f3:-1.0},
  {f12:'600004',f14:'银行B',f100:'银行',f3:-0.5},
  {f12:'600005',f14:'银行C',f100:'银行',f3:0.1}
 ];
 const context=deriveLiveIndustryContext([...rows,...rows.slice(0,3)]);
 assert.ok(context.get('300001').themeHeat>context.get('600003').themeHeat);
 assert.equal(context.get('300001').limitUpCount,1);
 assert.ok(context.get('300001').leaderScore>context.get('600001').leaderScore);
 assert.equal(context.get('300001').industryMemberCount,3);
 assert.equal(context.get('300001').contextSource,'ranked-universe-cross-sectional-proxy');
});


test('wide-universe catalyst scan admits only dated positive headlines known at capture time',()=>{
 const stock={code:'301102',name:'兆讯传媒',board:'CHINEXT',industry:'广告营销'};
 const positive={title:'公司AI产品发布并推动新业务落地',publishedAt:'2026-10-21T00:30:00Z',url:'https://example.com/a'};
 const future={title:'公司中标重大合同',publishedAt:'2026-10-22T08:00:00Z',url:'https://example.com/b'};
 const result=buildWideNewsCandidate(stock,[positive,future],'2026-10-21T01:00:00Z');
 assert.ok(result);
 assert.equal(result.code,'301102');
 assert.equal(result.datedNewsCount,1);
 assert.equal(result.catalystEvidence.length,1);
 assert.equal(buildWideNewsCandidate(stock,[future],'2026-10-21T01:00:00Z'),null);
 assert.equal(buildWideNewsCandidate({...stock,name:'*ST风险'},[positive],'2026-10-21T01:00:00Z'),null);
});


test('live early-opportunity scoring treats the current session candle as partial',()=>{
 assert.equal(isDailyBarCompleteAt('2026-10-22T01:20:00Z'),true);  // 09:20 China time
 assert.equal(isDailyBarCompleteAt('2026-10-22T02:30:00Z'),false); // 10:30 China time
 assert.equal(isDailyBarCompleteAt('2026-10-22T06:59:00Z'),false); // 14:59 China time
 assert.equal(isDailyBarCompleteAt('2026-10-22T07:00:00Z'),true);  // 15:00 China time
 assert.equal(isDailyBarCompleteAt('invalid'),false);
});


test('degraded ranked feed can be replaced by a full-universe live quote candidate set',()=>{
 const mapped=mapUniverseRowsToRankCandidates([
  {code:'600001',name:'正常A',industry:'传媒',board:'SH_MAIN',price:10,pct:2.5,amount:100000000,turnoverRate:4,mainNet:5000000,mainPct:5},
  {code:'300001',name:'正常B',industry:'传媒',board:'CHINEXT',price:12,pct:19.8,amount:200000000,turnoverRate:15,mainNet:30000000,mainPct:15},
  {code:'000556',name:'PT南洋',industry:'其他',price:1,pct:5,amount:10000000,turnoverRate:2,mainNet:0,mainPct:0},
  {code:'600002',name:'*ST风险',industry:'其他',price:2,pct:4,amount:10000000,turnoverRate:2,mainNet:0,mainPct:0},
  {code:'600003',name:'缺价格',industry:'其他',price:null,pct:4,amount:10000000,turnoverRate:2,mainNet:0,mainPct:0}
 ]);
 assert.equal(mapped.length,2);
 const normal=mapped.find(row=>row.f12==='600001');
 const highMomentum=mapped.find(row=>row.f12==='300001');
 assert.equal(normal.f100,'传媒');
 assert.equal(normal.f3,2.5);
 assert.equal(normal.f62,5000000);
 assert.ok(mapped.every(row=>Number.isFinite(row.rankScore)));
 assert.ok(highMomentum.rankScore>normal.rankScore);
 assert.equal(mapped[0].f12,'300001');
});


test('wide catalyst news prescreen samples liquidity, flow, swing momentum and early daily moves across boards',()=>{
 const rows=Array.from({length:100},(_,i)=>({
  code:String(600000+i),name:'样本'+i,amount:100000000-i*100000,
  mainNet:5000000-i*100000,mainPct:4-i*.03,pct60:30-i*.2,
  pct:i%12,turnoverRate:3+(i%10)
 }));
 rows.push({code:'301159',name:'创业板样本',amount:25000000,mainNet:900000000,mainPct:22,pct60:120,pct:2.4,turnoverRate:8});
 rows.push({code:'600999',name:'*ST风险',amount:999000000,mainNet:999000000,mainPct:99,pct60:200,pct:9,turnoverRate:30});
 const result=selectWideNewsScanUniverse(rows,24);
 assert.equal(result.rows.length,24);
 assert.equal(new Set(result.rows.map(x=>x.code)).size,24);
 assert.ok(result.rows.some(x=>x.code==='301159'));
 assert.ok(!result.rows.some(x=>x.code==='600999'));
 assert.ok(result.laneCounts.liquidity>0);
 assert.ok(result.laneCounts['capital-inflow']>0);
 assert.ok(result.laneCounts['swing-momentum']>0);
});


test('candidate funnel reserves capacity for main-board names when growth-board momentum dominates',()=>{
 const rows=[];
 for(let i=0;i<100;i++)rows.push({
  f12:String(300000+i),f14:'成长板样本'+i,rankScore:300-i,rankHits:100-i,
  f3:20-i*.1,f62:1000000000-i*1000
 });
 for(let i=0;i<100;i++)rows.push({
  f12:String(600000+i),f14:'主板样本'+i,rankScore:100-i,rankHits:i%3,
  f3:1-i*.01,f62:1000000-i*1000
 });
 const result=selectCandidateFunnel(rows,60);
 const mainBoard=result.filter(row=>['SH_MAIN','SZ_MAIN'].includes(row.board));
 assert.equal(result.length,60);
 assert.ok(mainBoard.length>=10,'main-board candidates should retain dedicated funnel capacity');
 assert.ok(mainBoard.some(row=>row.funnelLanes.some(lane=>lane.startsWith('main-board-'))));
});


test('psychology source diagnostics aggregate providers and preserve degraded batch warnings',()=>{
 const summary=summarizePsychologySourceDiagnostics([
  {batchIndex:1,codes:['000001','600000'],status:'SOURCE_COVERAGE_AVAILABLE',degraded:false,
   conceptSource:'eastmoney',membershipSource:'eastmoney',quoteSource:'eastmoney',
   selectedThemesPerStock:1,maxResearchThemes:10,
   conceptRankingCacheHit:false,conceptRankingCacheAgeMs:0,
   requestedCodes:2,conceptRows:100,quoteRows:2,themeCount:4,researchThemes:3,
   membershipFailures:0,flowFailures:0,researchFailures:1,themeMemberFailures:0,themeNewsFailures:1,
   themeRequestFailureSamples:[],sourceFailures:[],sourceWarnings:[]},
  {batchIndex:2,codes:['600519'],status:'DEGRADED_SOURCE_COVERAGE',degraded:true,
   conceptSource:'sina-node-aggregate',membershipSource:'10jqka-stock-concepts-mapped-to-sina',quoteSource:'tencent',
   selectedThemesPerStock:1,maxResearchThemes:10,
   conceptRankingCacheHit:true,conceptRankingCacheAgeMs:1500,
   requestedCodes:1,conceptRows:5,quoteRows:1,themeCount:2,researchThemes:2,
   membershipFailures:1,flowFailures:2,researchFailures:1,themeMemberFailures:1,themeNewsFailures:0,
   themeRequestFailureSamples:[{source:'theme-members',themeCode:'BK123',error:'HTTP 502'}],
   sourceFailures:['concept-ranking-eastmoney: unavailable'],sourceWarnings:['sampled board constituents']}
 ]);
 assert.equal(summary.batchCount,2);
 assert.equal(summary.degradedBatchCount,1);
 assert.deepEqual(summary.sourceCounts.concept,{eastmoney:1,'sina-node-aggregate':1});
 assert.deepEqual(summary.sourceCounts.quotes,{eastmoney:1,tencent:1});
 assert.equal(summary.totals.requestedCodes,3);
 assert.equal(summary.totals.conceptRows,105);
 assert.equal(summary.totals.flowFailures,2);
 assert.equal(summary.totals.themeMemberFailures,1);
 assert.equal(summary.totals.themeNewsFailures,1);
 assert.equal(summary.totals.conceptRankingCacheHitCount,1);
 assert.equal(summary.batches[0].candidateCount,2);
 assert.equal(summary.batches[1].conceptRankingCacheHit,true);
 assert.equal(summary.batches[1].conceptRankingCacheAgeMs,1500);
 assert.equal(summary.batches[1].themeMemberFailures,1);
 assert.equal(summary.batches[1].themeNewsFailures,0);
 assert.equal(summary.batches[1].selectedThemesPerStock,1);
 assert.equal(summary.batches[1].maxResearchThemes,10);
 assert.deepEqual(summary.batches[1].sourceWarnings,['sampled board constituents']);
 assert.deepEqual(summary.batches[1].themeRequestFailureSamples,[{source:'theme-members',themeCode:'BK123',error:'HTTP 502'}]);
});



test('next-session plan distinguishes core candidates from watch-only ranks and rejects chasing near limit-up', () => {
  const core = buildNextSessionPlan({
    code:'600558',name:'大西洋',board:'SH_MAIN',asOf:'2026-10-26',score:84,
    quote:{pct:3.2},selection:{eligible:true,decision:'CORE_WATCH'}
  },{signalDate:'2026-10-26',lane:'coreSelection'});
  assert.equal(core.status,'WAIT_NEXT_SESSION_CONFIRMATION');
  assert.equal(core.riskRules.automaticOrderPlacement,false);
  assert.equal(core.entryRules.preferredOpeningGapPct.max,3);

  const extended = buildNextSessionPlan({
    code:'600558',name:'大西洋',board:'SH_MAIN',quote:{pct:9.8},
    selection:{eligible:true,decision:'CORE_WATCH'}
  },{lane:'coreSelection'});
  assert.equal(extended.status,'NO_CHASE_EXTENDED');

  const generalRank = buildNextSessionPlan({
    code:'000156',name:'华数传媒',board:'SZ_MAIN',quote:{pct:1.2},score:77
  },{lane:'overall'});
  assert.equal(generalRank.status,'RANKING_WATCH_ONLY');
});

test('next-session entry evaluator refuses a limit-up chase and high opening gap', () => {
  const candidate={code:'600558',name:'大西洋',board:'SH_MAIN',selection:{eligible:true,decision:'CORE_WATCH'}};
  const limitUp=evaluateNextSessionEntry(candidate,{
    openingGapPct:9.5,currentPct:10,limitUpLocked:true,priceHoldsVwap:true,
    breakoutOrRetestConfirmed:true,themeAndFlowConfirmed:true
  });
  assert.equal(limitUp.status,'NO_CHASE_LIMIT_UP');

  const gap=evaluateNextSessionEntry(candidate,{
    openingGapPct:5.4,currentPct:5.8,quoteValid:true,themeDataValid:true,
    priceHoldsVwap:true,breakoutOrRetestConfirmed:true,themeAndFlowConfirmed:true
  });
  assert.equal(gap.status,'NO_CHASE_GAP_TOO_HIGH');
});

test('next-session entry evaluator waits for confirmation and requires all core conditions', () => {
  const candidate={code:'600558',name:'大西洋',board:'SH_MAIN',selection:{eligible:true,decision:'CORE_WATCH'}};
  const waiting=evaluateNextSessionEntry(candidate,{
    openingGapPct:1.2,currentPct:2.1,quoteValid:true,themeDataValid:true,
    priceHoldsVwap:true,breakoutOrRetestConfirmed:false,themeAndFlowConfirmed:true
  });
  assert.equal(waiting.status,'WAIT_FOR_CONFIRMATION');

  const confirmed=evaluateNextSessionEntry(candidate,{
    openingGapPct:1.2,currentPct:2.1,quoteValid:true,themeDataValid:true,
    priceHoldsVwap:true,breakoutOrRetestConfirmed:true,themeAndFlowConfirmed:true
  });
  assert.equal(confirmed.status,'SETUP_CONFIRMED_FOR_REVIEW');
  assert.equal(confirmed.automaticOrderPlacement,false);
});

test('next-session entry evaluator invalidates a broken setup and blocks degraded sources', () => {
  const candidate={code:'000156',name:'华数传媒',board:'SZ_MAIN',selection:{eligible:true,decision:'CORE_WATCH'}};
  const invalid=evaluateNextSessionEntry(candidate,{previousLowBroken:true});
  assert.equal(invalid.status,'INVALIDATED');

  const degraded=evaluateNextSessionEntry(candidate,{sourceDegraded:true});
  assert.equal(degraded.status,'OBSERVE_DATA_LIMITED');
});


test('next-day action plan distinguishes a missed prior-day limit-up signal from a weakened alternative', () => {
  const previous = {
    snapshotId:'previous-close',
    asOf:'2026-10-26T15:00:00+08:00',
    recommendationsAvailable:true,
    rankings:{
      coreSelection:[],
      overall:[{code:'600558',name:'大西洋',rank:2,score:82,quote:{pct:2.4},entryEligible:true,entryGateReasons:[]}],
      preBreakoutWatch:[]
    },
    candidates:[{code:'600558',name:'大西洋',score:{score:82,entryEligible:true},quote:{pct:2.4}}]
  };
  const current = {
    snapshotId:'current-close',
    asOf:'2026-10-27T15:00:00+08:00',
    recommendationsAvailable:true,
    rankings:{
      coreSelection:[],
      overall:[
        {code:'600558',name:'大西洋',rank:3,score:90,quote:{pct:10.07},entryEligible:false,entryGateReasons:['daily-move-cap']},
        {code:'000156',name:'华数传媒',rank:1,score:78,quote:{pct:-3.2},entryEligible:false,entryGateReasons:['weak-sector-flow']}
      ],
      preBreakoutWatch:[]
    },
    candidates:[
      {code:'600558',name:'大西洋',score:{score:90,entryEligible:false,entryGateReasons:['daily-move-cap']},quote:{pct:10.07}},
      {code:'000156',name:'华数传媒',score:{score:78,entryEligible:false,entryGateReasons:['weak-sector-flow']},quote:{pct:-3.2}}
    ]
  };
  const plan=buildNextDayActionPlan(current,previous);
  assert.equal(plan.status,'CURRENT_AND_PRIOR_REVIEW');
  const atlantic=plan.priorDayFollowThrough.find(row=>row.code==='600558');
  assert.equal(atlantic.followThrough,'LIMIT_UP_OR_NEAR_LIMIT');
  assert.equal(atlantic.action,'NO_CHASE');
  const huashu=plan.currentActions.find(row=>row.code==='000156');
  assert.equal(huashu.action,'WEAKENED_REASSESS_RISK');
  assert.equal(huashu.entryEligible,false);
});

test('next-day action plan does not treat same-session snapshots as previous-day follow-through', () => {
  const snapshot={
    snapshotId:'same-session',
    asOf:'2026-10-27T12:00:00+08:00',
    recommendationsAvailable:true,
    rankings:{coreSelection:[],overall:[{code:'600558',name:'大西洋',rank:1,score:80}],preBreakoutWatch:[]},
    candidates:[]
  };
  const plan=buildNextDayActionPlan(snapshot,snapshot);
  assert.equal(plan.status,'CURRENT_ONLY_NO_PRIOR_SNAPSHOT');
  assert.equal(plan.priorSnapshotAvailable,false);
  assert.equal(plan.priorDayFollowThrough.length,0);
});
