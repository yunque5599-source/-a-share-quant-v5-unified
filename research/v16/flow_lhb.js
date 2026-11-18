const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const num = value => finite(value) ? Number(value) : null;
const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
const mean = values => {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
};
const codeOf = value => {
  const raw = String(value ?? '').trim();
  const match = raw.match(/\d{6}/);
  return match ? match[0] : '';
};
const pick = (row, keys) => {
  for (const key of keys) if (row?.[key] !== undefined && row?.[key] !== null && row?.[key] !== '') return row[key];
  return null;
};
const normalizeDate = value => String(value ?? '').slice(0, 10);
const isInstitutionSeat = value => /机构专用|机构席位|基金专用|保险专用|券商自营/.test(String(value ?? ''));

function normalizePoolRow(row = {}, poolType = 'limitUp') {
  const code = codeOf(pick(row, ['c', 'code', 'SECURITY_CODE', 'SECUCODE']));
  if (!code) return null;
  const rawPrice = num(pick(row, ['p', 'price', 'CLOSE_PRICE']));
  const price = row.p !== undefined && row.price === undefined && rawPrice !== null ? rawPrice / 1000 : rawPrice;
  const zttj = row.zttj && typeof row.zttj === 'object' ? row.zttj : {};
  return {
    code,
    name: String(pick(row, ['n', 'name', 'SECURITY_NAME_ABBR']) ?? code),
    poolType,
    price,
    pct: num(pick(row, ['zdp', 'pct', 'CHANGE_RATE'])),
    amountCny: num(pick(row, ['amount', 'AMOUNT'])),
    turnoverPct: num(pick(row, ['hs', 'turnover', 'TURNOVERRATE'])),
    limitDays: num(pick(row, ['lbc', 'limitDays'])),
    firstSeal: pick(row, ['fbt', 'firstSeal']),
    lastSeal: pick(row, ['lbt', 'lastSeal']),
    breakTimes: num(pick(row, ['zbc', 'breakTimes'])),
    sealFundCny: num(pick(row, ['fund', 'sealFundCny'])),
    industry: String(pick(row, ['hybk', 'industry', 'INDUSTRY']) ?? ''),
    limitStat: zttj.days !== undefined || zttj.ct !== undefined
      ? String(zttj.days ?? '?') + '天' + String(zttj.ct ?? '?') + '板'
      : String(pick(row, ['zttj', 'limitStat']) ?? '')
  };
}

export function normalizeLimitPoolRows(rows, poolType = 'limitUp') {
  const byCode = new Map();
  for (const raw of Array.isArray(rows) ? rows : []) {
    const row = normalizePoolRow(raw, poolType);
    if (!row) continue;
    const previous = byCode.get(row.code);
    if (!previous || Math.abs(row.pct ?? 0) >= Math.abs(previous.pct ?? 0)) byCode.set(row.code, row);
  }
  return [...byCode.values()];
}

