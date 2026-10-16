import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { adaptMarketPayload } from './adapter/market_adapter.js';
import { normalizeCandidates } from './adapter/candidate_adapter.js';
import { integrateCandidateFlow } from '../v11-short-alpha/candidate_flow.js';
import { normalizeMarket } from './adapter/market_adapter.js';
import { calculateFactorScore } from './decision_engine/factor_score.js';
import { applyRiskAdjustment } from './decision_engine/risk_adjustment.js';
import { rankStocks } from './decision_engine/rank_engine.js';
import { generateDecision } from './decision_engine/decision_output.js';

export const DEMO_CANDIDATES = Object.freeze([
  {
    symbol: '600001', name: '示例强势股',
    capitalScore: 100, trendScore: 100, sectorScore: 100, volumeScore: 100, catalystScore: 100,
    shortTermGainPct: 6, volatilityPct: 2, avgTurnover20dCny: 100_000_000
  },
  {
    symbol: '000002', name: '示例趋势股',
    capitalScore: 95, trendScore: 94, sectorScore: 92, volumeScore: 90, catalystScore: 85,
    shortTermGainPct: 6, volatilityPct: 2, avgTurnover20dCny: 100_000_000
  }
]);

export function evaluate(candidates = DEMO_CANDIDATES, marketInput = { marketRisk: 'normal' }) {
  const market = normalizeMarket(marketInput);
  const normalized = normalizeCandidates(candidates);
  const scored = normalized.map(calculateFactorScore);
  const adjusted = scored.map(stock => applyRiskAdjustment(stock, market.marketRisk));
  const ranking = rankStocks(adjusted);
  const decision = generateDecision(ranking, market.marketRisk);
  return { version: 'V10.4.0 CORE', market, ranking, ...decision };
}

export function evaluateReal(payload, marketInput, adapterOptions = {}) {
  const adapted = adaptMarketPayload(payload, adapterOptions);
  const result = evaluate(adapted.candidates, marketInput ?? adapted.market);
  return {
    ...result,
    source: adapted.source,
    sourceMetadata: adapted.metadata
  };
}

function displayScore(stock) {
  return stock ? String(stock.scores?.alpha ?? stock.adjustedScore) : '-';
}

export function printResult(result) {
  const [top1, top2] = result?.ranking ?? [];
  console.log(result?.version ?? 'V10.4.0 CORE');
  console.log('TOP1');
  console.log('股票: ' + (top1?.name || top1?.symbol || '-'));
  console.log('评分: ' + displayScore(top1));
  console.log('Score: ' + displayScore(top1));
  console.log('TOP2');
  console.log('股票: ' + (top2?.name || top2?.symbol || '-'));
  console.log('评分: ' + displayScore(top2));
  console.log('Score: ' + displayScore(top2));
  console.log('Decision: ' + (result?.action || 'WAIT'));
}

export function run(options = {}) {
  if (options.model && !['v1040', 'v11'].includes(options.model)) throw new Error('Unknown model: ' + options.model);
  const result = options.model === 'v11'
    ? integrateCandidateFlow(options.rawData ?? { data: { candidates: options.candidates ?? [] } }, {
        market: options.market, asOf: options.asOf
      })
    : options.rawData
    ? evaluateReal(options.rawData, options.market, options.adapterOptions)
    : evaluate(options.candidates ?? DEMO_CANDIDATES, options.market ?? { marketRisk: 'normal' });
  printResult(result);
  return result;
}

function dateOnly(value) {
  const date = String(value ?? new Date().toISOString().slice(0, 10)).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('prediction date must be YYYY-MM-DD');
  return date;
}

export async function savePrediction(result, options = {}) {
  const date = dateOnly(options.date);
  const outputDir = options.outputDir ??
    fileURLToPath(new URL('./data/predictions/', import.meta.url));
  await mkdir(outputDir, { recursive: true });
  const predictions = (result?.ranking ?? []).slice(0, 20).map(stock => ({
    date,
    stock: stock.symbol,
    symbol: stock.symbol,
    name: stock.name ?? stock.symbol,
    score: stock.adjustedScore,
    reason: result?.reason ?? '',
    reasons: stock.reasons ?? result?.reasons ?? [],
    risk: {
      ...stock.risks,
      penalty: stock.riskPenalty,
      missingInputs: stock.missingRiskInputs ?? []
    },
    decision: result?.action ?? 'WAIT'
  }));
  const document = {
    version: result?.version ?? 'V10.4.0 CORE',
    date,
    generatedAt: new Date().toISOString(),
    source: result?.source ?? 'demo',
    market: result?.market ?? null,
    decision: result?.action ?? 'WAIT',
    top1: predictions[0] ?? null,
    top2: predictions[1] ?? null,
    predictions
  };
  const outputPath = join(outputDir, date + '.json');
  await writeFile(outputPath, JSON.stringify(document, null, 2) + '\n', 'utf8');
  return { outputPath, document };
}

function cliValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function runCli() {
  const args = process.argv.slice(2);
  const inputPath = cliValue(args, '--input');
  const model = cliValue(args, '--model') ?? 'v1040';
  if (!['v1040', 'v11'].includes(model)) throw new Error('Unknown model: ' + model);
  if (!inputPath) {
    if (model === 'v11') throw new Error('V11 requires --input with candidate/history data');
    return run();
  }
  const rawData = JSON.parse(await readFile(resolve(inputPath), 'utf8'));
  const result = run({
    model, rawData, asOf: cliValue(args, '--date'),
    market: cliValue(args, '--market'),
    adapterOptions: { allowRiskProxies: args.includes('--allow-risk-proxies') }
  });
  // Phase 1 V11 produces scores only; keep earlier prediction records untouched.
  if (model === 'v11' || args.includes('--no-save')) return result;
  const saved = await savePrediction(result, {
    date: cliValue(args, '--date'),
    outputDir: process.env.V1040_PREDICTION_DIR
  });
  console.log('Prediction JSON: ' + saved.outputPath);
  return result;
}

const invokedDirectly = process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  runCli().catch(error => {
    console.error('V10.4.0 CORE failed: ' + error.message);
    process.exitCode = 1;
  });
}
