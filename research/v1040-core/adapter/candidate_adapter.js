function normalizeCandidate(raw) {
  return {
    symbol: raw.symbol || raw.code,
    capitalScore: Number(raw.capitalScore || 0),
    trendScore: Number(raw.trendScore || 0),
    sectorScore: Number(raw.sectorScore || 0),
    volumeScore: Number(raw.volumeScore || 0),
    catalystScore: Number(raw.catalystScore || 0),
    riskLevel: Number(raw.riskLevel || 0)
  };
}

function normalizeCandidates(list) {
  return list.map(normalizeCandidate).filter(item => item.symbol);
}

module.exports = { normalizeCandidate, normalizeCandidates };