export function summarizeLimitPools({
  tradeDate = null,
  limitUpRows = null,
  brokenRows = null,
  limitDownRows = null,
  sourceStatus = {}
} = {}) {
  const sourceRows = {limitUp:limitUpRows,broken:brokenRows,limitDown:limitDownRows};
  const statusFor = key => String(sourceStatus[key] ?? (Array.isArray(sourceRows[key]) ? 'AVAILABLE' : 'NOT_MEASURABLE'));
  const limitUp = normalizeLimitPoolRows(limitUpRows, 'limitUp');
  const broken = normalizeLimitPoolRows(brokenRows, 'broken');
  const limitDown = normalizeLimitPoolRows(limitDownRows, 'limitDown');
  const allAvailable = ['limitUp','broken','limitDown'].every(key => statusFor(key) === 'AVAILABLE');
  const ztAvailable = statusFor('limitUp') === 'AVAILABLE';
  const brokenAvailable = statusFor('broken') === 'AVAILABLE';
  const dtAvailable = statusFor('limitDown') === 'AVAILABLE';
  const denominator = limitUp.length + broken.length;
  const ladderMap = new Map();
  for (const row of limitUp) {
    const board = Number.isFinite(row.limitDays) ? Math.max(1, Math.floor(row.limitDays)) : null;
    if (board === null) continue;
    ladderMap.set(board, (ladderMap.get(board) ?? 0) + 1);
  }
  const ladder = [...ladderMap.entries()].sort((a,b)=>a[0]-b[0])
    .map(([board,count])=>({board,count,label:board>=4?String(board)+'板':String(board)+'板'}));
  const breakTimes = broken.map(row=>row.breakTimes).filter(Number.isFinite);
  const sealFunds = limitUp.map(row=>row.sealFundCny).filter(Number.isFinite);
  return {
    schema: 'ashare-v16-limit-pools-v1',
    tradeDate: normalizeDate(tradeDate),
    status: allAvailable ? 'AVAILABLE' : ztAvailable || brokenAvailable || dtAvailable ? 'PARTIAL' : 'NOT_MEASURABLE',
    source: 'Eastmoney push2ex limit pools',
    sourceStatus: {
      limitUp: statusFor('limitUp'),
      broken: statusFor('broken'),
      limitDown: statusFor('limitDown')
    },
    limitUpCount: ztAvailable ? limitUp.length : null,
    brokenBoardCount: brokenAvailable ? broken.length : null,
    limitDownCount: dtAvailable ? limitDown.length : null,
    brokenBoardRate: ztAvailable && brokenAvailable && denominator > 0 ? broken.length / denominator : null,
    averageBreakTimes: breakTimes.length ? mean(breakTimes) : null,
    totalSealFundCny: sealFunds.length ? sealFunds.reduce((sum,value)=>sum+value,0) : null,
    highestBoard: ladder.length ? Math.max(...ladder.map(row=>row.board)) : null,
    ladder,
    limitUp,
    broken,
    limitDown,
    quality: allAvailable ? 'VENDOR_POOL_COMPLETE' : 'VENDOR_POOL_PARTIAL'
  };
}

export function normalizeLhbDailyRows(rows = []) {
  const byCode = new Map();
  for (const raw of Array.isArray(rows) ? rows : []) {
    const code = codeOf(pick(raw, ['SECURITY_CODE','SECUCODE','code']));
    if (!code) continue;
    const row = {
      code,
      name: String(pick(raw, ['SECURITY_NAME_ABBR','SECURITY_NAME','name']) ?? code),
      tradeDate: normalizeDate(pick(raw, ['TRADE_DATE','tradeDate'])),
      changePct: num(pick(raw, ['CHANGE_RATE','changePct','pct'])),
      netBuyCny: num(pick(raw, ['BILLBOARD_NET_AMT','NET_AMT','netBuyCny'])),
      buyCny: num(pick(raw, ['BILLBOARD_BUY_AMT','BUY_AMT','buyCny'])),
      sellCny: num(pick(raw, ['BILLBOARD_SELL_AMT','SELL_AMT','sellCny'])),
      dealCny: num(pick(raw, ['BILLBOARD_DEAL_AMT','DEAL_AMT','dealCny'])),
      dealAmountRatioPct: num(pick(raw, ['DEAL_AMOUNT_RATIO','dealAmountRatioPct'])),
      turnoverPct: num(pick(raw, ['TURNOVERRATE','turnoverPct'])),
      explanation: String(pick(raw, ['EXPLANATION','EXPLAIN_REASON','explanation']) ?? ''),
      explain: String(pick(raw, ['EXPLAIN','explain']) ?? '')
    };
    const previous = byCode.get(code);
    if (!previous) {
      byCode.set(code, {...row, explanations: row.explanation ? [row.explanation] : [], appearances: 1});
      continue;
    }
    // A stock can appear once per abnormal-trading reason. Do not sum duplicated
    // stock-level net amounts; keep the largest absolute record and merge reasons.
    const explanations = [...new Set([...previous.explanations, row.explanation].filter(Boolean))];
    const chosen = Math.abs(row.netBuyCny ?? 0) > Math.abs(previous.netBuyCny ?? 0) ? row : previous;
    byCode.set(code, {...chosen, explanations, appearances: previous.appearances + 1});
  }
  return [...byCode.values()].sort((a,b)=>Math.abs(b.netBuyCny ?? 0)-Math.abs(a.netBuyCny ?? 0));
}

