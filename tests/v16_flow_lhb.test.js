import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeLimitPoolRows,
  summarizeLimitPools,
  normalizeLhbDailyRows,
  normalizeLhbSeatRows,
  summarizeLhbContext,
  evaluateNextDayLimitUpPremium,
  scoreCandidateFundingEvidence,
  rankFundingCandidates
} from '../research/v16/flow_lhb.js';

test('exact limit pools expose board ladder and broken-board rate without percentage proxies',()=>{
  const result=summarizeLimitPools({
    tradeDate:'2026-11-18',
    limitUpRows:[
      {c:'600001',n:'一板股',p:10000,zdp:10,lbc:1,fbt:93000,zbc:0,fund:5000000,hs:4},
      {c:'000002',n:'二板股',p:20000,zdp:10,lbc:2,fbt:100000,zbc:1,fund:8000000,hs:12},
      {c:'000003',n:'三板股',p:30000,zdp:10,lbc:3,fbt:94500,zbc:0,fund:9000000,hs:8}
    ],
    brokenRows:[
      {c:'000004',n:'炸板股',zdp:7.2,zbc:2,hs:18},
      {c:'000005',n:'另一炸板',zdp:6.8,zbc:1,hs:15}
    ],
    limitDownRows:[{c:'600006',n:'跌停股',zdp:-10}],
  });
  assert.equal(result.status,'AVAILABLE');
  assert.equal(result.limitUpCount,3);
  assert.equal(result.brokenBoardCount,2);
  assert.equal(result.limitDownCount,1);
  assert.equal(result.highestBoard,3);
  assert.deepEqual(result.ladder,[{board:1,count:1,label:'1板'},{board:2,count:1,label:'2板'},{board:3,count:1,label:'3板'}]);
  assert.equal(result.brokenBoardRate,0.4);
  assert.equal(result.limitUp[0].price,10);
  assert.equal(result.totalSealFundCny,22000000);
});

test('partial pool coverage remains partial and missing counts stay null',()=>{
  const result=summarizeLimitPools({
    tradeDate:'2026-11-18',
    limitUpRows:[{c:'600001',n:'一板股',lbc:1}],
    brokenRows:null,
    limitDownRows:[{c:'600002',n:'跌停股'}],
    sourceStatus:{limitUp:'AVAILABLE',broken:'NOT_MEASURABLE',limitDown:'AVAILABLE'}
  });
  assert.equal(result.status,'PARTIAL');
  assert.equal(result.limitUpCount,1);
  assert.equal(result.brokenBoardCount,null);
  assert.equal(result.brokenBoardRate,null);
});

test('LHB repeated abnormal-reason rows are deduplicated by stock and reasons merged',()=>{
  const rows=normalizeLhbDailyRows([
    {SECURITY_CODE:'600001',SECURITY_NAME_ABBR:'样本A',TRADE_DATE:'2026-11-18',BILLBOARD_NET_AMT:1000000,EXPLANATION:'日涨幅偏离'},
    {SECURITY_CODE:'600001',SECURITY_NAME_ABBR:'样本A',TRADE_DATE:'2026-11-18',BILLBOARD_NET_AMT:-1500000,EXPLANATION:'连续三个交易日偏离'},
    {SECURITY_CODE:'000002',SECURITY_NAME_ABBR:'样本B',TRADE_DATE:'2026-11-18',BILLBOARD_NET_AMT:500000,EXPLANATION:'换手率异常'}
  ]);
  assert.equal(rows.length,2);
  const first=rows.find(row=>row.code==='600001');
  assert.equal(first.netBuyCny,-1500000);
  assert.equal(first.appearances,2);
  assert.deepEqual(first.explanations,['日涨幅偏离','连续三个交易日偏离']);
});

test('institutional LHB seat flow is separated from ordinary brokerage seats',()=>{
  const result=summarizeLhbContext({
    tradeDate:'2026-11-18',
    dailyStatus:'AVAILABLE',
    seatStatus:'AVAILABLE',
    dailyRows:[
      {SECURITY_CODE:'600001',SECURITY_NAME_ABBR:'样本A',BILLBOARD_NET_AMT:1000000,EXPLANATION:'涨幅偏离'},
      {SECURITY_CODE:'000002',SECURITY_NAME_ABBR:'样本B',BILLBOARD_NET_AMT:-500000,EXPLANATION:'换手异常'}
    ],
    seatRows:[
      {SECURITY_CODE:'600001',OPERATEDEPT_NAME:'机构专用',NET_AMT:2000000},
      {SECURITY_CODE:'600001',OPERATEDEPT_NAME:'基金专用',NET_AMT:-500000},
      {SECURITY_CODE:'000002',OPERATEDEPT_NAME:'国泰海通上海分公司',NET_AMT:900000}
    ],
    stockRows:[
      {code:'600001',industry:'电子'},
      {code:'000002',industry:'传媒'}
    ]
  });
  assert.equal(result.status,'AVAILABLE');
  assert.equal(result.recordCount,2);
  assert.equal(result.totalNetBuyCny,500000);
  assert.equal(result.institutionalStockCount,1);
  assert.equal(result.institutionalNetBuyCny,1500000);
  assert.equal(result.stockSignalsByCode['600001'].institutionalNetBuyCny,1500000);
  assert.equal(result.stockSignalsByCode['000002'].institutionalNetBuyCny,null);
  assert.equal(result.sectors.find(row=>row.industry==='电子').netBuyCny,1000000);
});

