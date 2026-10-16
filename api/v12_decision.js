export const config = { maxDuration: 30 };

import marketHandler from './market.js';
import discoveryHandler from './discovery_universe.js';
import psychologyHandler from './psychology_universe.js';
import { integrateCandidateFlow } from '../research/v11-short-alpha/candidate_flow.js';
import { selectV12Candidates } from '../research/v11-short-alpha/v12_universe.js';

function invoke(handler, url) {
  return new Promise((resolve, reject) => {
    let body = '';
    const req = {method:'GET', url};
    const res = {
      statusCode:200,
      setHeader() {},
      status(code) { this.statusCode = code; return this; },
      json(value) { body = JSON.stringify(value); resolve({statusCode:this.statusCode, body}); },
      send(value) { body = typeof value === 'string' ? value : JSON.stringify(value); resolve({statusCode:this.statusCode, body}); },
      end(value = '') { body = typeof value === 'string' ? value : JSON.stringify(value); resolve({statusCode:this.statusCode, body}); }
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

function parseBody(name, result) {
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(name + ' HTTP ' + result.statusCode + ': ' + result.body.slice(0, 500));
  }
  try { return JSON.parse(result.body); }
  catch (error) { throw new Error(name + ' invalid JSON: ' + error.message); }
}

function parseCodes(raw) {
  return [...new Set(String(raw || '').split(',').map(s => s.trim())
    .filter(code => /^(00|60)\d{4}$/.test(code)))].slice(0, 15);
}

function executionTier(row) {
  const v = Number(row?.scores?.v12Trade);
  const timing = Number(row?.scores?.timing);
  const psychology = Number(row?.scores?.psychology);
  const fomo = Number(row?.psychology?.fomoRisk?.score);
  const stage = String(row?.psychology?.stage ?? '');
  if (Number.isFinite(v) && Number.isFinite(timing) && Number.isFinite(psychology) &&
      v >= 75 && timing >= 75 && psychology >= 70 &&
      Number.isFinite(fomo) && fomo < 75 &&
      ['ignition','acceleration','mainstream'].includes(stage)) {
    return 'CONFIRM_ENTRY';
  }
  if (Number.isFinite(v) && Number.isFinite(timing) && Number.isFinite(psychology) &&
      v >= 65 && timing >= 50 && psychology >= 65) {
    return 'WATCH_PULLBACK';
  }
  return 'OBSERVE';
}

function compact(row) {
  return {
    tradeRank:row.tradeRank,
    symbol:row.symbol,
    name:row.name,
    industry:row.industry,
    price:row.price,
    marketRisk:row.marketRisk,
    scores:{
      alpha:row.scores?.alpha ?? null,
      timing:row.scores?.timing ?? null,
      psychology:row.scores?.psychology ?? null,
      v12Trade:row.scores?.v12Trade ?? null
    },
    timing:{
      score:row.scores?.timing ?? null,
      signal:row.timing?.signal ?? null,
      stage:row.timing?.stage ?? 'unknown',
      capitalTiming:row.timing?.capitalTiming ?? 'unknown',
      overboughtRisk:row.timing?.overboughtRisk ?? 'unknown'
    },
    executionTier:executionTier(row),
    psychology:{
      complete:row.psychology?.complete === true,
      confidence:row.psychology?.confidence ?? 0,
      stage:row.psychology?.stage ?? 'unknown',
      primaryTheme:row.psychology?.primaryTheme ?? null,
      fomoRisk:row.psychology?.fomoRisk ?? null,
      reasons:row.psychology?.reasons ?? []
    },
    quality:{
      complete:row.quality?.complete === true,
      degraded:row.quality?.degraded === true,
      blockedReasons:row.quality?.blockedReasons ?? [],
      warnings:row.quality?.warnings ?? []
    }
  };
}

export default async function handler(req, res) {
  const u = new URL(req.url, 'http://localhost');
  try {
    const requestedCodes = parseCodes(u.searchParams.get('codes'));
    const ranked = parseBody('ranked_candidates',
      await invoke(marketHandler, '/api/market?action=ranked_candidates'));
    const candidates = ranked?.data?.candidates ?? [];
    const diversified = selectV12Candidates(candidates, 30);
    const codes = requestedCodes.length
      ? [...new Set([
          ...requestedCodes,
          ...diversified.map(row => String(row?.f12 ?? ''))
        ])].slice(0, 15)
      : diversified.slice(0, 15).map(row => String(row?.f12 ?? ''));

    if (codes.length < 3) {
      return res.status(422).json({
        schema:'v12-decision-v1',
        status:'INSUFFICIENT_UNIVERSE',
        error:'fewer than three eligible main-board candidates'
      });
    }

    const missingRequested = requestedCodes.filter(code =>
      !candidates.some(row => String(row?.f12 ?? '') === code)
    );
    let requestedQuoteRows = [];
    if (missingRequested.length) {
      const quoted = await Promise.all(missingRequested.slice(0, 3).map(async code => {
        const result = await invoke(marketHandler, '/api/market?action=quote&code=' + encodeURIComponent(code));
        if (result.statusCode !== 200) return null;
        try {
          const data = JSON.parse(result.body)?.data ?? {};
          return {
            f12:code,
            f14:data.f58 ?? code,
            f2:data.f43,
            f3:data.f170,
            f6:data.f48,
            f8:data.f168,
            f62:data.f62,
            f184:data.f184,
            f100:data.f100
          };
        } catch {
          return null;
        }
      }));
      requestedQuoteRows = quoted.filter(Boolean);
    }

    const query = encodeURIComponent(codes.join(','));
    const [deep, discovery, psychology] = await Promise.all([
      invoke(marketHandler, '/api/market?action=deep_batch&codes=' + query),
      invoke(discoveryHandler, '/api/discovery_universe'),
      invoke(psychologyHandler, '/api/psychology_universe?codes=' + query)
    ]);

    const deepPayload = parseBody('deep_batch', deep);
    const discoveryPayload = parseBody('discovery_universe', discovery);
    const psychologyPayload = parseBody('psychology_universe', psychology);

    const evaluationRows = [
      ...candidates.filter(row => codes.includes(String(row?.f12 ?? ''))),
      ...requestedQuoteRows
    ];
    const rankedForV12 = {
      ...ranked,
      data:{
        ...ranked.data,
        candidates:evaluationRows
      }
    };
    const decision = integrateCandidateFlow({
      ranked:rankedForV12,
      deep:deepPayload,
      discovery:discoveryPayload,
      psychology:psychologyPayload?.data ?? psychologyPayload
    }, {
      asOf:ranked?.data?.generatedAt,
      psychology:psychologyPayload?.data ?? psychologyPayload
    });

    const top = decision.tradeRanking.slice(0, 20).map(compact);
    const status = decision.diagnostics.v12Eligible > 0 ? 'READY' :
      decision.diagnostics.psychologyComplete > 0 ? 'PSYCHOLOGY_PARTIAL' :
      'INSUFFICIENT_EVIDENCE';

    return res.status(200).json({
      schema:'v12-decision-v1',
      version:'V12 Trade Score Phase 1',
      status,
      asOf:decision.asOf,
      market:decision.market,
      diagnostics:{
        ...decision.diagnostics,
        rankedCandidateCount:candidates.length,
        requestedCodes:requestedCodes.length,
        evaluatedCodes:codes.length,
        requestedMissingCount:missingRequested.length,
        requestedQuoteCount:requestedQuoteRows.length,
        providerFallback:ranked?.data?.providerFallback ?? null,
        degraded:ranked?.data?.degraded === true
      },
      ranking:top
    });
  } catch (error) {
    return res.status(502).json({
      schema:'v12-decision-v1',
      status:'SOURCE_OR_COMPUTE_FAILED',
      error:error?.message || String(error)
    });
  }
}
