const finite=value=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value));
const num=value=>finite(value)?Number(value):null;
const clamp=(value,min=0,max=100)=>Math.max(min,Math.min(max,Number.isFinite(value)?value:min));
const timeMs=value=>typeof value==='string'&&/(?:Z|[+-]\d\d:\d\d)$/.test(value)?Date.parse(value):NaN;
const dateKey=value=>String(value??'').slice(0,10);
const available=status=>status==='AVAILABLE'||status==='AVAILABLE_EMPTY';

export function parseSealClock(value) {
  if(value===null||value===undefined||value==='')return null;
  let match;
  if(typeof value==='number'||/^\d{5,6}$/.test(String(value).trim())) {
    const raw=String(Math.trunc(Number(value))).padStart(6,'0');
    if(raw.length!==6)return null;
    match=raw.match(/^(\d{2})(\d{2})(\d{2})$/);
  } else {
    match=String(value).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  }
  if(!match)return null;
  const hour=Number(match[1]),minute=Number(match[2]),second=Number(match[3]??0);
  if(hour<9||hour>15||minute>59||second>59)return null;
  const total=hour*60+minute;
  if(total<570||total>900||(total>690&&total<780))return null;
  return total;
}
function clockLabel(minutes) {
  if(!Number.isFinite(minutes))return null;
  return String(Math.floor(minutes/60)).padStart(2,'0')+':'+String(minutes%60).padStart(2,'0');
}
function marketBreadthEvidence(breadth) {
  if(breadth?.universe!=='full-market'||breadth?.fullMarket!==true)return null;
  let ratio=num(breadth.upRatio);
  if(ratio===null) {
    const up=num(breadth.up),down=num(breadth.down),flat=num(breadth.flat)??0;
    if(up===null||down===null||up+down+flat<=0)return null;
    ratio=up/(up+down+flat);
  }
  return ratio>=0&&ratio<=1?ratio:null;
}

