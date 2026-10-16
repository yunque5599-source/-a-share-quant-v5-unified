const mainBoard = row => /^(00|60)\d{4}$/.test(String(row?.f12 ?? row?.symbol ?? row?.code ?? ''));
const codeOf = row => String(row?.f12 ?? row?.symbol ?? row?.code ?? '');

function rankedBy(candidates, key) {
  return [...candidates].sort((a,b) => {
    const ar = Number(a?.ranks?.[key]);
    const br = Number(b?.ranks?.[key]);
    const av = Number.isFinite(ar) ? ar : Infinity;
    const bv = Number.isFinite(br) ? br : Infinity;
    return av - bv || (Number(b?.rankScore ?? 0) - Number(a?.rankScore ?? 0)) ||
      codeOf(a).localeCompare(codeOf(b));
  });
}

/**
 * Select a diversified deep-research pool from the fast 6-list ranking.
 * The aggregate rank remains the primary bucket, while independent capital and
 * momentum buckets deliberately preserve earlier/less-crowded candidates.
 */
export function selectV12Candidates(input = [], max = 30) {
  const candidates = Array.isArray(input)
    ? input.filter(mainBoard)
    : [];
  const selected = [];
  const seen = new Set();
  const add = (rows, take) => {
    let added = 0;
    for (const row of rows) {
      if (selected.length >= max || added >= take) return;
      const code = codeOf(row);
      if (!code || seen.has(code)) continue;
      seen.add(code);
      selected.push(row);
      added += 1;
    }
  };

  add([...candidates].sort((a,b) =>
    Number(b?.rankScore ?? 0) - Number(a?.rankScore ?? 0) ||
    codeOf(a).localeCompare(codeOf(b))), 10);
  add(rankedBy(candidates, 'mainNet'), 6);
  add(rankedBy(candidates, 'dayMomentum'), 5);
  add(rankedBy(candidates, 'swingMomentum'), 5);
  add(rankedBy(candidates, 'mainPct'), 4);
  add([...candidates].sort((a,b) =>
    Number(b?.f6 ?? 0) - Number(a?.f6 ?? 0) ||
    codeOf(a).localeCompare(codeOf(b))), max - selected.length);

  return selected.slice(0, max);
}

export const _internal = { mainBoard, codeOf, rankedBy };
