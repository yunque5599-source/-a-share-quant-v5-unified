import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {selectObservationCandidates, _internal} from '../research/v15_one_click_selection.js';
import {parseCodes} from '../api/market.js';
import {replayV15Snapshots} from '../research/v15_replay.js';
import {collectCandidateCodes, deriveLimitUpPrice, parseDailyBars} from '../research/fetch_v15_bars.js';
import {createHandler as createDiscoveryCandidatesHandler} from '../api/discovery_candidates.js';

function row(code, overrides = {}) {
  return {
    code,
    name: '样本' + code,
    price: 20,
    pct: 2,
    amount: 120_000_000,
    turn: 4,
    pct60: 8,
    mainNet: 20_000_000,
    mainPct: 3,
    industry: '测试行业',
    rankScore: 65,
    rankHits: 2,
    ...overrides
  };
}

test('observation discovery exposes seven independent lanes', () => {
  const rows = [
    row('600001', {pct: 3, pct60: 8, turn: 4, industry: '成长行业'}),
    row('600002', {pct: 8.8, pct60: 15, turn: 12, industry: '强势行业'}),
    row('600003', {pct: -2, pct60: 4, turn: 10, mainNet: 5_000_000, mainPct: 1, industry: '资金行业'}),
    row('600004', {pct: -1, pct60: -22, turn: 12, mainNet: 8_000_000, mainPct: 1.5, industry: '反转行业'}),
    row('600005', {pct: 4, pct60: 2, turn: 1.5, mainNet: 2_000_000, mainPct: 1, industry: '低换手行业'}),
    row('600006', {pct: 1, pct60: 4, amount: 1_200_000_000, turn: 3, industry: '高成交行业'}),
    row('600007', {pct: 1, pct60: 2, industry: '板块共振'}),
    row('600008', {pct: 2, pct60: 3, industry: '板块共振'}),
    row('600009', {pct: 3, pct60: 4, industry: '板块共振'}),
    row('600010', {pct: 4, pct60: 5, industry: '板块共振'}),
    row('600011', {pct: 5, pct60: 6, industry: '板块共振'})
  ];
  const result = selectObservationCandidates(rows, {limit: 20});
  assert.equal(result.schema, 'v15-one-click-observation-lanes-v1');
  assert.equal(result.probabilityCalibration, 'NOT_CALIBRATED');
  assert.ok(result.laneCounts['early-breakout'] > 0);
  assert.ok(result.laneCounts['limit-up-approach'] > 0);
  assert.ok(result.laneCounts['capital-flow'] > 0);
  assert.ok(result.laneCounts['reversal-watch'] > 0);
  assert.ok(result.laneCounts['low-turnover-breakout'] > 0);
  assert.ok(result.laneCounts['industry-strength'] > 0);
  assert.ok(result.laneCounts['liquidity-volume'] > 0);
});

test('ranking freshness gate blocks stale or incomplete live ranking pools', () => {
  const nowMs = Date.parse('2026-10-29T02:00:00.000Z');
  const freshQuotes = Array.from({length:10},()=>new Date(nowMs-30_000).toISOString());
  const fresh = _internal.evaluateRankingFreshness({
    generatedAt:new Date(nowMs-30_000).toISOString(),
    quoteAts:freshQuotes,
    nowMs,
    sourceComplete:true,
    requireFreshQuotes:true
  });
  assert.equal(fresh.blocked,false);
  assert.ok(fresh.quoteFreshRatio >= 0.99);
  const stale = _internal.evaluateRankingFreshness({
    generatedAt:new Date(nowMs-240_000).toISOString(),
    quoteAts:freshQuotes,
    nowMs,
    sourceComplete:true,
    requireFreshQuotes:true
  });
  assert.equal(stale.blocked,true);
  assert.ok(stale.reasons.includes('ranking-source-older-than-limit'));
  const incomplete = _internal.evaluateRankingFreshness({
    generatedAt:new Date(nowMs-30_000).toISOString(),
    quoteAts:freshQuotes,
    nowMs,
    sourceComplete:false,
    requireFreshQuotes:false
  });
  assert.equal(incomplete.blocked,true);
  assert.ok(incomplete.reasons.includes('ranking-source-incomplete'));
  const staleQuotes = Array.from({length:10},(_,index)=>new Date(index<4?nowMs-30_000:nowMs-86_400_000).toISOString());
  const weakCoverage = _internal.evaluateRankingFreshness({
    generatedAt:new Date(nowMs-30_000).toISOString(),
    quoteAts:staleQuotes,
    nowMs,
    sourceComplete:true,
    requireFreshQuotes:true
  });
  assert.equal(weakCoverage.blocked,true);
  assert.ok(weakCoverage.reasons.includes('fresh-quote-coverage-below-threshold'));
});

