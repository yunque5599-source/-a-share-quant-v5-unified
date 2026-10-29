import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {replayV15Snapshots} from './v15_replay.js';

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function runReplayCli(args = process.argv.slice(2)) {
  const includeUnqualified = args.includes('--include-unqualified');
  const paths = args.filter(arg => arg !== '--include-unqualified');
  if (paths.length < 2) {
    throw new Error(
      'Usage: node research/run_v15_replay.js daily_bars.json snapshot1.json [snapshot2.json ...] [--include-unqualified]\\n' +
      'daily_bars.json format: {"dailyBarsByCode":{"600001":[{"date":"2026-10-30","close":10,"high":10.5,"low":9.8,"isLimitUp":false}]}, "intradayBarsByCode":{}}'
    );
  }
  const [barsPath, ...snapshotPaths] = paths;
  const barsDocument = await readJson(barsPath);
  const dailyBarsByCode = barsDocument.dailyBarsByCode ?? barsDocument.barsByCode ?? {};
  const intradayBarsByCode = barsDocument.intradayBarsByCode ?? {};
  const snapshots = [];
  for (const path of snapshotPaths) {
    const document = await readJson(path);
    if (Array.isArray(document)) snapshots.push(...document);
    else if (Array.isArray(document?.snapshots)) snapshots.push(...document.snapshots);
    else snapshots.push(document);
  }
  return replayV15Snapshots({snapshots, dailyBarsByCode, intradayBarsByCode, includeUnqualified});
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedAsScript) {
  runReplayCli().then(report => {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  }).catch(error => {
    process.stderr.write(String(error?.message ?? error) + '\n');
    process.exitCode = 2;
  });
}
