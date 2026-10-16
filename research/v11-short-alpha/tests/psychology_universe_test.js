import test from 'node:test';
import assert from 'node:assert/strict';
import { _internal as universe } from '../../../api/psychology_universe.js';

const {
  normalizeConceptRow,
  isConceptBoardRow,
  normalizeThemeMemberRow,
  isThemeMemberRow,
  isNarrativeTheme,
  themeStrength
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
