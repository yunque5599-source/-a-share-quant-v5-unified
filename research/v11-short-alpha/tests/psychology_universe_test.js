import test from 'node:test';
import assert from 'node:assert/strict';
import { _internal as universe } from '../../../api/psychology_universe.js';

const {
  normalizeConceptRow,
  isConceptBoardRow,
  normalizeThemeMemberRow,
  isThemeMemberRow,
  isNarrativeTheme,
  themeStrength,
  summarizeSourceCoverage,
  parseTencentCandidateQuotes,
  normalizeThemeName,
  parseThsStockConcepts,
  parseSinaConceptNodes,
  parseSinaNodeMembers
} = universe;

test('concept ranking accepts Eastmoney BK concept-board codes and requires price change', () => {
  const row = normalizeConceptRow({
    f12:'BK12345',
    f14:'人工智能',
    f3:'4.2',
    f6:'100000000',
    f62:'20000000',
    f184:'3.1',
    f104:'80',
    f105:'20',
    f106:'5',
    f134:'105',
    f128:'龙头科技',
    f140:'600001',
    f136:'9.8',
    f124:'1799999999'
  });

  assert.equal(row.code, 'BK12345');
  assert.equal(row.changePct, 4.2);
  assert.equal(row.leaderCode, '600001');
  assert.equal(isConceptBoardRow(row), true);
});

test('concept ranking rejects non-concept codes and missing change', () => {
  assert.equal(isConceptBoardRow({code:'123456',changePct:4}), false);
  assert.equal(isConceptBoardRow({code:'BK12345',changePct:null}), false);
  assert.equal(isConceptBoardRow({code:'',changePct:4}), false);
});

test('theme member normalization accepts six-digit stock codes', () => {
  const row = normalizeThemeMemberRow({
    f12:'600001',
    f14:'龙头科技',
    f3:'8.5',
    f6:'120000000',
    f8:'6.2',
    f62:'30000000'
  });

  assert.equal(row.code, '600001');
  assert.equal(row.pct, 8.5);
  assert.equal(row.mainNetCny, 30000000);
  assert.equal(isThemeMemberRow(row), true);
});

test('theme member normalization rejects malformed codes and missing change', () => {
  assert.equal(isThemeMemberRow({code:'60001',pct:8}), false);
  assert.equal(isThemeMemberRow({code:'BK12345',pct:8}), false);
  assert.equal(isThemeMemberRow({code:'600001',pct:null}), false);
});

test('narrative theme selector rejects valuation, holder-style and momentum classification boards', () => {
  for (const name of ['百元股','低市净率','机构重仓','昨日涨停','高股息']) {
    assert.equal(isNarrativeTheme({code:'BK12345',name}), false, name);
  }
  assert.equal(isNarrativeTheme({code:'BK12345',name:'人工智能'}), true);
  assert.equal(isNarrativeTheme({code:'BK12345',name:'机器人概念'}), true);
  assert.equal(themeStrength({changePct:5,mainNetPct:3,upCount:80,downCount:20,flatCount:0}) > 75, true);
});


test('source coverage reports missing concept and quote feeds as degraded', () => {
  const result = summarizeSourceCoverage({
    requestedCodes: 20, conceptRows: 0, quoteRows: 0, themeCount: 0,
    researchThemes: 0, sourceFailures: ['concept-ranking: HTTP 502']
  });
  assert.equal(result.degraded, true);
  assert.equal(result.status, 'DEGRADED_SOURCE_COVERAGE');
  assert.ok(result.warnings.includes('concept-ranking: HTTP 502'));
  assert.ok(result.warnings.includes('candidate-quotes-empty'));
});

test('source coverage degrades when every theme flow request fails', () => {
  const result = summarizeSourceCoverage({
    requestedCodes: 10, conceptRows: 80, quoteRows: 10, themeCount: 12,
    researchThemes: 6, membershipFailures: 0, flowFailures: 6,
    researchFailures: 0, sourceFailures: []
  });
  assert.equal(result.degraded, true);
  assert.ok(result.warnings.includes('all-theme-flow-requests-failed'));
});

test('source coverage remains available with populated source families and partial research warnings absent', () => {
  const result = summarizeSourceCoverage({
    requestedCodes: 10, conceptRows: 80, quoteRows: 10, themeCount: 12,
    researchThemes: 6, membershipFailures: 0, flowFailures: 1,
    researchFailures: 2, sourceFailures: []
  });
  assert.equal(result.degraded, false);
  assert.equal(result.status, 'SOURCE_COVERAGE_AVAILABLE');
});


