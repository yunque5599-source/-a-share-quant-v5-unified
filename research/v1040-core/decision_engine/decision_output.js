function generateDecision(ranking, marketRisk = 'NORMAL') {
  if (marketRisk === 'HIGH' || ranking.length === 0) {
    return {
      action: 'WAIT',
      reason: 'No acceptable opportunity'
    };
  }

  return {
    action: ranking[0].adjustedScore >= 85 ? 'BUY' : 'WATCH',
    portfolio: ranking.slice(0, 2).map((stock, index) => ({
      symbol: stock.symbol,
      weight: index === 0 ? 70 : 30,
      score: stock.adjustedScore
    }))
  };
}

module.exports = { generateDecision };
