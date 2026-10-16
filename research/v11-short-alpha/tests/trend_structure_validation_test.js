import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTrendStructure } from '../analyze_trend_structure.js';

function row(score, value, stage = 'ignition') {
  return {
    symbol:String(600000 + score),
    features:{
      trendStructure:{score},
      capital:{flowTiming:'early-inflow', earlyNetCny:10, recentNetCny:20}
    },
    psychology:{
      stage,
      primaryTheme:{code:'AI'},
      themes:[{themeCode:'AI',components:{
        leader:{score:80}, imagination:{score:82}
      }}],
      fomoRisk:{score:stage === 'acceleration' ? 80 : 30}
    },
    horizons:{
      t1:{returnPct:value,marketExcessReturnPct:value - 1,sectorExcessReturnPct:value - 2,mfePct:value + 2,maePct:-1},
      t2:{returnPct:value + 1,marketExcessReturnPct:value,sectorExcessReturnPct:value - 1,mfePct:value + 3,maePct:-1},
      t3:{returnPct:value + 2,marketExcessReturnPct:value + 1,sectorExcessReturnPct:value,mfePct:value + 4,maePct:-1},
      t4:{returnPct:value + 3,marketExcessReturnPct:value + 2,sectorExcessReturnPct:value + 1,mfePct:value + 5,maePct:-1},
      t5:{returnPct:value + 4,marketExcessReturnPct:value + 3,sectorExcessReturnPct:value + 2,mfePct:value + 6,maePct:-1}
    }
  };
}

test('trend validation reports rank metrics and independent snapshot quantiles', () => {
  const first = [row(95, 5), row(85, 3), row(75, 1), row(65, -1), row(55, -3)];
  const second = [row(96, 6, 'acceleration'), row(86, 4, 'acceleration'),
    row(76, 2, 'neutral'), row(66, 0, 'neutral'), row(56, -2, 'neutral')];
  const result = analyzeTrendStructure({snapshots:[
    {asOf:'2026-01-30',signals:first},
    {asOf:'2026-01-31',signals:second}
  ]});
  assert.equal(result.schema,'trend-structure-analysis-v1');
  assert.equal(result.overall.t1.pairCount,10);
  assert.ok(result.overall.t1.rankIC > 0);
  assert.ok(result.overall.t1.spearman > 0);
  assert.equal(result.overall.t1.top20.sampleCount,2);
  assert.ok(result.overall.t1.topBottomSpreadPct > 0);
  assert.ok(result.overall.t5.top10.averageReturnPct !== null);
});

test('trend validation reports psychology, capital, theme, leader, imagination and FOMO combinations', () => {
  const result = analyzeTrendStructure({
    snapshots:[{asOf:'2026-01-30',signals:[
      row(90,5,'ignition'), row(88,4,'acceleration'), row(60,1,'neutral')
    ]}]
  });
  assert.ok(result.combinations.trendStrong_emotionIgnition.t1.t1?.sampleCount >= 0);
  assert.equal(result.combinations.trendStrong_emotionAcceleration.t1.t1?.sampleCount, 1);
  assert.equal(result.combinations.trendStrong_capitalEarlyOrAccelerating.t1.t1?.sampleCount, 2);
  assert.equal(result.combinations.trendStrong_leader.t1.t1?.sampleCount, 2);
  assert.equal(result.combinations.trendStrong_imaginationHigh.t1.t1?.sampleCount, 2);
  assert.equal(result.combinations.trendStrong_fomoHigh.t1.t1?.sampleCount, 1);
});
