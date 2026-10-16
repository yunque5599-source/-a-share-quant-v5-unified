import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../../../api/psychology_universe.js';

function response(payload, jsonp = false) {
  const body = jsonp ? 'v12Psychology(' + JSON.stringify(payload) + ')' : JSON.stringify(payload);
  return {ok:true, status:200, async text(){return body;}};
}

function mockFetch() {
  const quoteTs = Math.floor(Date.parse('2026-10-16T15:00:00+08:00') / 1000);
  const flowLines = Array.from({length:10}, (_, index) => {
    const date = '2026-10-' + String(7 + index).padStart(2, '0');
    return date + ',100000000,0,0,0,0,2,0,0,0,0,100,1';
  });
  const members = {
    BK0001:[
      {f12:'600001',f14:'测试科技',f3:8.5,f6:1000000000,f8:10,f20:10000000000,f62:200000000},
      {f12:'600002',f14:'跟随科技',f3:6.2,f6:500000000,f8:8,f20:8000000000,f62:100000000}
    ],
    BK0002:[
      {f12:'600001',f14:'测试科技',f3:7.1,f6:900000000,f8:9,f20:10000000000,f62:180000000},
      {f12:'600003',f14:'另一核心',f3:6.5,f6:600000000,f8:8,f20:7000000000,f62:120000000}
    ]
  };
  return async input => {
    const url = new URL(input);
    if (url.pathname.endsWith('/api/qt/clist/get') && url.searchParams.get('fs')?.startsWith('m:90+t:3')) {
      return response({data:{total:2,diff:[
        {f2:100,f3:4.2,f6:10000000000,f8:5,f12:'BK0001',f14:'人工智能',f62:3000000000,f104:30,f105:10,f106:5,f124:quoteTs,f128:'测试科技',f134:45,f136:8.5,f140:'600001',f184:2},
        {f2:90,f3:2.5,f6:8000000000,f8:4,f12:'BK0002',f14:'机器人',f62:1800000000,f104:20,f105:8,f106:4,f124:quoteTs,f128:'测试科技',f134:32,f136:7.1,f140:'600001',f184:1.2}
      ]}});
    }
    if (url.pathname.endsWith('/api/qt/clist/get') && url.searchParams.get('fs')?.startsWith('b:')) {
      const board = url.searchParams.get('fs').slice(2).split('+')[0];
      return response({data:{total:members[board]?.length ?? 0,diff:members[board] ?? []}});
    }
    if (url.pathname.endsWith('/api/qt/slist/get')) {
      return response({data:{diff:{
        '0':{f12:'BK0001',f14:'人工智能'},
        '1':{f12:'BK0002',f14:'机器人'}
      }}});
    }
    if (url.pathname.endsWith('/api/qt/ulist.np/get')) {
      return response({data:{diff:{
        '0':{f12:'000001',f14:'测试科技',f3:8.5,f124:quoteTs}
      }}});
    }
    if (url.pathname.endsWith('/api/qt/stock/fflow/daykline/get')) {
      return response({data:{klines:flowLines}});
    }
    if (url.pathname.endsWith('/search/jsonp')) {
      const theme = url.searchParams.get('param') ? JSON.parse(url.searchParams.get('param')) : {};
      const keyword = theme.keyword || '人工智能';
      const news = Array.from({length:5}, (_, index) => ({
        date:'2026-10-' + String(12 + index).padStart(2,'0') + ' 10:00:00',
        title:keyword + '产业行动方案与测试科技重大订单',
        content:'国务院和工信部持续推进政策落地，市场规模达到1.2万亿元，渗透率仍处于早期，多场景跨行业应用加速商业化与量产，测试科技订单增长超预期。',
        mediaName:['中国政府网','工信部','证券时报','财联社','中国证券报'][index],
        url:'https://example.com/news/' + index
      }));
      return response({result:{cmsArticleWebOld:news}}, true);
    }
    throw new Error('unexpected mock URL: ' + url.href);
  };
}

test('psychology universe wires live theme, leader, news and imagination evidence into V12', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch();
  try {
    const chunks = [];
    const res = {
      statusCode:200,
      headers:{},
      setHeader(key,value){this.headers[key]=value;},
      end(value){chunks.push(String(value));}
    };
    await handler({url:'/api/psychology_universe?codes=000001'}, res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(chunks.join(''));
    const themes = body.data.themeBySymbol['000001'];
    assert.equal(themes.length, 2);
    const primary = themes[0];
    assert.equal(primary.candidateName, '测试科技');
    assert.equal(primary.candidateRank, 1);
    assert.equal(primary.leaderStatus, 'leader');
    assert.equal(primary.leaderCode, '600001');
    assert.equal(primary.news.length, 5);
    assert.ok(primary.narrativeScore > 0);
    assert.ok(primary.imaginationScore > 0);
    assert.equal(primary.researchQuality.narrative.complete, true);
    assert.equal(primary.researchQuality.imagination.complete, true);
    assert.equal(body.researchPolicy.psychologyCanBeComputed, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
