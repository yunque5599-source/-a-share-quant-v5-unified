function scoreOf(stock) {
  return Number.isFinite(Number(stock?.adjustedScore)) ? Number(stock.adjustedScore) : -Infinity;
}

export function rankStocks(stocks = []) {
  if (!Array.isArray(stocks)) return [];
  return [...stocks].filter(Boolean)
    .sort((left, right) => scoreOf(right) - scoreOf(left) ||
      String(left.symbol ?? '').localeCompare(String(right.symbol ?? '')))
    .map((stock, index) => ({ ...stock, rank: index + 1 }));
}
