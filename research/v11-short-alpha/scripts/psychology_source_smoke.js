#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { _internal as source } from '../../../api/psychology_universe.js';

const DEFAULT_CODES = ['000001', '600000', '600519'];

function argsOf(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out' && argv[i + 1]) out.out = argv[++i];
    else if (argv[i] === '--codes' && argv[i + 1]) out.codes = argv[++i];
  }
  return out;
}

function errorText(error) {
  return String(error?.message ?? error ?? 'unknown error').replace(/\s+/g, ' ').slice(0, 240);
}

async function measure(name, run, summarize) {
  const started = performance.now();
  try {
    const value = await run();
    const details = summarize(value) ?? {};
    return {
      value,
      check: {
        name,
        status: details.status ?? ((Number(details.count) || 0) > 0 ? 'ok' : 'empty'),
        durationMs: Math.round(performance.now() - started),
        ...details
      }
    };
  } catch (error) {
    return {
      value: null,
      check: {
        name,
        status: 'error',
        durationMs: Math.round(performance.now() - started),
        error: errorText(error)
      }
    };
  }
}

function summarizeMemberships(rows) {
  const successful = rows.filter(row => row.concepts?.length);
  const failed = rows.filter(row => row.error);
  const conceptCount = rows.reduce((sum, row) => sum + (row.concepts?.length ?? 0), 0);
  return {
    status: successful.length === rows.length && rows.length ? 'ok'
      : successful.length ? 'partial'
      : failed.length ? 'error' : 'empty',
    requestedStocks: rows.length,
    stocksWithConcepts: successful.length,
    conceptCount,
    perStock: rows.map(row => ({
      code: row.code,
      conceptCount: row.concepts?.length ?? 0,
      sampleNames: (row.concepts ?? []).slice(0, 4).map(item => item.name),
      ...(row.error ? {error: errorText(row.error)} : {})
    }))
  };
}

