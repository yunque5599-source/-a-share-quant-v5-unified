import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rankCandidates } from './precursor_score.js';
import { addHistoricalIndustryContext, isTrueLimitUpOutcome } from './historical_replay.js';
import { readNdjson } from './walk_forward_eval.js';

function parseArgs(argv) {
  const out = {
    input: 'output/v13-history-replay/replay_candidates.ndjson',
    qualityReport: 'output/v13-history-replay/replay_report.json',
    targets: 'research/v13-limitup-precursor/target_symbols.json',
    output: 'output/v13-history-replay/holdout_audit.json'
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input' && argv[i + 1]) out.input = argv[++i];
    else if (argv[i] === '--quality-report' && argv[i + 1]) out.qualityReport = argv[++i];
    else if (argv[i] === '--targets' && argv[i + 1]) out.targets = argv[++i];
    else if (argv[i] === '--output' && argv[i + 1]) out.output = argv[++i];
  }
  return out;
}

function rankingCodes(rows) {
  return rows.map(row => row.code);
}
function laneRanks(rows, field, minimum = 0) {
  return [...rows]
    .filter(row => Number(row.components?.[field]) >= minimum)
    .sort((a, b) => Number(b.components?.[field]) - Number(a.components?.[field]) || b.confidence - a.confidence)
    .map(row => row.code);
}
function targetRows(targets, ranked, laneRanksByCode, measurable) {
  const indexByCode = new Map(ranked.map((row, index) => [row.code, { row, rank: index + 1 }]));
  return targets.map(target => {
    const hit = indexByCode.get(String(target.code));
    return {
      code: String(target.code),
      name: target.name,
      board: target.board,
      signalDate: target.signalDate ?? null,
      outcomeDate: target.outcomeDate ?? null,
      knownOutcome: target.outcome ?? null,
      isTrueLimitUp: isTrueLimitUpOutcome(target.outcome),
      rank: hit?.rank ?? null,
      inTop10: measurable ? Boolean(hit && hit.rank <= 10) : null,
      inTop30: measurable ? Boolean(hit && hit.rank <= 30) : null,
      inTop50: measurable ? Boolean(hit && hit.rank <= 50) : null,
      score: hit?.row.score ?? null,
      scorePath: hit?.row.scorePath ?? null,
      setup: hit?.row.setup ?? null,
      confidence: hit?.row.confidence ?? null,
      components: hit?.row.components ?? null,
      riskFlags: hit?.row.riskFlags ?? [],
      emotionRepairWatchRank: laneRanksByCode.emotionRepair.indexOf(String(target.code)) >= 0
        ? laneRanksByCode.emotionRepair.indexOf(String(target.code)) + 1 : null,
      oversoldWatchRank: laneRanksByCode.oversold.indexOf(String(target.code)) >= 0
        ? laneRanksByCode.oversold.indexOf(String(target.code)) + 1 : null,
      earlyTurnComponentRank: laneRanksByCode.earlyTurn.indexOf(String(target.code)) >= 0
        ? laneRanksByCode.earlyTurn.indexOf(String(target.code)) + 1 : null
    };
  });
}

