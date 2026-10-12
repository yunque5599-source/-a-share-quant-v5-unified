function applyRiskAdjustment(stock) {
  const penalty =
    (stock.volatilityRisk || 0) * 0.4 +
    (stock.liquidityRisk || 0) * 0.3 +
    (stock.positionRisk || 0) * 0.3;

  return {
    ...stock,
    riskPenalty: Number(penalty.toFixed(2)),
    adjustedScore: Number((stock.factorScore - penalty).toFixed(2))
  };
}

module.exports = { applyRiskAdjustment };
