'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { rankCandidates } from './precursor_score.js';

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}
const inputPath = arg('--input');
const asOf = arg('--as-of');
const limit = Math.max(1, Number(arg('--limit') || 30));

if (!inputPath) {
  console.error('Usage: node research/v13-limitup-precursor/replay.js --input <candidates.json> [--as-of YYYY-MM-DD] [--limit 30]');
  console.error('Input must be a JSON array using the documented bars/flows/sector schema. No live data is fetched.');
  process.exitCode = 2;
} else {
  const resolved = path.resolve(inputPath);
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('Input JSON must be an array of candidate objects.');
  const ranked = rankCandidates(parsed, { asOf: asOf || undefined });
  const output = {
    model: 'V13-limitup-precursor-research',
    asOf: asOf || 'each-symbol-latest-available-date',
    horizonTradingDays: [1, 5],
    inputCount: parsed.length,
    scoredCount: ranked.length,
    top: ranked.slice(0, limit)
  };
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}
