import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeV12Factors } from '../analyze_v12_factors.js';

const asOfs = ['2026-10-01T03:15:00Z', '2026-10-02T05:30:00Z'];

function outcomes(index, missingT1 = false) {
  return Object.fromEntries([1, 2, 3, 4, 5].map(horizon => [
    't' + horizon,
    {
      date:'2026-10-' + String(1 + index + horizon).padStart(2, '0'),
      returnPct:missingT1 && horizon === 1 ? null : 8 - index + horizon,
      marketExcessReturnPct:missingT1 && horizon === 1 ? null : 7 - index + horizon,
      sectorExcessReturnPct:missingT1 && horizon === 1 ? null : 6 - index + horizon,
      mfePct:10 - index + horizon,
      maePct:-1 - index
    }
  ]));
}

function candidate(index, options = {}) {
  const score = 100 - index * 10;
  const momentum = {score};
  return {
    symbol:'60000' + (index + 1),
    features:{
      trendStructure:{score},
      momentum,
      capital:{score:score - 2, flowTiming:index < 3 ? 'early-inflow' : 'outflow'},
      volume:options.futureFeature
        ? {score:score - 4, asOf:'2026-11-01T00:00:00+08:00'}
        : {score:score - 4},
      sector:{score:score - 6},
      risk:{score:100 - index}
    },
    scores:{timing:score - 8, timingRaw:score - 8},
    timing:{score:score - 8},
    psychology:{
      score:score - 5,
      scoreRaw:score - 5,
      primaryTheme:{code:'AI'},
      themes:[{
        themeCode:'AI',
        score:score - 7,
        components:{
          leader:{score:index < 2 ? 85 : 45},
          imagination:{score:index < 2 ? 88 : 40}
        }
      }]
    },
    horizons:outcomes(index, options.missingT1)
  };
}

function snapshot(asOf, options = {}) {
  const rows = Array.from({length:6}, (_, index) =>
    candidate(index, {...options, missingT1:options.noMissingT1 ? false : index === 0}));
  return {
    schema:'v12-factor-validation-test-v1',
    dataKind:'synthetic',
    synthetic:true,
    asOf,
    decision:{
      asOf,
      market:options.market ?? {marketRisk:'weak', emotion:{label:'FEVER'}},
      datasetCandidates:rows
    },
    marketRegime:options.regime,
    marketEmotion:options.emotion
  };
}

test('factor validation covers all factors, horizons, bands and state/time splits', () => {
  const report = analyzeV12Factors({
    snapshots:[
      snapshot(asOfs[0]),
      snapshot(asOfs[1], {
        regime:'bull',
        emotion:{label:'NEUTRAL'},
        market:{regime:'bull', emotion:{label:'NEUTRAL'}}
      })
    ]
  });
  assert.equal(report.schema, 'v12-factor-validation-v2');
  assert.equal(report.status, 'INSUFFICIENT_SAMPLE');
  assert.deepEqual(report.factorNames, [
    'trendStructure','momentum','capitalFlow','volume','sector',
    'psychology','leader','imagination','timing','risk'
  ]);
  assert.equal(Object.keys(report.factors).length, 10);
  for (const factor of report.factorNames) {
    assert.equal(Object.keys(report.factors[factor].overall).length, 5);
    assert.ok(report.factors[factor].scoreBands['90_100']);
    assert.ok(report.factors[factor].byMarketRegime.bear);
    assert.ok(report.factors[factor].byMarketRegime.bull);
    assert.ok(report.factors[factor].byEmotion.high);
    assert.ok(report.factors[factor].byTimeBucket['11:15']);
    assert.ok(report.factors[factor].byTimeBucket['13:30']);
  }
  assert.equal(report.mlReadiness.status, 'INSUFFICIENT_SAMPLE');
  assert.equal(report.provenance.synthetic.status, 'INSUFFICIENT_SAMPLE');
});

test('quantiles are fixed before missing forward outcomes are removed', () => {
  const report = analyzeV12Factors({
    snapshots:[snapshot(asOfs[0], {market:{regime:'bull', emotion:{label:'NEUTRAL'}}})]
  });
  const t1 = report.factors.momentum.overall.t1;
  assert.equal(t1.top20.selectionCount, 2);
  assert.equal(t1.top20.missingOutcomeCount, 1);
  assert.equal(t1.top20.availableReturnCount, 1);
  assert.equal(t1.top20.averageReturnPct, 8);
  assert.equal(t1.bottom20.selectionCount, 2);
});

test('future feature timestamps and invalid outcome dates are excluded', () => {
  const future = snapshot(asOfs[0], {futureFeature:true, noMissingT1:true});
  future.decision.datasetCandidates[1].horizons.t1.date = '2026-09-30';
  const report = analyzeV12Factors({snapshots:[future]});
  assert.ok(report.diagnostics.invalidFeatureTimestamps > 0);
  assert.ok(report.diagnostics.invalidOutcomeDates > 0);
  assert.equal(report.factors.momentum.overall.t1.pairCount, 5);
  assert.equal(report.leakagePolicy.featureTimestamps.includes('Future/invalid'), true);
  assert.equal(report.leakagePolicy.outcomeDate.includes('Strictly'), true);
});
