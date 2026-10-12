const { normalizeCandidates } = require('./adapter/candidate_adapter');
const { calculateFactorScore } = require('./decision_engine/factor_score');
const { applyRiskAdjustment } = require('./decision_engine/risk_adjustment');
const { rankStocks } = require('./decision_engine/rank_engine');
const { generateDecision } = require('./decision_engine/decision_output');

const mockCandidates = [
  {
    symbol: 'AAA',
    capitalScore: 95,
    trendScore: 90,
    sectorScore: 92,
    volumeScore: 85,
    catalystScore: 80,
    riskLevel: 10
  },
  {
    symbol: 'BBB',
    capitalScore: 88,
    trendScore: 85,
    sectorScore: 90,
    volumeScore: 80,
    catalystScore: 75,
    riskLevel: 8
  }
];

function run() {
  const stocks = normalizeCandidates(mockCandidates);
  const scored = stocks.map(calculateFactorScore);
  const adjusted = scored.map(applyRiskAdjustment);
  const ranking = rankStocks(adjusted);
  const decision = generateDecision(ranking);

  console.log('V10.4.0 CORE');
  console.log(JSON.stringify(decision, null, 2));

  return decision;
}

if (require.main === module) run();

module.exports = { run };