export function scoreLimitUpDailyProxy(row,{tradeDate=null,sourceStatus='AVAILABLE',marketBreadth=null}={}) {
  const code=String(row?.code??'');
  if(!available(sourceStatus)||!/^\\d{6}$/.test(code)||!/^\\d{4}-\\d{2}-\\d{2}$/.test(dateKey(tradeDate))) {
    return {code:code||null,status:'NOT_MEASURABLE',classification:'UNCLASSIFIED',dailyProxyScore:null,
      riskFlags:[],supportFlags:[],reason:'涨停池来源或交易日不完整'};
  }
  const firstSealMinutes=parseSealClock(row.firstSeal);
  const lastSealMinutes=parseSealClock(row.lastSeal);
  const breakTimes=num(row.breakTimes);
  const turnoverPct=num(row.turnoverPct);
  const sealFundCny=num(row.sealFundCny);
  const amountCny=num(row.amountCny);
  const limitDays=num(row.limitDays);
  const breadthRatio=marketBreadthEvidence(marketBreadth);
  const riskFlags=[],supportFlags=[],scoreParts={base:50,firstSeal:0,breakTimes:0,marketBreadth:0};
  if(firstSealMinutes!==null) {
    if(firstSealMinutes<=600) {scoreParts.firstSeal=10;supportFlags.push('FIRST_SEAL_BEFORE_10_00');}
    else if(firstSealMinutes<=630) {scoreParts.firstSeal=6;supportFlags.push('FIRST_SEAL_BEFORE_10_30');}
    else if(firstSealMinutes<=780) scoreParts.firstSeal=2;
    else if(firstSealMinutes>=870) {scoreParts.firstSeal=-10;riskFlags.push('LATE_FIRST_SEAL_AFTER_14_30');}
  }
  if(breakTimes!==null&&breakTimes>=0) {
    if(breakTimes===0) {scoreParts.breakTimes=15;supportFlags.push('NO_REPORTED_REOPEN');}
    else if(breakTimes===1) {scoreParts.breakTimes=5;riskFlags.push('ONE_REPORTED_REOPEN');}
    else if(breakTimes===2) {scoreParts.breakTimes=-10;riskFlags.push('MULTIPLE_REOPENS');}
    else {scoreParts.breakTimes=-20;riskFlags.push('FREQUENT_REOPENS');}
  }
  if(breadthRatio!==null) {
    scoreParts.marketBreadth=breadthRatio>=0.6?5:breadthRatio<0.4?-5:0;
    if(breadthRatio>=0.6)supportFlags.push('FULL_MARKET_BREADTH_SUPPORT');
    if(breadthRatio<0.4)riskFlags.push('WEAK_FULL_MARKET_BREADTH');
  }
  if(turnoverPct!==null&&turnoverPct>=25)riskFlags.push('HIGH_TURNOVER_REQUIRES_CONTEXT');
  if(limitDays!==null&&limitDays>=3)riskFlags.push('MULTI_BOARD_EXTENSION_RISK');
  const requiredMeasured=firstSealMinutes!==null&&breakTimes!==null&&breakTimes>=0;
  const classification=!requiredMeasured?'UNCLASSIFIED':
    (breakTimes>=2||(firstSealMinutes!==null&&firstSealMinutes>=870))?'PROXY_RISKY':
    (breakTimes===0&&firstSealMinutes<=630&&(breadthRatio===null||breadthRatio>=0.45))?'PROXY_STABLE':'PROXY_MIXED';
  const dailyProxyScore=requiredMeasured?Number(clamp(scoreParts.base+scoreParts.firstSeal+scoreParts.breakTimes+scoreParts.marketBreadth).toFixed(2)):null;
  const sealFundToAmountRatio=sealFundCny!==null&&amountCny!==null&&amountCny>0?sealFundCny/amountCny:null;
  const warnings=[
    '这是东方财富盘后事件池的日线代理诊断，不是逐笔封板或盘口撤单证据。',
    '代理分数未经过历史校准，不代表次日上涨概率，不参与V16主评分权重。'
  ];
  if(firstSealMinutes===null)warnings.push('首次封板时间缺失或格式不合法');
  if(breakTimes===null)warnings.push('炸板次数缺失');
  return {
    code,name:String(row.name??code),tradeDate:dateKey(tradeDate),poolType:'limitUp',
    status:requiredMeasured?'AVAILABLE':'PARTIAL',
    classification,dailyProxyScore,scoreParts,
    firstSeal:row.firstSeal??null,firstSealLabel:clockLabel(firstSealMinutes),
    lastSeal:row.lastSeal??null,lastSealLabel:clockLabel(lastSealMinutes),
    breakTimes,turnoverPct,sealFundCny,amountCny,sealFundToAmountRatio,limitDays,
    industry:String(row.industry??''),
    marketBreadthRatio:breadthRatio,
    riskFlags,supportFlags,warnings,
    intradayStatus:'NOT_MEASURABLE',
    orderBookCancellationStatus:'NOT_MEASURABLE',
    nextSessionFollowThroughStatus:'NOT_MEASURABLE',
    calibration:'NOT_CALIBRATED',
    use:'OBSERVATION_ONLY_NOT_SELECTION_WEIGHT'
  };
}

export function evaluateLimitUpQuality({limitPools=null,marketBreadth=null,tradeDate=null}={}) {
  const sourceStatus=limitPools?.sourceStatus??{};
  const upStatus=String(sourceStatus.limitUp??(limitPools?.status==='AVAILABLE'?'AVAILABLE':'NOT_MEASURABLE'));
  const brokenStatus=String(sourceStatus.broken??(limitPools?.status==='AVAILABLE'?'AVAILABLE':'NOT_MEASURABLE'));
  if(!available(upStatus))return {
    schema:'ashare-v16-limit-up-quality-v1',tradeDate:dateKey(tradeDate),
    status:'NOT_MEASURABLE',limitUpCount:0,rows:[],brokenRows:[],
    intradayStatus:'NOT_MEASURABLE',orderBookCancellationStatus:'NOT_MEASURABLE',
    nextSessionFollowThroughStatus:'NOT_MEASURABLE',
    limitations:['缺少完整涨停事件池，不能计算日线代理质量。']
  };
  const rows=(Array.isArray(limitPools?.limitUp)?limitPools.limitUp:[])
    .map(row=>scoreLimitUpDailyProxy(row,{tradeDate,sourceStatus:upStatus,marketBreadth}))
    .sort((a,b)=>(b.dailyProxyScore??-1)-(a.dailyProxyScore??-1)||a.code.localeCompare(b.code));
  const brokenRows=available(brokenStatus)?(Array.isArray(limitPools?.broken)?limitPools.broken:[]).map(row=>({
    code:String(row.code??''),name:String(row.name??row.code??''),tradeDate:dateKey(tradeDate),
    poolType:'broken',classification:'BROKEN_POOL_MEMBER',breakTimes:num(row.breakTimes),
    turnoverPct:num(row.turnoverPct),pct:num(row.pct),industry:String(row.industry??''),
    status:'AVAILABLE',warning:'供应商炸板池成员；不推断盘中精确开板序列或收盘封板状态。'
  })):[];
  const counts={PROXY_STABLE:0,PROXY_MIXED:0,PROXY_RISKY:0,UNCLASSIFIED:0};
  for(const row of rows)counts[row.classification]=(counts[row.classification]??0)+1;
  return {
    schema:'ashare-v16-limit-up-quality-v1',tradeDate:dateKey(tradeDate),
    status:rows.length?'AVAILABLE':'AVAILABLE_EMPTY',
    source:'Eastmoney post-close limit-up event pool',
    sourceStatus:{limitUp:upStatus,broken:brokenStatus},
    limitUpCount:rows.length,brokenBoardCount:available(brokenStatus)?brokenRows.length:null,
    classificationCounts:counts,rows,brokenRows,
    intradayStatus:'NOT_MEASURABLE',orderBookCancellationStatus:'NOT_MEASURABLE',
    nextSessionFollowThroughStatus:'NOT_MEASURABLE',
    calibration:'NOT_CALIBRATED',
    limitations:[
      '首次封板时间、炸板次数、换手率和封单资金来自供应商盘后事件池，只作为日线代理。',
      '缺少逐分钟完整覆盖、逐笔成交和盘口委托/撤单事件，无法验证真实封板时长、回封速度及封单稳定性。',
      '次日延续必须使用下一交易日集合竞价及前15分钟数据；不得用信号日收盘数据替代。',
      '日线代理分数未校准，不参与V16主评分或买入许可。'
    ]
  };
}

