import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { replayForwardReturns } from './forward_return_replay.js';
import { calculateExitScore, evaluateExitAtDate } from './exit_score.js';

export function run(input) {
  return {
    version: 'V10.4.1 Short Alpha',
    replay: input.replay ? replayForwardReturns(input.replay) : null,
    exits: (Array.isArray(input.positions) ? input.positions : []).map(position =>
      position.bars
        ? evaluateExitAtDate({ position, bars: position.bars, sessions: input.sessions, asOfDate: input.asOfDate, market: input.market }, input.exitOptions)
        : calculateExitScore(position, input.market, input.exitOptions))
  };
}

async function main(args) {
  const inputIndex = args.indexOf('--input');
  if (inputIndex < 0 || !args[inputIndex + 1]) {
    throw new Error('Usage: node research/v10.4.1-short-alpha/run.js --input FILE [--output NEW_FILE]');
  }
  const input = JSON.parse(await readFile(resolve(args[inputIndex + 1]), 'utf8'));
  const report = run(input);
  const outputIndex = args.indexOf('--output');
  if (outputIndex >= 0) {
    if (!args[outputIndex + 1]) throw new Error('--output requires a path');
    const outputPath = resolve(args[outputIndex + 1]);
    await mkdir(dirname(outputPath), { recursive: true });
    // Reports never replace an earlier saved result.
    await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  }
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error('Short Alpha: ' + error.message);
    process.exitCode = 1;
  });
}