export function normalizeLhbSeatRows(rows = []) {
  const byKey = new Map();
  for (const raw of Array.isArray(rows) ? rows : []) {
    const code = codeOf(pick(raw, ['SECURITY_CODE','SECUCODE','code']));
    const seatName = String(pick(raw, ['OPERATEDEPT_NAME','OPERATEDEPT_NAME_ABBR','ORG_NAME_ABBR','SEAT_NAME','seatName']) ?? '').trim();
    if (!code || !seatName) continue;
    const buyCny = num(pick(raw, ['ACT_BUY','BUY_AMT_REAL','BUY_AMT','BUY_AMOUNT','buyCny']));
    const sellCny = num(pick(raw, ['ACT_SELL','SELL_AMT_REAL','SELL_AMT','SELL_AMOUNT','sellCny']));
    const suppliedNet = num(pick(raw, ['NET_AMT','NET_BUY','NET_AMOUNT','netBuyCny']));
    const netBuyCny = suppliedNet !== null ? suppliedNet
      : buyCny !== null && sellCny !== null ? buyCny - sellCny : null;
    const row = {
      code,
      seatName,
      buyCny,
      sellCny,
      netBuyCny,
      institutional: isInstitutionSeat(seatName + ' ' + String(raw.ORG_NAME_ABBR ?? '')),
      tradeDate: normalizeDate(pick(raw, ['TRADE_DATE','tradeDate']))
    };
    const key = code + '|' + seatName;
    const previous = byKey.get(key);
    if (!previous || Math.abs(row.netBuyCny ?? 0) > Math.abs(previous.netBuyCny ?? 0)) byKey.set(key,row);
  }
  return [...byKey.values()];
}