test('sector resonance rewards candidate-pool strength, near-limit concentration and positive flow', () => {
  const strongPct = [1, 2, 3, 4, 5, 6, 8.8, 9.2];
  const weakPct = [-3, -2, -1, 0, 0.2, 0.5, 1, 1.2];
  const strongRows = strongPct.map((pct, index) => row(String(601000 + index), {
    industry:'强势题材代理', pct, pct60:12, mainNet:12_000_000, mainPct:4, rankScore:80
  }));
  const weakRows = weakPct.map((pct, index) => row(String(601100 + index), {
    industry:'弱势题材代理', pct, pct60:-15, mainNet:-2_000_000, mainPct:-1, rankScore:40
  }));
  const allRows = [...strongRows, ...weakRows];
  const stats = _internal.makeIndustryStats(allRows);
  const strong = stats.get('强势题材代理');
  const weak = stats.get('弱势题材代理');
  assert.ok(strong.score > weak.score);
  assert.ok(strong.nearLimitShare > weak.nearLimitShare);
  assert.ok(strong.flowBreadth > weak.flowBreadth);
  const context = _internal.makeObservationContext(allRows);
  assert.equal(context.scope, 'observed-candidate-pool-not-full-market');
  assert.equal(context.label, '情绪升温');
  const result = selectObservationCandidates(allRows, {limit:20});
  assert.ok(result.observationContext.score >= 70);
  const leader = result.candidates.find(candidate=>candidate.code==='601006');
  assert.ok(leader);
  assert.ok(leader.observationReasons.some(reason=>reason.includes('涨停幅度附近')));
});

test('shortlist is diversified, unique, and never grants entry eligibility', () => {
  const rows = Array.from({length: 40}, (_, i) => row(String(600100 + i), {
    pct: i % 10,
    pct60: i % 2 ? -18 : 12,
    turn: 1 + (i % 8),
    amount: 60_000_000 + i * 30_000_000,
    mainNet: i % 3 ? 3_000_000 : -1_000_000,
    mainPct: i % 3 ? 1.2 : -0.5,
    industry: i % 2 ? '行业甲' : '行业乙'
  }));
  const result = selectObservationCandidates(rows, {limit: 5, excludeCodes: new Set(['600100'])});
  assert.equal(result.selectedCount, result.candidates.length);
  assert.ok(result.candidates.length <= 5);
  assert.equal(new Set(result.candidates.map(x => x.code)).size, result.candidates.length);
  assert.ok(!result.candidates.some(x => x.code === '600100'));
  for (const candidate of result.candidates) {
    assert.equal(candidate.researchOnly, true);
    assert.equal(candidate.entryEligible, false);
    assert.ok(candidate.entryGateReasons.includes('research-observation-only-not-a-buy-signal'));
    assert.ok(candidate.observationLaneLabels.length > 0);
    assert.ok(Number.isFinite(candidate.observationScore));
  }
});

test('reversal observation does not convert a falling stock into a buy signal', () => {
  const rows = [
    row('600201', {pct: -3.5, pct60: -30, mainNet: 10_000_000, mainPct: 2, turn: 18}),
    row('600202', {pct: -5.5, pct60: -30, mainNet: 10_000_000, mainPct: 2, turn: 18})
  ];
  const result = selectObservationCandidates(rows, {limit: 10});
  const reversal = result.candidates.find(x => x.code === '600201');
  assert.ok(reversal);
  assert.ok(reversal.observationLanes.includes('reversal-watch'));
  assert.equal(reversal.entryEligible, false);
  assert.equal(_internal.limitPctForCode('300001'), 20);
  assert.equal(_internal.limitPctForCode('600001'), 10);
});

test('invalid, restricted, non-main-board and missing-data rows do not create observation candidates', () => {
  const rows = [
    row('600301', {name: '*ST样本'}),
    row('600302', {price: null}),
    row('600303', {amount: null}),
    row('600304', {pct: null}),
    row('300001', {}),
    row('688001', {}),
    row('900305', {})
  ];
  const result = selectObservationCandidates(rows, {limit: 10});
  assert.equal(result.validInputCount, 0);
  assert.equal(result.selectedCount, 0);
});

test('deep batch parser accepts the full 30+10 one-click scan set without duplicates', () => {
  const codes = Array.from({length: 40}, (_, i) => String(600500 + i));
  assert.equal(parseCodes(codes.join(','), 40).length, 40);
  assert.equal(parseCodes([...codes, codes[0], 'bad-code'].join(','), 40).length, 40);
  assert.equal(parseCodes(codes.join(',')).length, 30);
});

