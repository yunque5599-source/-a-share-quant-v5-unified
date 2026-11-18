import {gzipSync} from 'node:zlib';
import {buildV16DailySnapshot} from './snapshot_archive.js';

function pathFor(snapshot) {
  const stamp=String(snapshot.capturedAt).replace(/[:.]/g,'-');
  return 'v16/snapshots/'+snapshot.tradeDate+'/'+stamp+'.json.gz';
}

export async function collectAndArchiveV16Snapshot({collectContext,writeBlob}) {
  if(typeof collectContext!=='function')throw new TypeError('collectContext must be a function');
  if(typeof writeBlob!=='function')throw new TypeError('writeBlob must be a function');

  const context=await collectContext();
  if(!context?.aShareSessionDate||context.aShareSessionDate!==context.chinaCalendarDate) {
    return {
      schema:'ashare-v16-archive-run-v1',
      status:'SKIPPED_NON_TRADING_DAY',
      chinaCalendarDate:context?.chinaCalendarDate??null,
      aShareSessionDate:context?.aShareSessionDate??null
    };
  }
  if(context.chinaCloseFinalized!==true) {
    return {
      schema:'ashare-v16-archive-run-v1',
      status:'SKIPPED_BEFORE_CLOSE',
      chinaCalendarDate:context.chinaCalendarDate,
      chinaLocalTime:context.chinaLocalTime
    };
  }

  const snapshot=buildV16DailySnapshot(context);
  const pathname=pathFor(snapshot);
  const payload=gzipSync(Buffer.from(JSON.stringify(snapshot),'utf8'));
  const blob=await writeBlob(pathname,payload,{
    access:'private',
    addRandomSuffix:false,
    allowOverwrite:false,
    contentType:'application/gzip',
    cacheControlMaxAge:60
  });
  return {
    schema:'ashare-v16-archive-run-v1',
    status:snapshot.quality.qualifiedForReplay?'ARCHIVED_QUALIFIED':'ARCHIVED_PARTIAL',
    tradeDate:snapshot.tradeDate,
    capturedAt:snapshot.capturedAt,
    pathname:blob.pathname??pathname,
    compressedBytes:payload.byteLength,
    stockRows:snapshot.stockRows.length,
    quality:snapshot.quality,
    rankingDiagnostics:snapshot.rankingDiagnostics
  };
}