export function summarizeLhbContext({
  tradeDate = null,
  dailyRows = [],
  seatRows = [],
  dailyStatus = 'NOT_MEASURABLE',
  seatStatus = 'NOT_MEASURABLE',
  stockRows = []
} = {}) {
  const rows = normalizeLhbDailyRows(dailyRows);
  const seats = normalizeLhbSeatRows(seatRows);
  const industryByCode = new Map((Array.isArray(stockRows)?stockRows:[]).map(row=>[String(row.code),String(row.industry??'未知')]));
  const institutionalByCode = new Map();
  const seatByName = new Map();
  for (const seat of seats) {
    if (seat.institutional && Number.isFinite(seat.netBuyCny)) {
      const prior = institutionalByCode.get(seat.code) ?? {netBuyCny:0,seatCount:0};
      prior.netBuyCny += seat.netBuyCny;
      prior.seatCount += 1;
      institutionalByCode.set(seat.code,prior);
    }
    const aggregate = seatByName.get(seat.seatName) ?? {seatName:seat.seatName,netBuyCny:0,stockCount:0,institutional:seat.institutional};
    if (Number.isFinite(seat.netBuyCny)) aggregate.netBuyCny += seat.netBuyCny;
    aggregate.stockCount += 1;
    seatByName.set(seat.seatName,aggregate);
  }
  const stockSignalsByCode = {};
  const enrichedRows = rows.map(row => {
    const institution = institutionalByCode.get(row.code);
    const signal = {
      netBuyCny: row.netBuyCny,
      institutionalNetBuyCny: seatStatus === 'AVAILABLE' && institution?.seatCount ? institution.netBuyCny : null,
      institutionalSeatCount: seatStatus === 'AVAILABLE' ? institution?.seatCount ?? 0 : null
    };
    stockSignalsByCode[row.code] = signal;
    return {...row,industry:industryByCode.get(row.code) ?? '未知',...signal};
  });
  const netValues = rows.map(row=>row.netBuyCny).filter(Number.isFinite);
  const positiveCount = netValues.filter(value=>value>0).length;
  const negativeCount = netValues.filter(value=>value<0).length;
  const institutionValues = [...institutionalByCode.values()].map(row=>row.netBuyCny).filter(Number.isFinite);
  const institutionPositiveCount = institutionValues.filter(value=>value>0).length;
  const institutionNegativeCount = institutionValues.filter(value=>value<0).length;
  const industryMap = new Map();
  for (const row of enrichedRows) {
    if (!industryMap.has(row.industry)) industryMap.set(row.industry,{industry:row.industry,stockCount:0,netBuyCny:0,positiveCount:0});
    const sector = industryMap.get(row.industry);
    sector.stockCount += 1;
    if (Number.isFinite(row.netBuyCny)) {
      sector.netBuyCny += row.netBuyCny;
      if (row.netBuyCny>0) sector.positiveCount += 1;
    }
  }
  const topSeats = [...seatByName.values()].sort((a,b)=>b.netBuyCny-a.netBuyCny).slice(0,20);
  const dailyAvailable = dailyStatus === 'AVAILABLE' || dailyStatus === 'AVAILABLE_EMPTY';
  const seatAvailable = seatStatus === 'AVAILABLE' || seatStatus === 'AVAILABLE_EMPTY';
  return {
    schema:'ashare-v16-lhb-context-v1',
    tradeDate:normalizeDate(tradeDate),
    status:dailyAvailable?'AVAILABLE':String(dailyStatus),
    dailyStatus,
    seatStatus,
    recordCount:rows.length,
    appearancesRawCount:Array.isArray(dailyRows)?dailyRows.length:0,
    positiveStockCount:positiveCount,
    negativeStockCount:negativeCount,
    positiveStockRatio:rows.length?positiveCount/rows.length:null,
    totalNetBuyCny:netValues.length?netValues.reduce((sum,value)=>sum+value,0):null,
    institutionStatus:seatAvailable?(institutionValues.length?'AVAILABLE':'AVAILABLE_NO_INSTITUTION_ROWS'):'NOT_MEASURABLE',
    institutionalStockCount:institutionValues.length,
    institutionalPositiveCount,
    institutionalNegativeCount,
    institutionalPositiveStockRatio:institutionValues.length?institutionPositiveCount/institutionValues.length:null,
    institutionalNetBuyCny:institutionValues.length?institutionValues.reduce((sum,value)=>sum+value,0):null,
    rows:enrichedRows.slice(0,100),
    stockSignalsByCode,
    topSeats,
    sectors:[...industryMap.values()].sort((a,b)=>b.netBuyCny-a.netBuyCny),
    source:'Eastmoney DataCenter RPT_DAILYBILLBOARD_DETAILSNEW / RPT_OPERATEDEPT_TRADE_DETAILS'
  };
}