test('the observation lane module is wired into the actual one-click flow', async () => {
  const index = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const market = await readFile(new URL('../api/market.js', import.meta.url), 'utf8');
  assert.ok(index.includes("await import('./research/v15_one_click_selection.js')"));
  assert.ok(index.includes('selectObservationCandidates'));
  assert.ok(index.includes('renderShadow(shadowFinal, observationPlan, independentPool)'));
  assert.ok(index.includes('exportResearchSnapshot'));
  assert.ok(market.includes("parseCodes(u.searchParams.get('codes'), 40)"));
  assert.ok(market.includes('candidates: rows.slice(0, 900)'));
  assert.ok(market.includes('f100,f124'));
  assert.ok(index.includes("quoteAt:Number.isFinite(+x.f124)")); 
  assert.ok(index.includes("fetch('/api/discovery_candidates'"));
  assert.ok(index.includes('limit:10'));
  assert.ok(index.includes('mergeObservationUniverse(market,independentPool)'));
  assert.ok(index.includes('function escapeHtml(value)'));
  assert.ok(index.includes('观察池情绪代理'));
  assert.ok(index.includes('freshnessModule.evaluateRankingFreshness'));
  assert.ok(index.includes('lastMarketMeta.sourceStale'));
  assert.ok(market.includes('rankedMemory.t < 60000'));
  assert.ok(market.includes('await rankedCandidates(), 30'));
  const selector = await readFile(new URL('../research/v15_one_click_selection.js', import.meta.url), 'utf8');
  assert.ok(selector.includes('makeObservationContext(raw)'));
  assert.ok(selector.includes('evaluateRankingFreshness'));
  assert.ok(selector.includes('nearLimitShare'));
  assert.ok(selector.includes('sectorResonance'));
  assert.ok(selector.includes('/^(00|60)\\d{4}$/'));
  assert.ok(selector.includes('laneTopCandidates'));
});


function replaySnapshot() {
  return {
    schema: 'ashare-v15-full-universe-snapshot-v1',
    capturedAt: '2026-10-29T02:00:00.000Z',
    tradeDate: '2026-10-29',
    quality: {qualifiedForReplay: true, reasons: []},
    universe: {
      fields: ['code', 'name', 'price', 'specialTreatment'],
      rows: [
        ['600001', '股票甲', 10, false],
        ['600002', '股票乙', 20, false],
        ['600003', '股票丙', 30, false]
      ]
    },
    strategies: {
      primaryTop: [{code: '600001', score: 90}],
      legacyShadowTop: [{code: '600002', score: 80}],
      v15ObservationTop: [{code: '600003', score: 85}],
      observationLanes: {'limit-up-approach': [{code: '600003', score: 85, lanes: ['limit-up-approach']}]}
    }
  };
}

test('forward replay compares old and new candidate sets with verified labels', () => {
  const snapshot = replaySnapshot();
  const dailyBarsByCode = {
    '600001': [
      {date: '2026-10-29', close: 20, high: 20, low: 8, isLimitUp: true},
      {date: '2026-10-30', close: 10.5, high: 10.7, low: 10.1, isLimitUp: false}
    ],
    '600002': [{date: '2026-10-30', close: 22, high: 22, low: 20, isLimitUp: true}],
    '600003': [{date: '2026-10-30', close: 33, high: 33, low: 30, isLimitUp: true}]
  };
  const report = replayV15Snapshots({snapshots: [snapshot], dailyBarsByCode, horizons: [1], topKs: [1, 2]});
  const primary = report.perSnapshot.find(x => x.strategy === 'primaryTop' && x.requestedK === 1);
  const legacy = report.perSnapshot.find(x => x.strategy === 'legacyUnion' && x.requestedK === 2);
  const v15 = report.perSnapshot.find(x => x.strategy === 'v15Union' && x.requestedK === 2);
  assert.equal(primary.hitCount, 0, 'same-day daily candle must not leak into labels');
  assert.equal(legacy.hitCount, 1);
  assert.equal(v15.hitCount, 1);
  assert.equal(legacy.observedUniverseLimitUpCount, 2);
  assert.equal(legacy.observedPoolRecallAtK, 0.5);
  assert.equal(v15.observedPoolRecallAtK, 0.5);
});

