import {rankV15Stage1Candidates} from './selection_backtest.js';

const finite=value=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value));
const dateKey=value=>String(value??'').slice(0,10);
function shanghaiDate(value) {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value));
  const fields=Object.fromEntries(parts.map(part=>[part.type,part.value]));
  return fields.year+'-'+fields.month+'-'+fields.day;
}
export function buildV16DailySnapshot(context,{minimumRows=500}={}) {
  const aShare=context?.aShare??{},source=aShare.source??{},rows=Array.isArray(aShare.stockRows)?aShare.stockRows:[];
  const tradeDate=dateKey(aShare.aShareSessionDate??context?.aShareSessionDate);
  const capturedAt=String(context?.capturedAt??new Date().toISOString());
  const quoteRows=rows.filter(row=>row.quoteAt&&Number.isFinite(Date.parse(row.quoteAt)));
  const sameDate=quoteRows.filter(row=>shanghaiDate(row.quoteAt)===tradeDate);
  const coverage=Number(aShare.breadth?.coverage??0);
  const reasons=[];
  if(!tradeDate)reasons.push('missing-a-share-session-date');
  if(tradeDate!==dateKey(context?.chinaCalendarDate))reasons.push('session-date-does-not-match-china-calendar-date');
  if(context?.chinaCloseFinalized!==true||aShare.dataStatus!=='FINALIZED_SESSION')reasons.push('market-close-not-finalized');
  if(aShare.breadth?.universe!=='full-market'||aShare.breadth?.fullMarket!==true)reasons.push('universe-not-full-market');
  if(coverage<0.99)reasons.push('universe-coverage-below-99pct');
  if(rows.length<minimumRows)reasons.push('too-few-stock-rows');
  const quoteCoverage=quoteRows.length/Math.max(1,rows.length);
  const sameDateQuoteRatio=sameDate.length/Math.max(1,rows.length);
  if(quoteCoverage<0.95)reasons.push('quote-timestamp-coverage-below-95pct');
  if(sameDateQuoteRatio<0.95)reasons.push('same-date-quote-coverage-below-95pct');
  if(source.complete!==true)reasons.push('upstream-universe-pages-incomplete');
  const collectionStartedAt=source.collectionStartedAt??null;
  const collectionFinishedAt=source.collectionFinishedAt??capturedAt;
  const collectionDurationMs=Date.parse(collectionFinishedAt)-Date.parse(collectionStartedAt);
  const stockRows=rows.map(row=>({
    code:String(row.code??''),name:String(row.name??''),price:finite(row.price)?Number(row.price):null,
    open:finite(row.open)?Number(row.open):null,high:finite(row.high)?Number(row.high):null,
    low:finite(row.low)?Number(row.low):null,prevClose:finite(row.prevClose)?Number(row.prevClose):null,
    pct:finite(row.pct)?Number(row.pct):null,amount:finite(row.amount)?Number(row.amount):null,
    turn:finite(row.turn)?Number(row.turn):null,mcap:finite(row.mcap)?Number(row.mcap):null,
    pct60:finite(row.pct60)?Number(row.pct60):null,mainNet:finite(row.mainNet)?Number(row.mainNet):null,
    mainPct:finite(row.mainPct)?Number(row.mainPct):null,industry:String(row.industry??'未知'),
    quoteAt:row.quoteAt??null,specialTreatment:row.specialTreatment===true,
    mainBoard:/^(00|60)\d{4}$/.test(String(row.code??''))
  })).filter(row=>/^\d{6}$/.test(row.code));
  const ranking=rankV15Stage1Candidates(stockRows,aShare.indices??[]);
  return {
    schema:'ashare-v16-daily-snapshot-v1',
    tradeDate,capturedAt,
    sourceScope:aShare.breadth?.universe??'unknown',
    quality:{
      qualifiedForReplay:reasons.length===0,
      status:reasons.length?'PARTIAL':'QUALIFIED',
      reasons,
      sourceComplete:source.complete===true,
      coveragePct:Number((coverage*100).toFixed(2)),
      reportedTotal:Number(aShare.breadth?.totalReported??source.total??0),
      uniqueSymbols:stockRows.length,
      quoteTimestampCoverage:Number(quoteCoverage.toFixed(4)),
      sameDateQuoteRatio:Number(sameDateQuoteRatio.toFixed(4)),
      collectionStartedAt,collectionFinishedAt,
      collectionDurationMs:Number.isFinite(collectionDurationMs)?collectionDurationMs:null,
      approximatePointInTime:true,
      notAtomicSnapshot:true
    },
    market:{
      indices:aShare.indices??[],breadth:aShare.breadth??{},turnover:aShare.turnover??{},
      sentiment:aShare.sentiment??{},sectors:aShare.sectors??[],leaders:aShare.leaders??[],
      marketAveragePct:aShare.marketAveragePct??null
    },
    us:context?.us??{},
    narrativeStocks:aShare.narrativeStocks??[],
    stockRows,
    strategies:{
      v15Stage1Top10:ranking.candidates.slice(0,10).map(row=>({code:row.code,score:row.stage1Score})),
      v15Stage1Top30:ranking.candidates.slice(0,30).map(row=>({code:row.code,score:row.stage1Score})),
      v15Stage1Top50:ranking.candidates.slice(0,50).map(row=>({code:row.code,score:row.stage1Score}))
    },
    rankingDiagnostics:{
      method:ranking.rankingMethod,status:ranking.status,sourceRows:ranking.sourceRows,
      rankedPoolCount:ranking.rankedPoolCount,hardFilteredCount:ranking.hardFilteredCount,
      candidateCount:ranking.candidateCount,marketRegime:ranking.marketRegime
    },
    source:{
      provider:source.provider??'Eastmoney',
      total:source.total??0,uniqueSymbols:source.uniqueSymbols??stockRows.length,
      pagesFetched:source.pagesFetched??0,pageCount:source.pageCount??0,
      failures:source.failures??[],latestQuoteTimestamp:source.latestQuoteTimestamp??null
    },
    limitations:[
      'Daily archive is a multi-page approximate point-in-time collection, not an atomic exchange snapshot.',
      'V15 ranking is reconstructed from full-market factor ranks and the documented stage-one formula; it is not the final deep-score/news ranking.',
      'No minute bars, auction, order-book, cancellation or verified limit-lock data are included.'
    ]
  };
}
