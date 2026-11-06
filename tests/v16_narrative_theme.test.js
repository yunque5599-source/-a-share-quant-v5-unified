import test from 'node:test';
import assert from 'node:assert/strict';
import {extractNarrativeTags, scoreNarrativeThemes} from '../research/v16/narrative_theme.js';

function stock(code, name, pct, amount = 100, nearLimitUpProxy = false) {
  return {code, name, pct, amount, turnoverPct: 5, nearLimitUpProxy};
}
function snapshot(tradeDate, stocks, sourceScope = 'full-market') {
  return {tradeDate, capturedAt: tradeDate + 'T15:10:00+08:00', sourceScope, stocks};
}
const sheepStocks = [
  ['002086','东方海洋'],
  ['600261','阳光照明'],
  ['002696','百洋股份'],
  ['002172','澳洋健康'],
  ['600327','大东方']
];

test('lexical name-theme matching supports overlapping tags and avoids unrelated names', () => {
  assert.deepEqual(extractNarrativeTags('东方海洋'), ['sheep_homophone','oriental_name']);
  assert.deepEqual(extractNarrativeTags('七匹狼'), ['wolf_name']);
  assert.deepEqual(extractNarrativeTags('阳光照明'), ['sheep_homophone']);
  assert.deepEqual(extractNarrativeTags('浦发银行'), []);
});

test('theme heat and diffusion use current and prior point-in-time observations', () => {
  const previous = snapshot('2026-11-05', sheepStocks.map(([code,name]) => stock(code,name,-1,100,false)));
  const current = snapshot('2026-11-06', sheepStocks.map(([code,name],index) => stock(code,name,6 + index,200 - index * 20,index < 2)));
  const result = scoreNarrativeThemes({snapshots:[previous,current],asOf:'2026-11-06'});
  const sheep = result.themes.find(row => row.theme_key === 'sheep_homophone');
  assert.equal(sheep.member_count,5);
  assert.ok(sheep.name_theme_heat_score >= 65);
  assert.ok(sheep.theme_diffusion_speed > 50);
  assert.equal(sheep.fundamental_overlap_score,null);
  assert.equal(sheep.speculative_exhaustion_risk,null);
  assert.equal(sheep.speculative_exhaustion_status,'NOT_MEASURABLE');
  assert.equal(sheep.stage,'DIFFUSING');
});

test('one snapshot does not fabricate diffusion, exhaustion or fundamental overlap', () => {
  const current = snapshot('2026-11-06', sheepStocks.map(([code,name]) => stock(code,name,5)));
  const result = scoreNarrativeThemes({snapshots:[current],asOf:'2026-11-06'});
  const sheep = result.themes.find(row => row.theme_key === 'sheep_homophone');
  assert.equal(sheep.name_theme_heat_score !== null,true);
  assert.equal(sheep.theme_diffusion_speed,null);
  assert.equal(sheep.speculative_exhaustion_risk,null);
  assert.equal(sheep.fundamental_overlap_score,null);
});

test('verified and dated fundamental evidence is required for overlap score', () => {
  const current = snapshot('2026-11-06', sheepStocks.map(([code,name]) => stock(code,name,3)));
  const result = scoreNarrativeThemes({
    snapshots:[current],
    asOf:'2026-11-06',
    verifiedEvidence:[
      {verified:true,sourceUrl:'https://example.com/a',eventDate:'2026-11-06',themeKey:'sheep_homophone',relevanceScore:80},
      {verified:false,sourceUrl:'https://example.com/b',eventDate:'2026-11-06',themeKey:'sheep_homophone',relevanceScore:100},
      {verified:true,sourceUrl:'https://example.com/c',eventDate:'2026-11-07',themeKey:'sheep_homophone',relevanceScore:100}
    ]
  });
  const sheep = result.themes.find(row => row.theme_key === 'sheep_homophone');
  assert.equal(sheep.fundamental_overlap_score,80);
  assert.equal(sheep.fundamental_overlap_count,1);
  assert.equal(sheep.fundamental_overlap_status,'MEASURABLE');
});

test('multi-session run-up, concentration and breadth reversal raise exhaustion risk', () => {
  const day1 = snapshot('2026-11-04', sheepStocks.map(([code,name]) => stock(code,name,15,100,false)));
  const day2 = snapshot('2026-11-05', sheepStocks.map(([code,name]) => stock(code,name,15,100,false)));
  const day3 = snapshot('2026-11-06', sheepStocks.map(([code,name],index) =>
    stock(code,name,index < 3 ? -2 : 10,[100,80,70,40,30][index],index >= 3)
  ));
  const result = scoreNarrativeThemes({snapshots:[day1,day2,day3],asOf:'2026-11-06'});
  const sheep = result.themes.find(row => row.theme_key === 'sheep_homophone');
  assert.ok(sheep.median_3d_cohort_return_pct > 20);
  assert.ok(sheep.speculative_exhaustion_risk >= 75);
  assert.equal(sheep.stage,'EXHAUSTION_RISK');
});

test('partial-universe observations reduce theme confidence', () => {
  const stocks = sheepStocks.map(([code,name]) => stock(code,name,4));
  const full = scoreNarrativeThemes({snapshots:[snapshot('2026-11-06',stocks,'full-market')],asOf:'2026-11-06'});
  const partial = scoreNarrativeThemes({snapshots:[snapshot('2026-11-06',stocks,'partial-market')],asOf:'2026-11-06'});
  const fullScore = full.themes.find(row => row.theme_key === 'sheep_homophone').confidence;
  const partialScore = partial.themes.find(row => row.theme_key === 'sheep_homophone').confidence;
  assert.ok(partialScore < fullScore);
});

test('future theme snapshots are excluded from an as-of replay', () => {
  const result = scoreNarrativeThemes({
    snapshots:[
      snapshot('2026-11-06',[stock('002086','东方海洋',3)]),
      snapshot('2026-11-07',[stock('002086','东方海洋',10)])
    ],
    asOf:'2026-11-06'
  });
  assert.equal(result.snapshot_count,1);
  assert.equal(result.asOf,'2026-11-06');
});
