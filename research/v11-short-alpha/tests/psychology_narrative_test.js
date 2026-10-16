import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAutomaticPsychologyResearch } from '../psychology_narrative.js';

const news = [
  {date:'2026-10-16 09:00:00', title:'国务院发布产业行动方案，推动人工智能应用加速落地', content:'政策明确推进重点场景，市场规模预计达到1.2万亿元，渗透率仍处于早期。', mediaName:'中国政府网', url:'https://example.gov/1'},
  {date:'2026-10-15 14:00:00', title:'工信部推进人工智能产业化，多个场景进入量产阶段', content:'工信部提出多场景、跨行业应用，产业商业化和量产提速。', mediaName:'工信部', url:'https://example.gov/2'},
  {date:'2026-10-14 10:00:00', title:'行业订单增长超预期，龙头企业率先受益', content:'产业订单放量，平台生态持续扩张，市场空间广阔。', mediaName:'证券时报', url:'https://example.com/3'},
  {date:'2026-10-13 11:00:00', title:'人工智能需求持续增长，渗透率仍有提升空间', content:'从工业到医疗、汽车、消费等多个领域扩展，需求空间巨大。', mediaName:'财联社', url:'https://example.com/4'},
  {date:'2026-10-12 16:00:00', title:'龙头科技签署重大订单，产业链关注度升温', content:'公司商业化加速，出口和国产替代预期增强。', mediaName:'中国证券报', url:'https://example.com/5'}
];

const theme = {
  asOf:'2026-10-16',
  name:'人工智能',
  code:'BK9001',
  candidateCode:'600001',
  candidateName:'龙头科技',
  leaderCode:'600001',
  leaderName:'龙头科技',
  changePct:3.5,
  candidatePremiumPct:4.5,
  leaderChangePct:8.5
};

test('automatic research produces evidence-backed narrative and imagination blocks', () => {
  const result = buildAutomaticPsychologyResearch(theme, news, [
    {code:'600001',name:'龙头科技',pct:8.5}
  ]);
  assert.equal(result.researchQuality.narrative.complete, true);
  assert.equal(result.researchQuality.imagination.complete, true);
  assert.ok(result.narrativeResearch.novelty >= 0);
  assert.ok(result.narrativeResearch.expectationGap > 50);
  assert.ok(result.imaginationResearch.marketSize >= 90);
  assert.ok(result.imaginationResearch.penetrationGap >= 70);
  assert.ok(result.imaginationResearch.policyRunway >= 70);
  assert.ok(result.imaginationResearch.technologyOptionality >= 70);
  assert.ok(result.imaginationResearch.companyCapture >= 80);
  assert.equal(result.narrativeResearch.evidence.length, 5);
});

test('future news is excluded by as-of date', () => {
  const result = buildAutomaticPsychologyResearch(theme, [
    ...news,
    {date:'2026-10-17 09:00:00',title:'未来消息不应进入历史样本',content:'万亿市场 渗透率 政策',mediaName:'未来来源'}
  ], []);
  assert.equal(result.news.some(item => item.title.includes('未来消息')), false);
  assert.equal(result.researchQuality.narrative.complete, true);
});

test('weak evidence remains incomplete instead of fabricating imagination', () => {
  const result = buildAutomaticPsychologyResearch(
    {...theme, candidateName:'', leaderName:'', candidateCode:'', leaderCode:''},
    [{date:'2026-10-16 09:00:00',title:'普通市场新闻',content:'暂无明确产业数据',mediaName:'未知来源'}],
    []
  );
  assert.equal(result.researchQuality.narrative.complete, false);
  assert.equal(result.researchQuality.imagination.complete, false);
  assert.equal(result.imaginationResearch.marketSize, null);
  assert.equal(result.imaginationResearch.companyCapture, null);
});

test('negative evidence can lower narrative quality rather than becoming bullish by keyword count', () => {
  const negative = news.map((item, index) => ({
    ...item,
    title:index === 0 ? '监管风险上升，订单下滑且需求不及预期' : '行业承压，项目延期，竞争加剧'
  }));
  const result = buildAutomaticPsychologyResearch(theme, negative, []);
  assert.ok(result.researchQuality.narrative.diagnostics.negativeHits >= 5);
  assert.ok(result.narrativeResearch.novelty >= 0);
});

test('intraday as-of excludes same-day news published after the capture timestamp', () => {
  const result = buildAutomaticPsychologyResearch(
    {...theme, asOf:'2026-10-16T10:00:00+08:00'},
    [
      {date:'2026-10-16 09:00:00', title:'早盘政策消息', content:'政策推动市场规模万亿，渗透率早期，多场景商业化。', mediaName:'中国政府网'},
      {date:'2026-10-16 10:01:00', title:'未来午间消息不应进入快照', content:'政策推动市场规模万亿，渗透率早期，多场景商业化。', mediaName:'中国政府网'},
      {date:'2026-10-15 14:00:00', title:'前一日产业消息', content:'产业化量产加速，跨行业应用扩展。', mediaName:'工信部'},
      {date:'2026-10-14 10:00:00', title:'行业订单增长', content:'订单放量，平台生态扩张，市场空间广阔。', mediaName:'证券时报'}
    ],
    []
  );
  assert.equal(result.news.some(item => item.title.includes('未来午间消息')), false);
  assert.equal(result.news.some(item => item.title.includes('早盘政策消息')), true);
});

test('source timestamps without timezone are interpreted as Asia/Shanghai', () => {
  const result = buildAutomaticPsychologyResearch(
    {...theme, asOf:'2026-10-16T10:00:00+08:00'},
    [
      {date:'2026-10-16 09:59:00', title:'上海时间早盘消息', content:'政策 市场规模 万亿 渗透率 多场景 商业化', mediaName:'中国政府网'},
      {date:'2026-10-16 10:01:00', title:'上海时间未来消息', content:'政策 市场规模 万亿 渗透率 多场景 商业化', mediaName:'中国政府网'},
      {date:'2026-10-15 14:00:00', title:'前一日消息', content:'订单增长，产业化加速，跨行业应用。', mediaName:'工信部'}
    ],
    []
  );
  assert.equal(result.news.some(item => item.title.includes('上海时间早盘消息')), true);
  assert.equal(result.news.some(item => item.title.includes('上海时间未来消息')), false);
});

test('partial imagination evidence produces a confidence-weighted score without pretending all dimensions are known', () => {
  const partialNews = [
    {date:'2026-10-16 09:00:00', title:'人工智能应用政策推进', content:'政策支持产业化落地，应用加速。', mediaName:'中国政府网'},
    {date:'2026-10-15 14:00:00', title:'人工智能商业化提速', content:'多场景应用进入商业化阶段。', mediaName:'证券时报'},
    {date:'2026-10-14 10:00:00', title:'人工智能需求增长', content:'需求持续增长，产业扩张。', mediaName:'财联社'}
  ];
  const result = buildAutomaticPsychologyResearch(
    {...theme, candidateName:'', leaderName:'', candidateCode:'', leaderCode:''},
    partialNews,
    []
  );
  assert.equal(result.researchQuality.imagination.complete, false);
  assert.ok(result.imaginationResearch.technologyOptionality !== null);
  assert.ok(result.imaginationResearch.policyRunway !== null);
  assert.ok(result.imaginationResearch.marketSize === null);
  assert.ok(result.researchQuality.imagination.confidence > 0);
});