test('next-session premium uses only matched previous limit-up cohort and coverage gate',()=>{
  const previousLimitPools={status:'AVAILABLE',limitUp:[{code:'600001'},{code:'000002'}]};
  const good=evaluateNextDayLimitUpPremium({
    previousLimitPools,currentStockRows:[
      {code:'600001',pct:2},{code:'000002',pct:-1}
    ],previousTradeDate:'2026-11-17',currentTradeDate:'2026-11-18'
  });
  assert.equal(good.status,'AVAILABLE');
  assert.equal(good.meanReturnPct,0.5);
  assert.equal(good.positiveRatio,0.5);
  const partial=evaluateNextDayLimitUpPremium({
    previousLimitPools,currentStockRows:[{code:'600001',pct:2}],
    previousTradeDate:'2026-11-17',currentTradeDate:'2026-11-18'
  });
  assert.equal(partial.status,'NOT_MEASURABLE');
});

test('next-day premium remains measurable when only the prior limit-up pool is available',()=>{
  const previousLimitPools={
    status:'PARTIAL',
    sourceStatus:{limitUp:'AVAILABLE',broken:'NOT_MEASURABLE',limitDown:'AVAILABLE'},
    limitUp:[{code:'600001'},{code:'000002'}]
  };
  const result=evaluateNextDayLimitUpPremium({
    previousLimitPools,
    currentStockRows:[{code:'600001',pct:2},{code:'000002',pct:0}],
    previousTradeDate:'2026-11-17',currentTradeDate:'2026-11-18'
  });
  assert.equal(result.status,'AVAILABLE');
  assert.equal(result.meanReturnPct,1);
});

test('single-day flow or institutional buying without higher lows is not a bottom signal',()=>{
  const sessions=[
    {tradeDate:'2026-11-16',fundingRows:[{code:'600001',price:10,low:9.8,mainNet:100}]},
    {tradeDate:'2026-11-17',fundingRows:[{code:'600001',price:9.8,low:9.5,mainNet:200}],lhb:{stockSignalsByCode:{'600001':{institutionalNetBuyCny:1000}}}},
    {tradeDate:'2026-11-18',fundingRows:[{code:'600001',price:9.6,low:9.2,mainNet:300}],lhb:{stockSignalsByCode:{'600001':{institutionalNetBuyCny:2000}}}}
  ];
  const result=scoreCandidateFundingEvidence({code:'600001',sessions,asOf:'2026-11-18'});
  assert.equal(result.trendConfirmed,false);
  assert.equal(result.fundingScore,null);
  assert.ok(result.reasons.includes('capital-inflow-without-higher-lows-is-not-a-bottom-signal'));
});

test('persistent multi-session capital flow plus higher lows qualifies main-board observation',()=>{
  const sessions=[
    {tradeDate:'2026-11-16',fundingRows:[{code:'600001',price:10,low:9.5,mainNet:100,turn:8,pct:1}]},
    {tradeDate:'2026-11-17',fundingRows:[{code:'600001',price:10.2,low:9.7,mainNet:200,turn:9,pct:2}],lhb:{stockSignalsByCode:{'600001':{institutionalNetBuyCny:500}}}},
    {tradeDate:'2026-11-18',fundingRows:[{code:'600001',price:10.5,low:9.9,mainNet:300,turn:10,pct:2.9}],lhb:{stockSignalsByCode:{'600001':{institutionalNetBuyCny:700}}}}
  ];
  const result=scoreCandidateFundingEvidence({code:'600001',sessions,asOf:'2026-11-18'});
  assert.equal(result.trendConfirmed,true);
  assert.equal(result.mainFlowPositiveDays,3);
  assert.equal(result.institutionalPositiveDays,2);
  assert.equal(result.fundingScore,100);
});

test('high-turnover price extension reduces the funding score and flags chase risk',()=>{
  const sessions=[
    {tradeDate:'2026-11-16',fundingRows:[{code:'600001',price:10.5,low:9.8,mainNet:100,turn:8,pct:1}]},
    {tradeDate:'2026-11-17',fundingRows:[{code:'600001',price:11,low:10,mainNet:200,turn:9,pct:2}],lhb:{stockSignalsByCode:{'600001':{institutionalNetBuyCny:500}}}},
    {tradeDate:'2026-11-18',fundingRows:[{code:'600001',price:11.4,low:10.2,mainNet:300,turn:25,pct:8.5}],lhb:{stockSignalsByCode:{'600001':{institutionalNetBuyCny:700}}}}
  ];
  const result=scoreCandidateFundingEvidence({code:'600001',sessions,asOf:'2026-11-18'});
  assert.equal(result.trendConfirmed,true);
  assert.equal(result.chaseRiskScore,90);
  assert.equal(result.fundingScore,80);
});

test('funding watchlist excludes STAR/ChiNext/ST and only ranks measured candidates',()=>{
  const sessions=[
    {tradeDate:'2026-11-16',fundingRows:[{code:'600001',price:10,low:9.5,mainNet:100,turn:8,pct:1}]},
    {tradeDate:'2026-11-17',fundingRows:[{code:'600001',price:10.2,low:9.7,mainNet:200,turn:9,pct:2}]},
    {tradeDate:'2026-11-18',fundingRows:[{code:'600001',price:10.5,low:9.9,mainNet:300,turn:10,pct:2.9}]}
  ];
  const result=rankFundingCandidates({
    currentRows:[
      {code:'600001',name:'主板候选',industry:'电子',price:10.5,low:9.9,mainNet:300,turn:10,pct:2.9},
      {code:'688001',name:'科创候选'},
      {code:'300001',name:'创业板候选'},
      {code:'600002',name:'*ST风险股'}
    ],
    sessions,asOf:'2026-11-18',limit:10
  });
  assert.deepEqual(result.map(row=>row.code),['600001']);
});
