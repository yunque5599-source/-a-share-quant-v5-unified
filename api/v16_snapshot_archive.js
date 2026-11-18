import {put} from '@vercel/blob';
import {gzipSync} from 'node:zlib';
import {collectV16MarketContext} from './v16_market_context.js';
import {buildV16DailySnapshot} from '../research/v16/snapshot_archive.js';

export const config={maxDuration:60};
function send(res,status,body){
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('cache-control','no-store, max-age=0');
  return res.status(status).send(JSON.stringify(body));
}
function authorized(req){
  const secret=process.env.CRON_SECRET;
  return Boolean(secret)&&req.headers?.authorization===('Bearer '+secret);
}
function pathFor(snapshot){
  const stamp=String(snapshot.capturedAt).replace(/[:.]/g,'-');
  return 'v16/snapshots/'+snapshot.tradeDate+'/'+stamp+'.json.gz';
}
export default async function handler(req,res){
  res.setHeader('cache-control','no-store, max-age=0');
  if(req.method!=='GET')return send(res,405,{error:'METHOD_NOT_ALLOWED'});
  if(!process.env.CRON_SECRET)return send(res,503,{error:'CRON_SECRET_NOT_CONFIGURED',status:'ARCHIVE_NOT_CONFIGURED'});
  if(!authorized(req))return send(res,401,{error:'UNAUTHORIZED'});
  try{
    const context=await collectV16MarketContext();
    if(!context?.aShareSessionDate||context.aShareSessionDate!==context.chinaCalendarDate){
      return send(res,200,{
        schema:'ashare-v16-archive-run-v1',status:'SKIPPED_NON_TRADING_DAY',
        chinaCalendarDate:context?.chinaCalendarDate??null,
        aShareSessionDate:context?.aShareSessionDate??null
      });
    }
    if(context.chinaCloseFinalized!==true){
      return send(res,200,{
        schema:'ashare-v16-archive-run-v1',status:'SKIPPED_BEFORE_CLOSE',
        chinaCalendarDate:context.chinaCalendarDate,chinaLocalTime:context.chinaLocalTime
      });
    }
    const snapshot=buildV16DailySnapshot(context);
    const pathname=pathFor(snapshot);
    const payload=gzipSync(Buffer.from(JSON.stringify(snapshot),'utf8'));
    const blob=await put(pathname,payload,{
      access:'private',
      addRandomSuffix:false,
      allowOverwrite:false,
      contentType:'application/gzip',
      cacheControlMaxAge:60
    });
    return send(res,200,{
      schema:'ashare-v16-archive-run-v1',
      status:snapshot.quality.qualifiedForReplay?'ARCHIVED_QUALIFIED':'ARCHIVED_PARTIAL',
      tradeDate:snapshot.tradeDate,
      capturedAt:snapshot.capturedAt,
      pathname:blob.pathname??pathname,
      compressedBytes:payload.byteLength,
      stockRows:snapshot.stockRows.length,
      quality:snapshot.quality,
      rankingDiagnostics:snapshot.rankingDiagnostics
    });
  }catch(error){
    const message=String(error?.message??error);
    const storageFailure=/blob|token|store|storage|permission|unauthorized/i.test(message);
    return send(res,storageFailure?503:502,{
      schema:'ashare-v16-archive-run-v1',
      status:storageFailure?'STORAGE_UNAVAILABLE':'COLLECTION_FAILED',
      error:message.slice(0,220),
      retryable:true
    });
  }
}