test('unknown limit-up labels are excluded, not counted as misses', () => {
  const snapshot = replaySnapshot();
  const dailyBarsByCode = Object.fromEntries(['600001', '600002', '600003'].map(code => [
    code, [{date: '2026-10-30', close: 10, high: 11, low: 9}]
  ]));
  const report = replayV15Snapshots({snapshots: [snapshot], dailyBarsByCode, horizons: [1], topKs: [1]});
  const primary = report.perSnapshot.find(x => x.strategy === 'primaryTop' && x.requestedK === 1);
  assert.equal(primary.labelledCount, 0);
  assert.equal(primary.precisionAtK, null);
  assert.equal(primary.observedUniverseLimitUpCount, 0);
  assert.equal(primary.observedPoolRecallAtK, null);
});

test('same-day intraday labels are used only after the recorded capture timestamp', () => {
  const snapshot = replaySnapshot();
  const intradayBarsByCode = {
    '600001': [
      {date: '2026-10-29', timestamp: '2026-10-29T01:59:00.000Z', close: 10, high: 10, low: 10, isLimitUp: true},
      {date: '2026-10-29', timestamp: '2026-10-29T02:05:00.000Z', close: 11, high: 11, low: 10, isLimitUp: true}
    ]
  };
  const report = replayV15Snapshots({
    snapshots: [snapshot],
    dailyBarsByCode: {},
    intradayBarsByCode,
    horizons: [1],
    topKs: [1]
  });
  const primary = report.perSnapshot.find(x => x.strategy === 'primaryTop' && x.requestedK === 1);
  assert.equal(primary.hitCount, 1);
  assert.ok(Math.abs(primary.avgReturnPct - 10) < 1e-9);
});

test('unqualified snapshots are skipped unless explicitly included', () => {
  const snapshot = replaySnapshot();
  snapshot.quality.qualifiedForReplay = false;
  const dailyBarsByCode = {'600001': [{date: '2026-10-30', close: 11, isLimitUp: true}]};
  const skipped = replayV15Snapshots({snapshots: [snapshot], dailyBarsByCode, horizons: [1], topKs: [1]});
  assert.equal(skipped.snapshotCount, 0);
  assert.equal(skipped.excludedSnapshots[0].reason, 'snapshot-not-qualified-for-replay');
  const included = replayV15Snapshots({snapshots: [snapshot], dailyBarsByCode, horizons: [1], topKs: [1], includeUnqualified: true});
  assert.equal(included.snapshotCount, 1);
});


test('daily-bar label derivation uses unadjusted main-board prices and rejects ST/other boards', () => {
  assert.equal(deriveLimitUpPrice(10, '600001'), 11);
  assert.equal(deriveLimitUpPrice(10, '000001'), 11);
  assert.equal(deriveLimitUpPrice(10, '300001'), null);
  assert.equal(deriveLimitUpPrice(10, '600001', '*ST样本'), null);
  const rawRows = Array.from({length: 60}, (_, index) => {
    const date = new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10);
    const last = index === 59;
    return [date, '10', last ? '10.9' : '10', last ? '11' : '10.5', '9.8', '100', '1000', '7', last ? '9' : '0', '0', '2'];
  });
  const bars = parseDailyBars('600001', rawRows, '普通股票');
  assert.equal(bars.length, 60);
  assert.equal(bars.at(-1).limitUpPrice, 11);
  assert.equal(bars.at(-1).limitUpVerified, true);
  assert.equal(bars.at(-1).isLimitUp, true);
  assert.equal(parseDailyBars('600001', rawRows.slice(0, 40), '普通股票').at(-1).limitUpVerified, false);
});

test('bar collector covers primary, legacy, V15, and individual lane leaders without non-main-board codes', () => {
  const codes = collectCandidateCodes([{
    strategies: {
      primaryTop: [{code: '600001'}, {code: '300001'}],
      primaryFinalTop: [{code: '000001'}],
      legacyShadowTop: [{code: '600002'}],
      v15ObservationTop: [{code: '600003'}],
      observationLanes: {'limit-up-approach': [{code: '600004'}, {code: '688001'}]}
    }
  }]);
  assert.deepEqual(codes, ['000001', '600001', '600002', '600003', '600004']);
});


function discoveryFixtureRows(prefix, base, timestampSeconds) {
  return Array.from({length:4}, (_, index) => ({
    f12: prefix + String(base + index).padStart(4, '0'),
    f14: '普通股票' + index,
    f2: String(10 + index),
    f3: String(2 + index * 2),
    f6: String(100_000_000 + index * 20_000_000),
    f8: String(2 + index),
    f20: '3000000000',
    f24: String(5 + index * 3),
    f62: String(1_000_000 + index * 2_000_000),
    f100: index < 2 ? '行业甲' : '行业乙',
    f124: String(timestampSeconds),
    f184: String(1 + index * 2)
  }));
}

