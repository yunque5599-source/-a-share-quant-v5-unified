import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRows, selectCandidateFunnel, normalizeDatedNews, buildPsychologySector, validateLiveSnapshot, interleaveCodes, flattenNewsPayload, buildStockNewsFallback } from '../research/v13-limitup-precursor/live_snapshot.js';

test('parsers exclude future-dated rows and sort history',()=>{
 const bars=parseRows(['2026-10-21,10,10.5,10.6,9.9,200,2100000,0,0,0,4.2','2026-10-19,9,9.2,9.3,8.9,100,920000,0,0,0,2.1','2026-10-22,10.5,11,11.1,10.4,300,3300000,0,0,0,5.1'],'bar','2026-10-21T05:00:00Z');
 assert.deepEqual(bars.map(x=>x.date),['2026-10-19','2026-10-21']);assert.equal(bars[1].turnoverRate,4.2);
 const flows=parseRows(['2026-10-21,5000,0,0,0,0,2.4,0,0,0,0,0,0','2026-10-22,9000,0,0,0,0,5.0,0,0,0,0,0,0'],'flow','2026-10-21T05:00:00Z');
 assert.equal(flows.length,1);assert.equal(flows[0].mainNet,5000);assert.equal(flows[0].mainPct,2.4);
});
test('funnel diversifies consensus, momentum and capital-flow candidates and excludes ST',()=>{
 const rows=Array.from({length:200},(_,i)=>({f12:String(600000+i),f14:'样本'+i,rankScore:100-i/2,rankHits:i%4,f3:i,f62:i*1000}));
 rows.push({f12:'600999',f14:'*ST risk',rankScore:1000,f3:10,f62:10000});
 const result=selectCandidateFunnel(rows,120);assert.equal(result.length,120);assert.ok(!result.some(x=>x.f12==='600999'));
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
test('snapshot quality gate fails closed on incomplete sources',()=>{
 const s={schema:'v13-live-psychology-catalyst-snapshot-v1',snapshotId:'v13-1',capturedAt:'2026-10-22T06:00:00Z',asOf:'2026-10-22T06:00:00Z',candidates:Array.from({length:60},()=>({})),quality:{deepSuccessPct:95,barHistoryCoveragePct:95,psychologyCoveragePct:75}};
 assert.equal(validateLiveSnapshot(s).valid,true);assert.equal(validateLiveSnapshot({...s,quality:{...s.quality,psychologyCoveragePct:20}}).valid,false);
});

test('balanced shortlist interleaves momentum and early-opportunity ranks without duplicates',()=>{
 const result=interleaveCodes(['A','B','C','D'],['X','B','Y','Z'],6);
 assert.deepEqual(result,['A','X','B','Y','C','Z']);
 assert.equal(new Set(result).size,result.length);
});

test('stock-news fallback only scores timestamp-verified headlines and flags its limited semantics',()=>{
 const rows=flattenNewsPayload({result:{cmsArticleWebOld:{list:[
  {title:'Timed headline',date:'2026-10-22 10:00:00',mediaName:'Wire',url:'https://example.com/a'},
  {title:'Untimed headline',url:'https://example.com/b'}
 ]}}});
 assert.equal(rows.length,2);
 const out=buildStockNewsFallback('600001','样本股',rows,'2026-10-22T06:00:00Z');
 assert.equal(out.overlay.datedNewsCount,1);
 assert.ok(Number.isFinite(out.sector.catalystScore));
 assert.ok(out.overlay.warnings.some(x=>x.includes('no validated sentiment')));
});