export function evaluateHoldoutAudit(candidates, {
  asOf, targets = [], sourceCoveragePct = null
} = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(asOf ?? ''))) throw new Error('evaluateHoldoutAudit requires asOf YYYY-MM-DD');
  const preCutoff = (Array.isArray(candidates) ? candidates : []).map(stock => ({
    ...stock,
    asOf,
    bars: (Array.isArray(stock.bars) ? stock.bars : []).filter(bar => /^\d{4}-\d{2}-\d{2}$/.test(String(bar?.date ?? '')) && bar.date <= asOf),
    flows: (Array.isArray(stock.flows) ? stock.flows : []).filter(flow => /^\d{4}-\d{2}-\d{2}$/.test(String(flow?.date ?? '')) && flow.date <= asOf)
  })).filter(stock => stock.bars.length >= 25);
  const contextual = addHistoricalIndustryContext(preCutoff);
  const enriched = contextual.map(stock => {
    const latest = stock.bars.at(-1);
    return {
      ...stock,
      isST: Boolean(stock.isST) || /ST|退/i.test(String(stock.name ?? '')),
      amount: latest?.amount,
      turnoverRate: latest?.turnoverRate
    };
  });
  const scoreVariants = [
    ['current', 'v13-current'],
    ['coreOnly', 'v13-core-only'],
    ['earlyTurn', 'v13-early-turn']
  ];
  const rankedByVariant = Object.fromEntries(scoreVariants.map(([key, modelVariant]) => [
    key, rankCandidates(enriched, { asOf, modelVariant })
  ]));
  rankedByVariant.momentumBaseline = [...rankedByVariant.current].sort((a, b) => {
    const ar = Number.isFinite(a.features?.r5Pct) ? a.features.r5Pct : -Infinity;
    const br = Number.isFinite(b.features?.r5Pct) ? b.features.r5Pct : -Infinity;
    return br - ar || b.confidence - a.confidence;
  });
  const reportVariants = [...scoreVariants.map(([key]) => key), 'momentumBaseline'];
  const current = rankedByVariant.current;
  const emotionRepair = laneRanks(current, 'emotionRepair', 65);
  const oversold = laneRanks(current, 'oversoldReversal', 65);
  const earlyTurn = laneRanks(current, 'earlyTurn', 0);
  const laneRanksByCode = { emotionRepair, oversold, earlyTurn };
  const qualityCoverage = Number.isFinite(Number(sourceCoveragePct)) ? Number(sourceCoveragePct) : null;
  const targetCodes = targets.map(target => String(target.code));
  const missingTargets = targetCodes.filter(code => !current.some(row => row.code === code));
  const measurable = qualityCoverage !== null && qualityCoverage >= 90 && missingTargets.length === 0;
  const variantsReport = {};
  for (const key of reportVariants) {
    const ranked = rankedByVariant[key];
    const audited = targetRows(targets, ranked, laneRanksByCode, measurable);
    const trueLimitUps = audited.filter(row => row.isTrueLimitUp);
    variantsReport[key] = {
      top10: ranked.slice(0, 10).map((row, index) => ({ rank: index + 1, code: row.code, name: row.name, score: row.score, scorePath: row.scorePath, setup: row.setup })),
      top30: ranked.slice(0, 30).map((row, index) => ({ rank: index + 1, code: row.code, name: row.name, score: row.score, scorePath: row.scorePath, setup: row.setup })),
      trueLimitUpTargetCount: trueLimitUps.length,
      trueLimitUpTargetsTop10: measurable ? trueLimitUps.filter(row => row.inTop10).length : null,
      trueLimitUpTargetsTop30: measurable ? trueLimitUps.filter(row => row.inTop30).length : null,
      targets: audited
    };
  }
  return {
    model: 'V13-limitup-precursor-holdout-audit',
    asOf,
    status: measurable ? 'MEASURABLE' : 'NOT_MEASURABLE',
    measurable,
    sourceCoveragePct: qualityCoverage,
    targetCount: targets.length,
    targetScoredCount: targetCodes.length - missingTargets.length,
    missingTargets,
    validationReasons: [
      ...(qualityCoverage === null ? ['source-bar-coverage-missing'] : qualityCoverage < 90 ? ['historical-bar-coverage-below-90pct'] : []),
      ...(missingTargets.length ? ['one-or-more-holdout-targets-not-scored'] : [])
    ],
    dataPolicy: {
      features: 'All K-line and flow rows after asOf are removed before sector context or scoring is calculated',
      labels: 'Target outcomes are read only after all three candidate rankings and observation lanes are generated',
      variants: 'Legacy blended score, core-only score, experimental early-turn score, and a raw five-session-momentum baseline; emotion-repair and oversold are independent observation lanes',
      noHardcoding: 'Target stock codes do not enter score formulas or ranking weights'
    },
    laneTop10: {
      emotionRepair: emotionRepair.slice(0, 10),
      oversold: oversold.slice(0, 10),
      earlyTurn: earlyTurn.slice(0, 10)
    },
    variants: variantsReport
  };
}

async function main(argv) {
  const args = parseArgs(argv);
  const candidates = await readNdjson(resolve(args.input));
  const sourceReport = JSON.parse(await readFile(resolve(args.qualityReport), 'utf8'));
  const targetsFile = JSON.parse(await readFile(resolve(args.targets), 'utf8'));
  const asOf = String(sourceReport.asOf ?? '');
  const targets = (Array.isArray(targetsFile.targets) ? targetsFile.targets : [])
    .filter(target => !target.signalDate || target.signalDate === asOf);
  const report = evaluateHoldoutAudit(candidates, {
    asOf, targets, sourceCoveragePct: sourceReport.coverage?.barCoveragePct
  });
  const outputPath = resolve(args.output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    model: report.model, asOf: report.asOf, status: report.status,
    sourceCoveragePct: report.sourceCoveragePct, targetScoredCount: report.targetScoredCount,
    missingTargets: report.missingTargets,
    variants: Object.fromEntries(Object.entries(report.variants).map(([key, value]) => [key, {
      trueLimitUpTargetCount: value.trueLimitUpTargetCount,
      trueLimitUpTargetsTop10: value.trueLimitUpTargetsTop10,
      trueLimitUpTargetsTop30: value.trueLimitUpTargetsTop30,
      targets: value.targets.map(row => ({ code: row.code, rank: row.rank, score: row.score, scorePath: row.scorePath, emotionRepairWatchRank: row.emotionRepairWatchRank, oversoldWatchRank: row.oversoldWatchRank, earlyTurnComponentRank: row.earlyTurnComponentRank }))
    }]))
  }, null, 2));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
