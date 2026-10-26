import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scorePolicyAlignment, deriveMarketRegime, regimeAwareScore,
  OFFICIAL_POLICIES, POLICY_CATALOG_VERSION
} from '../research/v13-limitup-precursor/policy_alignment.js';

test('policy scoring cites official source and matches policy-aligned themes', () => {
  const result = scorePolicyAlignment({
    industry: '计算机设备',
    themeNames: ['人工智能', '算力基础设施'],
    companyNews: [],
    asOf: '2026-10-26'
  });
  assert.equal(result.evidenceAvailable, true);
  assert.ok(result.score >= 85);
  assert.ok(result.matchedThemes.some(theme => theme.label.includes('人工智能')));
  assert.ok(result.matchedThemes.every(theme => theme.policy.url.startsWith('https://')));
  assert.equal(result.catalogVersion, POLICY_CATALOG_VERSION);
});

test('policy taxonomy reviewed after the signal cutoff is unavailable for historical scoring', () => {
  const result = scorePolicyAlignment({
    industry: '计算机设备',
    themeNames: ['人工智能'],
    companyNews: [{title:'人工智能业务落地',publishedAt:'2026-10-19 10:00:00'}],
    asOf: '2026-10-20'
  });
  assert.equal(result.evidenceAvailable, false);
  assert.equal(result.score, 50);
  assert.equal(result.catalogNotYetAvailable, true);
  assert.equal(result.catalogAvailableAtCutoff, false);
  assert.equal(result.matchedThemes.length, 0);
  assert.equal(result.catalogWarning, 'policy-catalog-not-available-at-signal-cutoff');
});

test('generic company names do not create policy alignment without sector/theme evidence', () => {
  const result = scorePolicyAlignment({
    industry: '综合',
    themeNames: [],
    companyNews: [{title:'某公司签订重大合同',publishedAt:'2026-10-25T10:00:00+08:00'}],
    asOf: '2026-10-26'
  });
  assert.equal(result.evidenceAvailable, false);
  assert.equal(result.score, 50);
  assert.equal(result.matchedThemes.length, 0);
});

test('undated or future company news is not used as policy-theme evidence', () => {
  const result = scorePolicyAlignment({
    industry: '综合',
    themeNames: [],
    companyNews: [
      {title:'人工智能业务重大突破',publishedAt:'2026-10-27T10:00:00+08:00'},
      {title:'机器人业务进入供应链'}
    ],
    asOf: '2026-10-26'
  });
  assert.equal(result.evidenceAvailable, false);
});

test('market regime uses index movement and quote breadth and labels limited sample honestly', () => {
  const rows = Array.from({length:120},(_,i)=>({
    f12:String(600000+i).slice(-6), f14:'样本'+i,
    f3:i<84?1.2:-0.6, f62:i<70?1000000:-1000000
  }));
  const result = deriveMarketRegime({
    indices:[{name:'上证指数',pct:0.8},{name:'创业板指',pct:1.4},{name:'沪深300',pct:0.7}],
    universeRows:rows,capturedAt:'2026-10-26T10:00:00+08:00'
  });
  assert.equal(result.regime,'risk-on');
  assert.equal(result.dataQuality,'multi-index-and-ranked-candidate-sample');
  assert.ok(result.upRatio > 0.6);
  assert.equal(result.indexCount,3);
});

test('index weakness with positive breadth is classified as divergence, not automatic risk-off', () => {
  const rows = Array.from({length:120},(_,i)=>({
    f12:String(600000+i).slice(-6), f14:'样本'+i,
    f3:i<70?1.2:-0.6, f62:i<70?1000000:-1000000
  }));
  const result = deriveMarketRegime({
    indices:[{name:'上证指数',pct:-1.1},{name:'沪深300',pct:-0.9}],
    universeRows:rows,capturedAt:'2026-10-26T10:00:00+08:00'
  });
  assert.equal(result.regime,'neutral');
  assert.equal(result.label,'指数走弱、个股分化');
  assert.equal(result.indexMedianPct,-1);
  assert.ok(result.upRatio>0.55);
});