async function main() {
  const args = argsOf(process.argv.slice(2));
  const codes = [...new Set(String(args.codes ?? process.env.PSYCHOLOGY_SMOKE_CODES ?? DEFAULT_CODES.join(','))
    .split(',').map(code => code.trim()).filter(code => /^(0|6)\d{5}$/.test(code)))].slice(0, 3);
  if (codes.length < 2) throw new Error('Provide at least two valid main-board stock codes with --codes.');

  const checkedAt = new Date().toISOString();
  const [rankingProbe, quoteProbe, tencentProbe, membershipProbe, thsProbe, sinaProbe] = await Promise.all([
    measure('eastmoney-concept-ranking', () => source.fetchConceptRanking(1), rows => ({
      status: rows.length ? 'ok' : 'empty',
      conceptRows: rows.length,
      narrativeThemeRows: rows.filter(source.isNarrativeTheme).length,
      sampleThemes: rows.filter(source.isNarrativeTheme).slice(0, 4).map(row => ({code:row.code,name:row.name}))
    })),
    measure('eastmoney-candidate-quotes', () => source.fetchCandidateQuotes(codes), quotes => ({
      status: quotes.size ? (quotes.size === codes.length ? 'ok' : 'partial') : 'empty',
      requestedStocks: codes.length,
      quoteRows: quotes.size,
      coveredCodes: codes.filter(code => quotes.has(code))
    })),
    measure('tencent-candidate-quotes', () => source.fetchTencentCandidateQuotes(codes, 5000), quotes => ({
      status: quotes.size ? (quotes.size === codes.length ? 'ok' : 'partial') : 'empty',
      requestedStocks: codes.length,
      quoteRows: quotes.size,
      coveredCodes: codes.filter(code => quotes.has(code))
    })),
    measure('eastmoney-stock-concepts', async () => Promise.all(codes.slice(0, 2).map(async code => {
      try { return {code, concepts:await source.fetchStockConcepts(code)}; }
      catch (error) { return {code, concepts:[], error:errorText(error)}; }
    })), summarizeMemberships),
    measure('10jqka-stock-concepts', async () => Promise.all(codes.slice(0, 2).map(async code => {
      try { return {code, concepts:await source.fetchThsStockConcepts(code)}; }
      catch (error) { return {code, concepts:[], error:errorText(error)}; }
    })), summarizeMemberships),
    measure('sina-concept-taxonomy', () => source.fetchSinaConceptNodes(), nodes => ({
      status: nodes.size ? 'ok' : 'empty',
      nodeCount: nodes.size,
      sampleNodes: [...nodes.values()].slice(0, 4).map(node => ({code:node.code,name:node.name}))
    }))
  ]);

  const checks = [
    rankingProbe.check, quoteProbe.check, tencentProbe.check,
    membershipProbe.check, thsProbe.check, sinaProbe.check
  ];

  let sinaMembersProbe = {value:null,check:{name:'sina-theme-members',status:'skipped',reason:'Sina concept taxonomy unavailable.'}};
  if (sinaProbe.value?.size) {
    const node = [...sinaProbe.value.values()][0];
    sinaMembersProbe = await measure('sina-theme-members', () => source.fetchSinaNodeMembers(node.code, 1), rows => ({
      status: rows.length ? 'ok' : 'empty',
      nodeCode: node.code,
      nodeName: node.name,
      memberRows: rows.length,
      sampleCodes: rows.slice(0, 5).map(row => row.code)
    }));
  }
  checks.push(sinaMembersProbe.check);

  const fallbackProbe = await measure('integrated-sina-10jqka-fallback',
    () => source.fetchSinaThsConceptFallback(codes.slice(0, 2), 2, 2),
    result => ({
      status: result.concepts.length && result.diagnostics.mappedMemberships > 0 ? 'ok'
        : result.concepts.length ? 'partial' : 'empty',
      fallbackThemes: result.concepts.length,
      requestedMemberships: result.diagnostics.requestedMemberships,
      mappedMemberships: result.diagnostics.mappedMemberships,
      membershipFailures: result.diagnostics.membershipFailures,
      unmappedConcepts: result.diagnostics.unmappedConcepts,
      sampleThemes: result.concepts.slice(0, 4).map(row => ({code:row.code,name:row.name}))
    }));
  checks.push(fallbackProbe.check);

  let themeEvidence = [];
  const selectedTheme = (rankingProbe.value ?? []).find(source.isNarrativeTheme);
  if (selectedTheme) {
    const [flowProbe, membersProbe, newsProbe] = await Promise.all([
      measure('eastmoney-theme-flow-history', () => source.fetchThemeFlow(selectedTheme.code), rows => ({
        status: rows.length ? 'ok' : 'empty',
        themeCode: selectedTheme.code,
        themeName: selectedTheme.name,
        historyRows: rows.length,
        latestDate: rows.at(-1)?.date ?? null
      })),
      measure('eastmoney-theme-members', () => source.fetchThemeMembers(selectedTheme.code), rows => ({
        status: rows.length ? 'ok' : 'empty',
        themeCode: selectedTheme.code,
        themeName: selectedTheme.name,
        memberRows: rows.length,
        sampleCodes: rows.slice(0, 5).map(row => row.code)
      })),
      measure('eastmoney-theme-news', () => source.fetchThemeNews(selectedTheme.name), rows => ({
        status: rows.length ? 'ok' : 'empty',
        themeCode: selectedTheme.code,
        themeName: selectedTheme.name,
        newsRows: rows.length,
        datedNewsRows: rows.filter(row => row.date).length
      }))
    ]);
    themeEvidence = [flowProbe, membersProbe, newsProbe];
    checks.push(...themeEvidence.map(item => item.check));
  } else {
    checks.push({
      name:'eastmoney-theme-evidence',
      status:'skipped',
      reason:'No narrative theme was returned by the primary concept-ranking probe.'
    });
  }

  const quoteReady = (quoteProbe.value?.size ?? 0) > 0 || (tencentProbe.value?.size ?? 0) > 0;
  const primaryMembershipCount = (membershipProbe.value ?? [])
    .reduce((sum, row) => sum + (row.concepts?.length ?? 0), 0);
  const primaryThemeNames = new Set((rankingProbe.value ?? [])
    .map(row => source.normalizeThemeName(row.name)));
  const thsMappedCount = (thsProbe.value ?? []).reduce((sum, row) =>
    sum + (row.concepts ?? []).filter(item => primaryThemeNames.has(item.normalizedName)).length, 0);
  const primaryTaxonomyReady = (rankingProbe.value?.length ?? 0) > 0 &&
    (primaryMembershipCount > 0 || thsMappedCount > 0);
  const fallbackTaxonomyReady = (fallbackProbe.value?.concepts?.length ?? 0) > 0 &&
    (fallbackProbe.value?.diagnostics?.mappedMemberships ?? 0) > 0;
  const taxonomyReady = primaryTaxonomyReady || fallbackTaxonomyReady;
  const coreReady = quoteReady && taxonomyReady;
  const nonSkippedProblems = checks.some(check => ['error','empty','partial'].includes(check.status));
  const overallStatus = !coreReady ? 'SOURCE_UNAVAILABLE'
    : nonSkippedProblems ? 'DEGRADED_SOURCE_COVERAGE'
    : 'SOURCE_COVERAGE_AVAILABLE';

  const report = {
    schema:'psychology-source-smoke-v1',
    checkedAt,
    runtime:process.version,
    sampleCodes:codes,
    status:overallStatus,
    coreReady,
    coreChecks:{
      quoteSourceAvailable:quoteReady,
      primaryTaxonomyReady,
      fallbackTaxonomyReady,
      taxonomyReady
    },
    checks
  };

  const outputArg = args.out;
  if (outputArg) {
    const outputPath = path.resolve(outputArg);
    fs.mkdirSync(path.dirname(outputPath), {recursive:true});
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
    report.outputPath = outputPath;
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!coreReady) process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write('psychology source smoke failed: ' + errorText(error) + '\n');
  process.exitCode = 1;
});
