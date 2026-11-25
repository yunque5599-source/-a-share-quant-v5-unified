import {put} from '@vercel/blob';
import {collectV17ResearchContext} from './v16_market_context.js';
import {collectAndArchiveV16Snapshot} from '../research/v16/archive_runner.js';

export const config={maxDuration:300};

function send(res,status,body){
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('cache-control','no-store, max-age=0');
  return res.status(status).send(JSON.stringify(body));
}
function authorized(req){
  const secret=process.env.CRON_SECRET;
  return Boolean(secret)&&req.headers?.authorization===('Bearer '+secret);
}
export default async function handler(req,res){
  res.setHeader('cache-control','no-store, max-age=0');
  if(req.method!=='GET')return send(res,405,{error:'METHOD_NOT_ALLOWED'});
  if(!process.env.CRON_SECRET)return send(res,503,{error:'CRON_SECRET_NOT_CONFIGURED',status:'ARCHIVE_NOT_CONFIGURED'});
  if(!authorized(req))return send(res,401,{error:'UNAUTHORIZED'});
  try{
    const result=await collectAndArchiveV16Snapshot({
      collectContext:()=>collectV17ResearchContext(),
      writeBlob:put
    });
    return send(res,200,result);
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