export function evaluateNextDayLimitUpPremium({
  previousLimitPools = null,
  currentStockRows = [],
  previousTradeDate = null,
  currentTradeDate = null,
  minimumCoverage = 0.8
} = {}) {
  const previousLimitUpAvailable = previousLimitPools
    && (previousLimitPools.status === 'AVAILABLE' || previousLimitPools.sourceStatus?.limitUp === 'AVAILABLE');
  if (!previousLimitUpAvailable
    || normalizeDate(previousTradeDate) >= normalizeDate(currentTradeDate)) {
    return {status:'NOT_MEASURABLE',reason:'previous-limit-up-pool-or-session-order-missing'};
  }
  const previous = Array.isArray(previousLimitPools.limitUp) ? previousLimitPools.limitUp : [];
  if (!previous.length) return {status:'NOT_MEASURABLE',reason:'previous-limit-up-cohort-empty'};
  const byCode = new Map((Array.isArray(currentStockRows)?currentStockRows:[]).map(row=>[String(row.code),row]));
  const matched = previous.map(row=>byCode.get(String(row.code))).filter(row=>row && finite(row.pct));
  const coverage = matched.length / previous.length;
  if (coverage < minimumCoverage) return {
    status:'NOT_MEASURABLE',reason:'next-session-cohort-coverage-below-threshold',
    sampleSize:matched.length,expectedSize:previous.length,coverage
  };
  const returns = matched.map(row=>Number(row.pct));
  return {
    status:'AVAILABLE',
    previousTradeDate:normalizeDate(previousTradeDate),
    currentTradeDate:normalizeDate(currentTradeDate),
    sampleSize:matched.length,
    expectedSize:previous.length,
    coverage,
    meanReturnPct:mean(returns),
    positiveRatio:returns.filter(value=>value>0).length/returns.length,
    sourceScope:'previous-limit-up-cohort-close-to-close-proxy'
  };
}

function sessionRow(session, code) {
  const rows = Array.isArray(session?.fundingRows) ? session.fundingRows
    : Array.isArray(session?.stockRows) ? session.stockRows : [];
  return rows.find(row=>String(row.code)===String(code)) ?? null;
}

