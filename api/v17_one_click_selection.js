import {get, list} from '@vercel/blob';
import {gunzipSync} from 'node:zlib';
import {collectV17ResearchContext} from './v16_market_context.js';
import {buildV17OneClickSelection} from '../research/v17_one_click_selection.js';
import {evaluateV17HistoricalReplay} from '../research/v17_one_click_backtest.js';
import {selectRecentV16SnapshotBlobs} from '../research/v16/snapshot_archive.js';

export const config = {maxDuration: 300};

function send(res, status, body) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'private, no-store, max-age=0');
  return res.status(status).send(JSON.stringify(body));
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.max(1, Math.min(limit, items.length || 1))}, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      try { out[index] = await fn(items[index], index); }
      catch (error) { out[index] = {error: String(error?.message ?? error)}; }
    }
  }));
  return out;
}

async function listSnapshotBlobs() {
  const all = [];
  let cursor;
  for (let page = 0; page < 10; page++) {
    const result = await list({prefix: 'v16/snapshots/', limit: 1000, ...(cursor ? {cursor} : {})});
    all.push(...(result.blobs ?? []));
    if (!result.hasMore || !result.cursor) break;
    cursor = result.cursor;
  }
  return all;
}

async function readSnapshot(blob) {
  const result = await get(blob.pathname, {access: 'private'});
  if (!result || result.statusCode !== 200 || !result.stream) return null;
  const bytes = Buffer.from(await new Response(result.stream).arrayBuffer());
  return JSON.parse(gunzipSync(bytes).toString('utf8'));
}

async function loadArchive() {
  try {
    const blobs = await listSnapshotBlobs();
    const selected = selectRecentV16SnapshotBlobs(blobs, {days: 45});
    const loaded = await mapLimit(selected, 6, readSnapshot);
    const readFailures = loaded.filter(value => !value || value.error).length;
    const byDate = new Map();
    for (const snapshot of loaded.filter(value => value && !value.error)) {
      const date = String(snapshot.tradeDate ?? '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const prior = byDate.get(date);
      if (!prior || String(snapshot.capturedAt ?? '') > String(prior.capturedAt ?? '')) byDate.set(date, snapshot);
    }
    const snapshots = [...byDate.values()].sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
    const latestSnapshot = snapshots.at(-1) ?? null;
    const latestQuality = latestSnapshot?.quality ?? null;
    return {
      snapshots,
      diagnostics: {
        status: blobs.length ? 'AVAILABLE' : 'EMPTY',
        blobCount: blobs.length,
        selectedBlobCount: selected.length,
        loadedSnapshotCount: snapshots.length,
        readFailureCount: readFailures,
        qualifiedSessionCount: snapshots.filter(row => row?.quality?.qualifiedForReplay === true).length,
        partialSessionCount: snapshots.filter(row => row?.quality?.qualifiedForReplay !== true).length,
        latestSnapshotDate: latestSnapshot?.tradeDate ?? null,
        latestSnapshotQuality: latestSnapshot ? {
          status: latestQuality?.status ?? 'UNKNOWN',
          qualifiedForReplay: latestQuality?.qualifiedForReplay === true,
          reasons: Array.isArray(latestQuality?.reasons) ? latestQuality.reasons : [],
          sourceComplete: latestQuality?.sourceComplete === true,
          coveragePct: latestQuality?.coveragePct ?? null,
          reportedTotal: latestQuality?.reportedTotal ?? null,
          uniqueSymbols: latestQuality?.uniqueSymbols ?? null,
          quoteTimestampCoverage: latestQuality?.quoteTimestampCoverage ?? null,
          sameDateQuoteRatio: latestQuality?.sameDateQuoteRatio ?? null,
          volumePricePhaseStatus: latestQuality?.volumePricePhaseStatus ?? 'NOT_MEASURABLE',
          earlyTrendStatus: latestQuality?.earlyTrendStatus ?? 'NOT_MEASURABLE',
          stockRowCount: Array.isArray(latestSnapshot.stockRows) ? latestSnapshot.stockRows.length : 0,
          sourceScope: latestSnapshot.sourceScope ?? 'unknown',
          sourcePagesFetched: latestSnapshot.source?.pagesFetched ?? null,
          sourcePageCount: latestSnapshot.source?.pageCount ?? null,
          sourceFailureCount: Array.isArray(latestSnapshot.source?.failures) ? latestSnapshot.source.failures.length : null,
          sourceFailures: Array.isArray(latestSnapshot.source?.failures)
            ? latestSnapshot.source.failures.slice(0, 10).map(item => ({
                page: item.page ?? null, error: String(item.error ?? '').slice(0, 140)
              })) : [],
          collectionDurationMs: latestQuality?.collectionDurationMs ?? null
        } : null
      }
    };
  } catch (error) {
    return {
      snapshots: [],
      diagnostics: {
        status: 'UNAVAILABLE',
        blobCount: null,
        selectedBlobCount: 0,
        loadedSnapshotCount: 0,
        readFailureCount: null,
        qualifiedSessionCount: 0,
        partialSessionCount: 0,
        latestSnapshotDate: null,
        error: String(error?.message ?? error).slice(0, 180)
      }
    };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, {error: 'METHOD_NOT_ALLOWED'});
  try {
    const archive = await loadArchive();
    if (String(req.query?.mode ?? '') === 'backtest') {
      const replay = evaluateV17HistoricalReplay({
        snapshots: archive.snapshots,
        asOf: new Date().toISOString()
      });
      replay.archive = archive.diagnostics;
      return send(res, 200, replay);
    }
    const context = await collectV17ResearchContext();
    const asOf = new Date().toISOString();
    const result = buildV17OneClickSelection({
      context,
      snapshots: archive.snapshots,
      asOf
    });
    result.archive = {
      ...result.archive,
      ...archive.diagnostics,
      archiveStorageStatus: archive.diagnostics.status,
      persistenceStatus: result.archive.status,
      status: result.archive.status
    };
    return send(res, 200, result);
  } catch (error) {
    return send(res, 502, {
      schema: 'ashare-v17-one-click-selection-error-v1',
      status: 'SOURCE_UNAVAILABLE',
      error: String(error?.message ?? error).slice(0, 220),
      execution: 'SHADOW_NO_ORDERS'
    });
  }
}
