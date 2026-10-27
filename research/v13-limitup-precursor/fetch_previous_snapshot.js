#!/usr/bin/env node
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const repo = process.env.GITHUB_REPOSITORY ?? 'yunque5599-source/-a-share-quant-v5-unified';
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
const api = process.env.GITHUB_API_URL ?? 'https://api.github.com';
const currentRunId = Number(process.env.GITHUB_RUN_ID ?? 0);
const branch = process.env.GITHUB_REF_NAME ?? 'research/v13-limitup-precursor';
const outputPath = resolve(process.env.PREVIOUS_SNAPSHOT_OUTPUT ?? 'output/v13-live-snapshots/previous/snapshot.json');

function chinaDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit'
  }).formatToParts(new Date());
  const get = key => parts.find(part => part.type === key)?.value;
  return get('year') + '-' + get('month') + '-' + get('day');
}

async function apiJson(url) {
  const response = await fetch(url, {
    headers:{
      accept:'application/vnd.github+json',
      authorization:'Bearer ' + token,
      'x-github-api-version':'2022-11-28'
    },
    cache:'no-store'
  });
  if (!response.ok) throw new Error('GitHub API ' + response.status + ' for ' + url);
  return response.json();
}

async function findSnapshotFile(directory) {
  const entries = await readdir(directory, {withFileTypes:true});
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = await findSnapshotFile(full);
      if (found) return found;
    } else if (entry.isFile() && entry.name === 'snapshot.json') {
      return full;
    }
  }
  return null;
}

async function downloadArtifact(artifact) {
  const url = api + '/repos/' + repo + '/actions/artifacts/' + artifact.id + '/zip';
  const response = await fetch(url, {
    headers:{
      accept:'application/vnd.github+json',
      authorization:'Bearer ' + token,
      'x-github-api-version':'2022-11-28'
    },
    cache:'no-store'
  });
  if (!response.ok) throw new Error('Artifact download HTTP ' + response.status);
  const temporary = await mkdtemp(join(tmpdir(), 'v13-prior-snapshot-'));
  try {
    const zipPath = join(temporary, 'artifact.zip');
    const extractPath = join(temporary, 'extracted');
    await mkdir(extractPath, {recursive:true});
    await writeFile(zipPath, Buffer.from(await response.arrayBuffer()));
    execFileSync('unzip', ['-q', zipPath, '-d', extractPath]);
    const snapshotPath = await findSnapshotFile(extractPath);
    if (!snapshotPath) throw new Error('Artifact contains no snapshot.json');
    return JSON.parse(await readFile(snapshotPath, 'utf8'));
  } finally {
    await rm(temporary, {recursive:true, force:true});
  }
}

async function main() {
  if (!token) throw new Error('GITHUB_TOKEN or GH_TOKEN is required to read prior workflow artifacts.');
  const today = chinaDate();
  const runsUrl = api + '/repos/' + repo + '/actions/workflows/v13-live-snapshot.yml/runs?branch='
    + encodeURIComponent(branch) + '&status=success&per_page=30';
  const payload = await apiJson(runsUrl);
  const runs = (payload.workflow_runs ?? [])
    .filter(run => run.id !== currentRunId && (!currentRunId || run.id < currentRunId))
    .filter(run => run.head_branch === branch && run.conclusion === 'success')
    .sort((a,b) => b.id - a.id);

  let examined = 0;
  let selected = null;
  let lastError = null;
  for (const run of runs) {
    examined += 1;
    let artifacts;
    try {
      artifacts = (await apiJson(api + '/repos/' + repo + '/actions/runs/' + run.id + '/artifacts')).artifacts ?? [];
    } catch (error) {
      lastError = String(error?.message ?? error);
      continue;
    }
    const artifact = artifacts.find(item => !item.expired && item.name === 'v13-live-snapshot-' + run.id);
    if (!artifact) continue;
    let snapshot;
    try {
      snapshot = await downloadArtifact(artifact);
    } catch (error) {
      lastError = String(error?.message ?? error);
      continue;
    }
    const asOfDate = String(snapshot.asOf ?? snapshot.capturedAt ?? '').slice(0, 10);
    if (snapshot.schema !== 'v13-live-psychology-catalyst-snapshot-v1') continue;
    if (snapshot.recommendationsAvailable !== true) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate) || asOfDate >= today) continue;
    selected = {run, snapshot, artifact, asOfDate};
    break;
  }

  if (selected) {
    await mkdir(dirname(outputPath), {recursive:true});
    await writeFile(outputPath, JSON.stringify(selected.snapshot, null, 2) + '\n');
    console.log(JSON.stringify({
      status:'PRIOR_SNAPSHOT_FOUND',
      currentChinaDate:today,
      previousAsOf:selected.asOfDate,
      previousSnapshotId:selected.snapshot.snapshotId ?? null,
      previousRunId:selected.run.id,
      artifactName:selected.artifact.name,
      runsExamined:examined,
      outputPath
    }, null, 2));
    if (process.env.GITHUB_OUTPUT) {
      await writeFile(process.env.GITHUB_OUTPUT,
        'found=true\npath=' + outputPath + '\nsnapshot_id=' + (selected.snapshot.snapshotId ?? '')
          + '\nas_of=' + selected.asOfDate + '\n',
        {flag:'a'});
    }
  } else {
    console.log(JSON.stringify({
      status:'NO_PRIOR_VALID_SNAPSHOT',
      currentChinaDate:today,
      runsExamined:examined,
      note:'No earlier-China-date snapshot with recommendationsAvailable=true was found.',
      lastError
    }, null, 2));
    if (process.env.GITHUB_OUTPUT) {
      await writeFile(process.env.GITHUB_OUTPUT, 'found=false\npath=\n', {flag:'a'});
    }
  }
}

main().catch(async error => {
  console.error('Unable to fetch previous V13 snapshot:', String(error?.message ?? error));
  if (process.env.GITHUB_OUTPUT) {
    await writeFile(process.env.GITHUB_OUTPUT, 'found=false\npath=\n', {flag:'a'});
  }
  // Prior-snapshot retrieval is optional; never block today's fresh capture.
  process.exitCode = 0;
});