test('risk-off classification requires weak breadth or a severe index selloff with breadth deterioration', () => {
  const rows = Array.from({length:120},(_,i)=>({
    f12:String(600000+i).slice(-6), f14:'样本'+i,
    f3:i<35?0.8:-1.2, f62:i<30?1000000:-1000000
  }));
  const result = deriveMarketRegime({
    indices:[{name:'上证指数',pct:-1.2},{name:'沪深300',pct:-1.0}],
    universeRows:rows,capturedAt:'2026-10-26T10:00:00+08:00'
  });
  assert.equal(result.regime,'risk-off');
  assert.equal(result.label,'防守/风险偏好下降');
  assert.ok(result.upRatio<0.42);
});

test('policy score cannot compensate for very weak flow and trend confirmation', () => {
  const result = regimeAwareScore({
    coreScore:42, policyScore:99, policyEvidence:true, marketRegime:'risk-on',
    trend:20, volumePrice:40, flow:18, sector:80, momentum:70, base:60
  });
  assert.equal(result.effectivePolicyScore,55);
  assert.ok(result.score < 50);
});

test('risk-off market reduces policy weight and prioritizes capital/quality confirmation', () => {
  const riskOn = regimeAwareScore({
    coreScore:65,policyScore:95,policyEvidence:true,marketRegime:'risk-on',
    trend:70,volumePrice:65,flow:70,sector:85,momentum:80,base:45
  });
  const riskOff = regimeAwareScore({
    coreScore:65,policyScore:95,policyEvidence:true,marketRegime:'risk-off',
    trend:70,volumePrice:65,flow:70,sector:85,momentum:80,base:45
  });
  assert.equal(riskOn.policyWeight,0.14);
  assert.equal(riskOff.policyWeight,0.06);
  assert.ok(OFFICIAL_POLICIES.length >= 3);
});


test('naive Chinese publication timestamps are interpreted as China Standard Time', () => {
  const afterClose = scorePolicyAlignment({
    industry: '综合',
    themeNames: [],
    companyNews: [{title:'人工智能新业务落地',publishedAt:'2026-10-26 15:01:00'}],
    asOf: '2026-10-26'
  });
  const beforeClose = scorePolicyAlignment({
    industry: '综合',
    themeNames: [],
    companyNews: [{title:'人工智能新业务落地',publishedAt:'2026-10-26 14:59:00'}],
    asOf: '2026-10-26'
  });
  assert.equal(afterClose.evidenceAvailable, false);
  assert.equal(beforeClose.evidenceAvailable, true);
});


test('stale policy catalog is explicitly flagged and its score weight is reduced', () => {
  const stale = scorePolicyAlignment({
    industry: '计算机设备',
    themeNames: ['人工智能'],
    companyNews: [],
    asOf: '2026-12-01'
  });
  assert.equal(stale.catalogStale, true);
  assert.ok(stale.catalogAgeDays > 14);
  const adjusted = regimeAwareScore({
    coreScore:65,policyScore:95,policyEvidence:true,policyCatalogStale:true,marketRegime:'risk-off',
    trend:70,volumePrice:65,flow:70,sector:85,momentum:80,base:45
  });
  assert.equal(adjusted.policyWeight,0.015);
  assert.equal(adjusted.policyCatalogStale,true);
});


test('short acronym AI does not match unrelated words such as retail', () => {
  const result = scorePolicyAlignment({
    industry: 'Retail Services',
    themeNames: ['Retail'],
    companyNews: [],
    asOf: '2026-10-26'
  });
  assert.equal(result.evidenceAvailable, false);
  assert.equal(result.score, 50);
});


test('generic sector headlines cannot create company policy exposure without a company action', () => {
  const generic = scorePolicyAlignment({
    industry: '综合',
    themeNames: [],
    companyNews: [{title:'机器人板块今日走强',publishedAt:'2026-10-26 10:00:00'}],
    asOf: '2026-10-26'
  });
  const specific = scorePolicyAlignment({
    industry: '综合',
    themeNames: [],
    companyNews: [{title:'公司机器人业务获得重大订单',publishedAt:'2026-10-26 10:00:00'}],
    asOf: '2026-10-26'
  });
  assert.equal(generic.evidenceAvailable, false);
  assert.equal(specific.evidenceAvailable, true);
});


test('policy availability uses the public release date rather than the earlier document date',()=>{
  const commerce = OFFICIAL_POLICIES.find(policy => policy.id === 'tech-commerce-2026-10-13');
  assert.ok(commerce);
  assert.equal(commerce.issuedAt,'2026-10-13');
  assert.equal(commerce.publishedAt,'2026-10-19');
});
