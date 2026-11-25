import {put} from '@vercel/blob';
import {handleSchedule} from '@vercel/schedules';
import {collectV16MarketContext} from './v16_market_context.js';
import {collectAndArchiveV16Snapshot} from '../research/v16/archive_runner.js';

export const config={maxDuration:300};

export const POST=handleSchedule(async metadata=>{
  const result=await collectAndArchiveV16Snapshot({
    collectContext:()=>collectV16MarketContext({includeStockDailyBars:true}),
    writeBlob:put
  });
  console.log(JSON.stringify({
    event:'v16_snapshot_archive',
    scheduleName:metadata.name,
    scheduledAt:metadata.scheduledAt,
    ...result
  }));
});
