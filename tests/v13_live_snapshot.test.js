import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRows, selectCandidateFunnel, deriveLiveIndustryContext, normalizeDatedNews, classifyHeadlineCatalyst, buildPsychologySector, validateLiveSnapshot, applySnapshotQualityGate, isPreLimitUpCandidate, interleaveCodes, interleaveCatalystCodes, scoreCatalystConfirmed, buildWideNewsCandidate, flattenNewsPayload, buildStockNewsFallback } from '../research/v13-limitup-precursor/live_snapshot.js';

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
 assert.ok(validateLiveSnapshot(base).reasons.includes('deep-source-coverage-below-90-percent'));
 const missingBars={...base,quality:{deepSuccessPct:95,psychologyCoveragePct:80,datedNewsCoveragePct:0}};
 assert.equal(validateLiveSnapshot(missingBars).valid,false);
 assert.ok(validateLiveSnapshot(missingBars).reasons.includes('bar-history-coverage-below-90-percent'));
});
test('snapshot quality gate fails closed on incomplete sources',()=>{
 const s={schema:'v13-live-psychology-catalyst-snapshot-v1',snapshotId:'v13-1',capturedAt:'2026-10-22T06:00:00Z',asOf:'2026-10-22T06:00:00Z',candidates:Array.from({length:60},()=>({})),quality:{deepSuccessPct:95,barHistoryCoveragePct:95,psychologyCoveragePct:75}};
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
  quality:{deepSuccessPct:99,barHistoryCoveragePct:95,psychologyCoveragePct:80,datedNewsCoveragePct:0},
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
 const context=deriveLiveIndustryContext(rows);
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
