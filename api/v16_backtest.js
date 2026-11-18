import {get,list} from '@vercel/blob';
import {gunzipSync} from 'node:zlib';
import {evaluateV15TopKForwardReturns} from '../research/v16/selection_backtest.js';
import {evaluateFlowLhbAblation} from '../research/v16/flow_lhb_backtest.js';

export const config={maxDuration:60};
function send(res,status,body){
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('cache-control','private, no-store, max-age=0');
  return res.status(status).send(JSON.stringify(body));
}
async function mapLimit(items,limit,fn){
  const out=new Array(items.length);let next=0;
  await Promise.all(Array.from({length:Math.max(1,Math.min(limit,items.length||1))},async()=>{
    while(true){const i=next++;if(i>=items.length)return;try{out[i]=await fn(items[i],i);}catch(error){out[i]={error:String(error?.message??error)};}}
  }));
  return out;
}
async function listSnapshotBlobs(prefix='v16/snapshots/'){
  const all=[];let cursor;
  for(let page=0;page<10;page++){
    const result=await list({prefix,limit:1000,...(cursor?{cursor}:{})});
    all.push(...(result.blobs??[]));
    if(!result.hasMore||!result.cursor)break;
    cursor=result.cursor;
  }
  return all.sort((a,b)=>String(a.pathname).localeCompare(String(b.pathname)));
}
function snapshotTradeDate(blob){
  const match=String(blob?.pathname??'').match(/^v16\/snapshots\/(\d{4}-\d{2}-\d{2})\//);
  return match?.[1]??null;
}
function selectRecentSnapshotBlobs(blobs,days,asOf=null){
  const grouped=new Map();
  const cutoff=String(asOf??'').slice(0,10);
  for(const blob of Array.isArray(blobs)?blobs:[]){
    const date=snapshotTradeDate(blob);
    if(!date||(cutoff&&!/^\d{4}-\d{2}-\d{2}$/.test(cutoff))||(cutoff&&date>cutoff))continue;
    if(!grouped.has(date))grouped.set(date,[]);
    grouped.get(date).push(blob);
  }
  const keepDates=new Set([...grouped.keys()].sort().slice(-Math.min(260,days+5)));
  return [...keepDates].flatMap(date=>(grouped.get(date)??[]).slice()
    .sort((a,b)=>String(a.pathname).localeCompare(String(b.pathname))));
}
async function readSnapshot(blob){
  const result=await get(blob.pathname,{access:'private'});
  if(!result||result.statusCode!==200||!result.stream)return null;
  const bytes=Buffer.from(await new Response(result.stream).arrayBuffer());
  const raw=gunzipSync(bytes).toString('utf8');
  return JSON.parse(raw);
}
export default async function handler(req,res){
  res.setHeader('cache-control','private, no-store, max-age=0');
  if(req.method!=='GET')return send(res,405,{error:'METHOD_NOT_ALLOWED'});
  try{
    const url=new URL(req.url,'http://localhost');
    const days=Math.max(10,Math.min(250,Math.floor(Number(url.searchParams.get('days'))||120)));
    const asOf=url.searchParams.get('asOf');
    if(asOf&&!/^\d{4}-\d{2}-\d{2}$/.test(asOf))
      return send(res,400,{error:'INVALID_AS_OF_DATE',expected:'YYYY-MM-DD'});
    const blobs=await listSnapshotBlobs();
    const selected=selectRecentSnapshotBlobs(blobs,days,asOf);
    const loaded=await mapLimit(selected,8,async blob=>readSnapshot(blob));
    const snapshots=loaded.filter(value=>value&&!value.error);
    const report=evaluateV15TopKForwardReturns({snapshots,asOf,topKs:[10,30,50],horizons:[1,3,5],minSignalDates:20});
    const flowLhbReport=evaluateFlowLhbAblation({snapshots,asOf,topKs:[10,30,50],horizons:[1,3,5],minSignalDates:20});
    const partialReadCount=loaded.filter(value=>!value||value.error).length;
    const selectedTradeDates=new Set(selected.map(snapshotTradeDate).filter(Boolean));
    return send(res,200,{
      schema:'ashare-v16-server-backtest-response-v1',
      archive:{
        blobCount:blobs.length,selectedBlobCount:selected.length,
        selectedTradeDateCount:selectedTradeDates.size,
        loadedSnapshotCount:snapshots.length,readFailureCount:partialReadCount,requestedDays:days,
        asOf:asOf??null
      },
      report,
      flowLhbReport
    });
  }catch(error){
    return send(res,503,{
      schema:'ashare-v16-server-backtest-response-v1',
      status:'ARCHIVE_UNAVAILABLE',
      error:String(error?.message??error).slice(0,220)
    });
  }
}