test('Tencent quote fallback parses requested symbols, computes return and retains quote timestamp', () => {
  const raw = [
    'v_sz000001="1~平安银行~000001~10.50~10.00~10.01~100000~50000~50000~10.49~100~10.48~200~10.51~100~10.52~200~10.53~300~10.54~100~10.55~200~10.56~300~10.57~400~2026/10/26~15:00:00~00";',
    'v_sh600000="1~浦发银行~600000~8.20~8.00~8.01~100000~50000~50000~8.19~100~8.18~200~8.21~100~8.22~200~8.23~300~8.24~100~8.25~200~8.26~300~8.27~400~2026/10/26~15:00:00~00";',
    'v_sz300001="1~不请求的股票~300001~20.00~19.00~19.01~100000~50000~50000~19.99~100~19.98~200~20.01~100~20.02~200~20.03~300~20.04~100~20.05~200~20.06~300~20.07~400~2026/10/26~15:00:00~00";'
  ].join('');
  const result = parseTencentCandidateQuotes(raw, ['000001','600000']);
  assert.equal(result.size, 2);
  assert.equal(result.get('000001').name, '平安银行');
  assert.equal(result.get('000001').pct, 5);
  assert.equal(result.get('000001').source, 'tencent');
  assert.equal(result.get('000001').quoteTimestamp, Math.floor(Date.parse('2026-10-26T15:00:00+08:00') / 1000));
  assert.equal(result.has('300001'), false);
});

test('Tencent quote fallback ignores rows with missing or invalid previous close', () => {
  const raw = [
    'v_sz000001="1~平安银行~000001~10.50~0~10.01~100000~2026/10/26~15:00:00~00";',
    'v_sh600000="1~浦发银行~600000~N/A~8.00~8.01~100000~2026/10/26~15:00:00~00";'
  ].join('');
  assert.equal(parseTencentCandidateQuotes(raw, ['000001','600000']).size, 0);
});

test('source coverage degrades when quote fallback only covers part of the requested universe', () => {
  const result = summarizeSourceCoverage({
    requestedCodes: 10, conceptRows: 80, quoteRows: 7, themeCount: 12,
    researchThemes: 6, membershipFailures: 0, flowFailures: 1,
    researchFailures: 2, sourceFailures: []
  });
  assert.equal(result.degraded, true);
  assert.ok(result.warnings.includes('candidate-quotes-partial:7/10'));
});


test('10jqka concept parser extracts numbered table rows and deduplicates normalized names', () => {
  const html = `
    <table>
      <tr><th>序号</th><th>概念名称</th><th>龙头股</th></tr>
      <tr><td>1</td><td><a href="/gn/detail/code/301496/">白酒概念</a></td><td>贵州茅台</td></tr>
      <tr><td>2</td><td><a href="/gn/detail/code/300001/">人工智能</a></td><td>示例科技</td></tr>
      <tr><td>3</td><td><a href="/gn/detail/code/301496/">白酒</a></td><td>贵州茅台</td></tr>
      <tr><td>4</td><td>概念解析</td><td>说明</td></tr>
    </table>`;
  const concepts = parseThsStockConcepts(html);
  assert.equal(concepts.length, 2);
  assert.equal(concepts[0].name, '白酒概念');
  assert.equal(concepts[0].normalizedName, normalizeThemeName('白酒'));
  assert.equal(concepts[1].name, '人工智能');
});

test('Sina concept node parser discovers gn and chgn leaves from nested tree', () => {
  const tree = ['行情中心', [
    ['A股', [
      ['概念板块', [
        ['人工智能', '', 'gn_hwzn'],
        ['物理AI', '', 'chgn_701381']
      ]],
      ['行业', [['计算机', '', 'new_jsj']]]
    ]]
  ]];
  const nodes = parseSinaConceptNodes(tree);
  assert.equal(nodes.size, 2);
  assert.equal(nodes.get(normalizeThemeName('人工智能')).code, 'gn_hwzn');
  assert.equal(nodes.get(normalizeThemeName('物理AI')).code, 'chgn_701381');
});

test('Sina node member parser validates stock codes and numeric change values', () => {
  const rows = parseSinaNodeMembers([
    {symbol:'sh600519', code:'600519', name:'贵州茅台', trade:'1500', changepercent:'2.5', amount:'1000000', ticktime:'15:00:00'},
    {symbol:'sz000001', code:'000001', name:'平安银行', trade:'10', changepercent:'-1.2', amount:'200000', ticktime:'15:00:00'},
    {symbol:'bj430001', code:'430001', name:'北交所样本', trade:'5', changepercent:'3', amount:'10000'},
    {symbol:'sh600000', code:'600000', name:'无效涨幅', trade:'9', changepercent:'-', amount:'10000'}
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].code, '600519');
  assert.equal(rows[0].pct, 2.5);
  assert.equal(rows[1].pct, -1.2);
});

test('theme normalization matches concept labels with and without the generic suffix', () => {
  assert.equal(normalizeThemeName('人工智能 概念'), normalizeThemeName('人工智能'));
  assert.equal(normalizeThemeName('CPO（共封装光学）'), normalizeThemeName('CPO-共封装光学'));
});
