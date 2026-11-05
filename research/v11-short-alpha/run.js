import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { integrateCandidateFlow } from './candidate_flow.js';

export function run(input = {}, options = {}) {
  return integrateCandidateFlow(input, options);
}

async function main(args) {
  const index = args.indexOf('--input');
  if (index < 0 || !args[index + 1]) {
    throw new Error('Usage: node research/v11-short-alpha/run.js --input FILE');
  }
  const input = JSON.parse(await readFile(resolve(args[index + 1]), 'utf8'));
  console.log(JSON.stringify(run(input), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error('V11 Short Alpha: ' + error.message);
    process.exitCode = 1;
  });
}