function mockHttpResponse(payload, status = 200) {
  return {ok:status >= 200 && status < 300, status, text:async()=>JSON.stringify(payload)};
}

test('independent candidate endpoint merges factor ranks and reports a usable main-board pool', async () => {
  const nowMs = Date.parse('2026-10-29T02:00:00.000Z');
  const timestampSeconds = Math.floor(nowMs / 1000);
  const segments = [
    {key:'SZ_MAIN',fs:'SZ'},
    {key:'SH_MAIN',fs:'SH'}
  ];
  const fixtures = {
    SZ: discoveryFixtureRows('00', 1, timestampSeconds),
    SH: discoveryFixtureRows('60', 1, timestampSeconds)
  };
  const fetchImpl = async url => {
    const parsed = new URL(url);
    const segment = parsed.searchParams.get('fs');
    const fid = parsed.searchParams.get('fid');
    const page = Number(parsed.searchParams.get('pn'));
    const pageSize = Number(parsed.searchParams.get('pz'));
    const rows = [...fixtures[segment]].sort((a,b)=>Number(b[fid])-Number(a[fid]));
    return mockHttpResponse({data:{total:rows.length,diff:rows.slice((page-1)*pageSize,page*pageSize)}});
  };
  const handler = createDiscoveryCandidatesHandler({
    fetchImpl,
    now:()=>nowMs,
    segments,
    pageSize:2,
    maxPages:2,
    timeoutMs:1000,
    maxScanMs:10000,
    minObservationRecords:4,
    concurrency:8,
    hosts:['https://primary.test']
  });
  const res = {
    headers:{}, statusCode:200, body:null,
    setHeader(key,value){this.headers[key]=value;},
    status(code){this.statusCode=code;return this;},
    json(value){this.body=value;return this;}
  };
  await handler({method:'GET'},res);
  assert.equal(res.statusCode,200);
  assert.equal(res.body.usableForObservation,true);
  assert.equal(res.body.quality.qualifiedForObservationPool,true);
  assert.equal(res.body.records.length,8);
  assert.equal(res.body.quality.availableFactorCount,4);
  assert.ok(res.body.records.every(row=>/^(00|60)\d{4}$/.test(row.code)));
  assert.ok(res.body.records.every(row=>row.independentDiscovery===true));
  assert.ok(res.body.records.every(row=>row.rankHits===4));
  assert.ok(res.body.records.every(row=>row.discoveryFactors.length===4));
  assert.equal(res.body.failures.length,0);
});

test('independent candidate endpoint refuses to mark a partial source usable when a board momentum page is missing', async () => {
  const nowMs = Date.parse('2026-10-29T02:00:00.000Z');
  const timestampSeconds = Math.floor(nowMs / 1000);
  const segments = [
    {key:'SZ_MAIN',fs:'SZ'},
    {key:'SH_MAIN',fs:'SH'}
  ];
  const fixtures = {
    SZ: discoveryFixtureRows('00', 1, timestampSeconds),
    SH: discoveryFixtureRows('60', 1, timestampSeconds)
  };
  const fetchImpl = async url => {
    const parsed = new URL(url);
    const segment = parsed.searchParams.get('fs');
    const fid = parsed.searchParams.get('fid');
    const page = Number(parsed.searchParams.get('pn'));
    const pageSize = Number(parsed.searchParams.get('pz'));
    if (segment==='SH' && fid==='f3' && page===1) throw new Error('simulated source outage');
    const rows = [...fixtures[segment]].sort((a,b)=>Number(b[fid])-Number(a[fid]));
    return mockHttpResponse({data:{total:rows.length,diff:rows.slice((page-1)*pageSize,page*pageSize)}});
  };
  const handler = createDiscoveryCandidatesHandler({
    fetchImpl,
    now:()=>nowMs,
    segments,
    pageSize:2,
    maxPages:2,
    timeoutMs:1000,
    maxScanMs:10000,
    minObservationRecords:4,
    concurrency:8,
    hosts:['https://primary.test']
  });
  const res = {
    headers:{}, statusCode:200, body:null,
    setHeader(key,value){this.headers[key]=value;},
    status(code){this.statusCode=code;return this;},
    json(value){this.body=value;return this;}
  };
  await handler({method:'GET'},res);
  assert.equal(res.statusCode,200);
  assert.equal(res.body.usableForObservation,false);
  assert.ok(res.body.quality.errors.includes('missing-main-board-momentum-source'));
  assert.ok(res.body.failures.some(failure=>failure.segment==='SH_MAIN'&&failure.factor==='dayMomentum'));
});
