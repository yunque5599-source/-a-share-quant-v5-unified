function rankStocks(stocks) {
  return [...stocks]
    .filter(stock => stock.adjustedScore >= 80)
    .sort((a, b) => b.adjustedScore - a.adjustedScore)
    .map((stock, index) => ({
      ...stock,
      rank: index + 1
    }));
}

module.exports = { rankStocks };
