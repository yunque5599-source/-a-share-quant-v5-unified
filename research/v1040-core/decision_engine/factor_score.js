function calculateFactorScore(stock) {
  const score =
    (stock.capitalScore || 0) * 0.30 +
    (stock.trendScore || 0) * 0.25 +
    (stock.sectorScore || 0) * 0.20 +
    (stock.volumeScore || 0) * 0.15 +
    (stock.catalystScore || 0) * 0.10;

  return {
    ...stock,
    factorScore: Number(score.toFixed(2))
  };
}

module.exports = { calculateFactorScore };