export function scoreCandidateFundingEvidence({code, sessions = [], asOf = null} = {}) {
  const eligible = (Array.isArray(sessions)?sessions:[])
    .filter(session=>!asOf||normalizeDate(session.tradeDate??session.date)<=normalizeDate(asOf))
    .sort((a,b)=>normalizeDate(a.tradeDate??a.date).localeCompare(normalizeDate(b.tradeDate??b.date)))
    .slice(-3);
  const observations = eligible.map(session=>{
    const row=sessionRow(session,code);
    const lhb=session?.lhb?.stockSignalsByCode?.[String(code)]??null;
    return {
      tradeDate:normalizeDate(session.tradeDate??session.date),
      row,
      mainNet:num(row?.mainNet),
      institutionalNetBuyCny:num(lhb?.institutionalNetBuyCny),
      lhbNetBuyCny:num(lhb?.netBuyCny)
    };
  }).filter(item=>item.row);
  if(observations.length<2) return {
    code:String(code),status:'INSUFFICIENT_HISTORY',fundingScore:null,
    mainFlowPositiveDays:null,institutionalPositiveDays:null,trendConfirmed:false,
    chaseRiskScore:null,reasons:['fewer-than-two-point-in-time-observations']
  };
  const mainFlowValues=observations.map(item=>item.mainNet).filter(Number.isFinite);
  const mainFlowPositiveDays=mainFlowValues.filter(value=>value>0).length;
  const institutionValues=observations.map(item=>item.institutionalNetBuyCny).filter(Number.isFinite);
  const institutionalPositiveDays=institutionValues.filter(value=>value>0).length;
  const lows=observations.map(item=>num(item.row.low));
  const firstPrice=num(observations[0].row.price),lastPrice=num(observations.at(-1).row.price);
  const lastThreeLows=observations.slice(-3).map(item=>num(item.row.low));
  const higherLows=lastThreeLows.length===3&&lastThreeLows.every(Number.isFinite)
    &&lastThreeLows.slice(1).every((value,index)=>value>lastThreeLows[index]);
  const trendConfirmed=higherLows&&firstPrice!==null&&lastPrice!==null&&lastPrice>firstPrice;
  const mainFlowPersistent=mainFlowValues.length>=2&&mainFlowPositiveDays>=2&&trendConfirmed;
  const institutionPersistent=institutionValues.length>=2&&institutionalPositiveDays>=2&&trendConfirmed;
  const mainFlowScore=mainFlowValues.length?mainFlowPositiveDays/mainFlowValues.length*100:null;
  const institutionScore=institutionValues.length?institutionalPositiveDays/institutionValues.length*100:null;
  const evidenceParts=[];
  if(mainFlowPersistent)evidenceParts.push([mainFlowScore,0.6]);
  if(institutionPersistent)evidenceParts.push([institutionScore,0.4]);
  const totalWeight=evidenceParts.reduce((sum,[,weight])=>sum+weight,0);
  let fundingScore=totalWeight?evidenceParts.reduce((sum,[value,weight])=>sum+value*weight,0)/totalWeight:null;
  const current=observations.at(-1).row;
  const currentTurn=num(current.turn);
  const currentPct=num(current.pct);
  const positiveLows=lows.filter(value=>Number.isFinite(value)&&value>0);
  const extensionPct=positiveLows.length&&lastPrice!==null
    ? (lastPrice/Math.min(...positiveLows)-1)*100:null;
  let chaseRiskScore=0;
  if(currentTurn!==null&&extensionPct!==null&&currentTurn>=20&&extensionPct>=12)chaseRiskScore=90;
  else if(currentTurn!==null&&currentPct!==null&&currentTurn>=15&&currentPct>=8)chaseRiskScore=75;
  if(fundingScore!==null&&chaseRiskScore>=75)fundingScore=clamp(fundingScore-20);
  const reasons=[];
  if(mainFlowPersistent)reasons.push('main-force-net-flow-positive-on-at-least-two-observed-sessions-and-higher-lows-confirmed');
  if(institutionPersistent)reasons.push('institutional-lhb-net-buy-positive-on-at-least-two-observed-sessions-and-higher-lows-confirmed');
  if((mainFlowPositiveDays>=2||institutionalPositiveDays>=2)&&!trendConfirmed)reasons.push('capital-inflow-without-higher-lows-is-not-a-bottom-signal');
  if(chaseRiskScore>=75)reasons.push('high-turnover-and-price-extension-reduce-chase-score');
  if(!fundingScore)reasons.push('no-confirmed-multi-session-funding-persistence');
  return {
    code:String(code),
    status:fundingScore===null?'NO_CONFIRMED_PERSISTENCE':'AVAILABLE',
    fundingScore:fundingScore===null?null:Number(fundingScore.toFixed(2)),
    mainFlowPositiveDays,
    mainFlowObservationDays:mainFlowValues.length,
    institutionalPositiveDays,
    institutionalObservationDays:institutionValues.length,
    trendConfirmed,
    higherLows,
    extensionPct:extensionPct===null?null:Number(extensionPct.toFixed(2)),
    chaseRiskScore,
    observations:observations.map(item=>({
      tradeDate:item.tradeDate,mainNet:item.mainNet,
      institutionalNetBuyCny:item.institutionalNetBuyCny,lhbNetBuyCny:item.lhbNetBuyCny
    })),
    reasons
  };
}

export function rankFundingCandidates({currentRows = [], sessions = [], asOf = null, limit = 10} = {}) {
  const candidates=[];
  for(const row of Array.isArray(currentRows)?currentRows:[]){
    const code=String(row.code??'');
    if(!/^(00|60)\d{4}$/.test(code)||row.specialTreatment===true||/(?:\*?ST|退)/i.test(String(row.name??'')))continue;
    const evidence=scoreCandidateFundingEvidence({code,sessions,asOf});
    if(evidence.fundingScore===null)continue;
    candidates.push({
      code,name:String(row.name??code),industry:String(row.industry??'未知'),
      price:num(row.price),pct:num(row.pct),turn:num(row.turn),
      mainNet:num(row.mainNet),...evidence
    });
  }
  return candidates.sort((a,b)=>(b.fundingScore??-Infinity)-(a.fundingScore??-Infinity)
    ||(a.chaseRiskScore??0)-(b.chaseRiskScore??0)
    ||(b.mainNet??-Infinity)-(a.mainNet??-Infinity)).slice(0,Math.max(1,Math.min(50,Number(limit)||10)));
}
