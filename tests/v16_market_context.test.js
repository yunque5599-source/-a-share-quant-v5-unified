import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeMarketUniverse, summarizeIndexKline, parseYahooDailyChange} from '../api/v16_market_context.js';

test('market universe summary labels complete breadth and approximate limit bands', () => {
  const rows = [
    {f12:'600001',f14:'普通A',f3:10,f6:1000,f62:100,f100:'半导体'},
    {f12:'300001',f14:'创业板A',f3:20,f6:2000,f62:200,f100:'半导体'},
    {f12:'600002',f14:'普通B',f3:-10,f6:1500,f62:-50,f100:'半导体'},
    {f12:'600003',f14:'ST样本',f3:5,f6:500,f62:10,f100:'半导体'},
    {f12:'600004',f14:'普通C',f3:1,f6:700,f62:30,f100:'半导体'}
  ];
  const result = summarizeMarketUniverse({rows,total:5,coverage:1,complete:true,pagesFetched:1,pageCount:1,failures:[]});
  assert.equal(result.breadth.universe,'full-market');
  assert.equal(result.breadth.fullMarket,true);
  assert.equal(result.breadth.up,4);
  assert.equal(result.breadth.down,1);
  assert.equal(result.sentiment.limitUpCount,3);
  assert.equal(result.sentiment.limitLabelQuality,'APPROXIMATE_PROXY');
  assert.equal(result.sentiment.brokenBoardRate,'NOT_MEASURABLE');
  assert.ok(result.sectors.length >= 1);
});

test('partial market universe is never labelled full-market breadth', () => {
  const result = summarizeMarketUniverse({
    rows:[{f12:'600001',f14:'普通A',f3:1,f6:100,f62:10,f100:'银行'}],
    total:5000,coverage:0.0002,complete:false,pagesFetched:1,pageCount:10,failures:[{page:2,error:'timeout'}]
  });
  assert.equal(result.breadth.universe,'partial-market');
  assert.equal(result.breadth.fullMarket,false);
  assert.ok(result.source.coveragePct < 1);
});

test('index daily bars calculate trend and moving-average context', () => {
  const klines = Array.from({length:25},(_,index)=>{
    const date = '2026-10-' + String(index+1).padStart(2,'0');
    const close = 100 + index;
    return [date,close-0.2,close,close+0.5,close-0.5,1000,100000].join(',');
  });
  const result = summarizeIndexKline({key:'shanghai',name:'上证指数',secid:'1.000001'},{data:{klines}});
  assert.equal(result.status,'AVAILABLE');
  assert.equal(result.close,124);
  assert.ok(result.changePct > 0);
  assert.ok(result.trend5Pct > 0);
  assert.ok(result.trend20Pct > 0);
  assert.equal(result.aboveMa5,true);
  assert.equal(result.aboveMa20,true);
});

test('Yahoo daily data excludes a US bar on the same China calendar date', () => {
  const payload = {chart:{result:[{
    meta:{exchangeTimezoneName:'America/New_York'},
    timestamp:[
      Date.parse('2026-11-03T05:00:00Z')/1000,
      Date.parse('2026-11-04T05:00:00Z')/1000,
      Date.parse('2026-11-05T05:00:00Z')/1000
    ],
    indicators:{quote:[{close:[100,98,105]}]}
  }]}};
  const result = parseYahooDailyChange(payload,'^IXIC','2026-11-05');
  assert.equal(result.status,'AVAILABLE');
  assert.equal(result.date,'2026-11-04');
  assert.equal(Number(result.pct.toFixed(2)),-2);
});

test('Yahoo data with only one eligible prior session is NOT_MEASURABLE', () => {
  const payload = {chart:{result:[{
    meta:{exchangeTimezoneName:'America/New_York'},
    timestamp:[Date.parse('2026-11-04T05:00:00Z')/1000,Date.parse('2026-11-05T05:00:00Z')/1000],
    indicators:{quote:[{close:[100,105]}]}
  }]}};
  const result = parseYahooDailyChange(payload,'NVDA','2026-11-05');
  assert.equal(result.status,'NOT_MEASURABLE');
});