export function evaluateIntradaySealQuality(evidence=null,asOf=null) {
  const now=timeMs(asOf),availableAt=timeMs(evidence?.availableAt);
  if(!evidence||!evidence.source||!Number.isFinite(now)||!Number.isFinite(availableAt)||availableAt>now)
    return {status:'NOT_MEASURABLE',score:null,reason:'缺少来源、有效时间或点时约束'};
  const expected=num(evidence.coverage?.expectedBars),observed=num(evidence.coverage?.observedBars);
  const coverage=expected>0&&observed!==null?observed/expected:0;
  const reopenCount=num(evidence.reopenCount),sealedSeconds=num(evidence.sealedSeconds),observedSeconds=num(evidence.observedSeconds);
  const firstSealAt=timeMs(evidence.firstSealAt);
  if(evidence.coverage?.complete!==true||coverage<0.95||reopenCount===null||reopenCount<0||
    sealedSeconds===null||observedSeconds===null||observedSeconds<=0||sealedSeconds<0||sealedSeconds>observedSeconds||
    !Number.isFinite(firstSealAt)||firstSealAt>now)
    return {status:'PARTIAL',score:null,coverage,reason:'分钟数据覆盖、开板次数、封板时长或时间戳不完整'};
  const sealRatio=sealedSeconds/observedSeconds;
  const reseal=num(evidence.medianResealSeconds);
  const score=clamp(50+(sealRatio-0.5)*50-reopenCount*8+
    (reseal===null?0:reseal<=60?5:reseal>=300?-5:0));
  return {
    status:'AVAILABLE',score:Number(score.toFixed(2)),coverage:Number(coverage.toFixed(4)),
    sealRatio:Number(sealRatio.toFixed(4)),reopenCount,medianResealSeconds:reseal,
    firstSealAt:evidence.firstSealAt,source:evidence.source,availableAt:evidence.availableAt,
    evidenceLevel:evidence.evidenceLevel==='TICK_EVENTS'?'TICK_EVENTS':'MINUTE_BAR_PROXY',
    calibration:'NOT_CALIBRATED'
  };
}

export function evaluateOrderBookCancellationRisk(evidence=null,asOf=null) {
  const now=timeMs(asOf),availableAt=timeMs(evidence?.availableAt);
  if(!evidence||!evidence.source||!Number.isFinite(now)||!Number.isFinite(availableAt)||availableAt>now)
    return {status:'NOT_MEASURABLE',cancelRatio:null,riskClass:'UNKNOWN'};
  const added=num(evidence.addedBidCny),cancelled=num(evidence.cancelledBidCny),executed=num(evidence.executedBidCny);
  if(evidence.coverageComplete!==true||added===null||cancelled===null||executed===null||
    added<=0||cancelled<0||executed<0||cancelled>added)
    return {status:'PARTIAL',cancelRatio:null,riskClass:'UNKNOWN'};
  const cancelRatio=cancelled/added;
  return {
    status:'AVAILABLE',cancelRatio:Number(cancelRatio.toFixed(4)),
    riskScore:Number((cancelRatio*100).toFixed(2)),
    riskClass:cancelRatio>=0.6?'HIGH':cancelRatio>=0.3?'ELEVATED':'LOW',
    addedBidCny:added,cancelledBidCny:cancelled,executedBidCny:executed,
    source:evidence.source,availableAt:evidence.availableAt,
    calibration:'NOT_CALIBRATED'
  };
}

export function evaluateNextSessionContinuation({
  signalDate=null,signalClose=null,nextSession=null,marketFirst15m=null,sectorFirst15m=null,asOf=null
}={}) {
  const now=timeMs(asOf),availableAt=timeMs(nextSession?.first15m?.availableAt);
  const signalPrice=num(signalClose),open=num(nextSession?.auction?.open);
  const first=nextSession?.first15m??{};
  const firstOpen=num(first.open),firstClose=num(first.close),vwap=num(first.vwap);
  const expected=num(first.coverage?.expectedBars),observed=num(first.coverage?.observedBars);
  const coverage=expected>0&&observed!==null?observed/expected:0;
  const marketReturn=num(marketFirst15m?.returnPct),sectorReturn=num(sectorFirst15m?.returnPct);
  const marketAvailableAt=timeMs(marketFirst15m?.availableAt),sectorAvailableAt=timeMs(sectorFirst15m?.availableAt);
  const valid=Number.isFinite(now)&&Number.isFinite(availableAt)&&availableAt<=now&&
    dateKey(nextSession?.tradeDate)>dateKey(signalDate)&&signalPrice!==null&&signalPrice>0&&
    Number.isFinite(num(open))&&open>0&&Number.isFinite(firstOpen)&&firstOpen>0&&
    Number.isFinite(firstClose)&&firstClose>0&&Number.isFinite(vwap)&&vwap>0&&
    first.source&&first.coverage?.complete===true&&coverage>=0.95&&
    Number.isFinite(marketReturn)&&Number.isFinite(marketAvailableAt)&&marketAvailableAt<=now&&
    Number.isFinite(sectorReturn)&&Number.isFinite(sectorAvailableAt)&&sectorAvailableAt<=now;
  if(!valid)return {
    status:'NOT_MEASURABLE',score:null,classification:'UNKNOWN',
    reason:'次日集合竞价、前15分钟VWAP、市场及行业同步数据未完整取得',
    forecastConvention:'POST_OPEN_CONFIRMATION_NOT_PREVIOUS_CLOSE_PREDICTION'
  };
  const gapPct=(open/signalPrice-1)*100;
  const first15mReturnPct=(firstClose/firstOpen-1)*100;
  const vwapPremiumPct=(firstClose/vwap-1)*100;
  const relativeMarketPct=first15mReturnPct-marketReturn;
  const relativeSectorPct=first15mReturnPct-sectorReturn;
  const gapPenalty=gapPct>=5?15:gapPct>=3?8:0;
  const score=clamp(50+clamp(first15mReturnPct*5,-20,20)+clamp(vwapPremiumPct*10,-15,15)+
    clamp(relativeMarketPct*3,-8,8)+clamp(relativeSectorPct*4,-10,10)-gapPenalty);
  const classification=score>=65&&vwapPremiumPct>0&&relativeSectorPct>=0?'STRONG_FOLLOW_THROUGH':
    score<40||vwapPremiumPct<0&&first15mReturnPct<0?'WEAK_FOLLOW_THROUGH':'MIXED_FOLLOW_THROUGH';
  return {
    status:'AVAILABLE',score:Number(score.toFixed(2)),classification,
    gapPct:Number(gapPct.toFixed(3)),first15mReturnPct:Number(first15mReturnPct.toFixed(3)),
    vwapPremiumPct:Number(vwapPremiumPct.toFixed(3)),relativeMarketPct:Number(relativeMarketPct.toFixed(3)),
    relativeSectorPct:Number(relativeSectorPct.toFixed(3)),coverage:Number(coverage.toFixed(4)),
    tradeDate:dateKey(nextSession.tradeDate),decisionTime:asOf,
    forecastConvention:'POST_OPEN_CONFIRMATION_NOT_PREVIOUS_CLOSE_PREDICTION',
    calibration:'NOT_CALIBRATED'
  };
}
