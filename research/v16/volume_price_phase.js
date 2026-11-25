const finite=value=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value));
const num=value=>finite(value)?Number(value):null;
const mean=values=>{const valid=values.filter(Number.isFinite);return valid.length?valid.reduce((sum,value)=>sum+value,0)/valid.length:null;};
const round=value=>Number(value.toFixed(4));
const time=value=>typeof value==='string'&&/(?:Z|[+-]\d\d:\d\d)$/.test(value)?Date.parse(value):NaN;
const closeAt=date=>Date.parse(date+'T15:00:00+08:00');
const dateOf=value=>new Date(value+8*3600000).toISOString().slice(0,10);

const LABELS={
  EARLY_BREAKOUT:'早期放量突破',
  CONSTRUCTIVE_PULLBACK:'缩量回踩守支撑',
  REACCELERATION:'回踩后再放量',
  TIGHT_CONSOLIDATION:'高位缩量整理',
  ACCELERATION_RISK:'短期加速偏热',
  DISTRIBUTION_RISK:'放量回落/支撑破位',
  NEUTRAL:'暂未形成清晰结构'
};
const ADJUSTMENTS={
  EARLY_BREAKOUT:2,CONSTRUCTIVE_PULLBACK:3,REACCELERATION:4,
  TIGHT_CONSOLIDATION:1,ACCELERATION_RISK:-3,DISTRIBUTION_RISK:-6,NEUTRAL:0
};
function unavailable(status,reason,extra={}) {
  return {status,classification:'NOT_MEASURABLE',label:'不可测',confidence:'NONE',
    researchAdjustment:0,mainScoreAdjustment:0,usedForSelection:false,
    reasons:[],warnings:[reason],...extra};
}

export function classifyVolumePricePhase(rawBars,{asOf=null,expectedDate=null,breakoutLevel=null,minBars=25}={}) {
  const asOfMs=time(asOf);
  if(!Number.isFinite(asOfMs))return unavailable('NOT_MEASURABLE','缺少带时区的asOf时间');
  const input=Array.isArray(rawBars)?rawBars:[];
  const visible=input.filter(bar=>bar&&/^\d{4}-\d{2}-\d{2}$/.test(String(bar.date??''))&&
    typeof bar.source==='string'&&bar.source.length>0&&Number.isFinite(time(bar.availableAt))&&
    time(bar.availableAt)<=asOfMs&&closeAt(bar.date)<=asOfMs)
    .sort((a,b)=>a.date.localeCompare(b.date));
  const duplicate=new Set(visible.map(bar=>bar.date)).size!==visible.length;
  const invalid=visible.filter(bar=>{
    const open=num(bar.open),high=num(bar.high),low=num(bar.low),close=num(bar.close),volume=num(bar.volume),amount=num(bar.amount);
    return open===null||high===null||low===null||close===null||volume===null||amount===null||
      open<=0||high<=0||low<=0||close<=0||volume<0||amount<0||
      high<Math.max(open,close)||low>Math.min(open,close);
  });
  if(duplicate||invalid.length)return unavailable('PARTIAL',
    duplicate?'日线日期重复，拒绝计算量价阶段':'OHLCV字段异常，拒绝计算量价阶段',
    {visibleBarCount:visible.length,duplicateDates:duplicate,invalidBarCount:invalid.length});
  const bars=visible;
  if(bars.length<minBars)return unavailable('NOT_MEASURABLE',
    '有效且点时可见的日线不足'+minBars+'根',{visibleBarCount:bars.length,requiredBars:minBars});
  const latest=bars.at(-1),previous=bars.at(-2);
  const expectedBarDate=/^\\d{4}-\\d{2}-\\d{2}$/.test(String(expectedDate??''))?String(expectedDate):dateOf(asOfMs);
  if(closeAt(expectedBarDate)>asOfMs||latest.date!==expectedBarDate)return unavailable('PARTIAL',
    '最新日线日期与点时指定的最近完整交易日不一致',
    {visibleBarCount:bars.length,latestBarDate:latest.date,expectedDate:expectedBarDate});
  const prior20=bars.slice(-21,-1);
  if(prior20.length<20)return unavailable('NOT_MEASURABLE','缺少完整20日基准窗口',{visibleBarCount:bars.length});
  const baselineVolume=mean(prior20.map(bar=>num(bar.volume)));
  const ma20=mean(bars.slice(-20).map(bar=>num(bar.close)));
  if(!(baselineVolume>0&&ma20>0))return unavailable('PARTIAL','20日成交量或均线基准无效');
  const last5=bars.slice(-5);
  const avgVolume5=mean(last5.map(bar=>num(bar.volume)));
  const lastVolumeRatio20=num(latest.volume)/baselineVolume;
  const fiveDayVolumeRatio=avgVolume5/baselineVolume;
  const prior20High=Math.max(...prior20.map(bar=>num(bar.high)));
  const last5High=Math.max(...last5.map(bar=>num(bar.high)));
  const last5Low=Math.min(...last5.map(bar=>num(bar.low)));
  const range5Pct=(last5High-last5Low)/Math.max(0.000001,mean(last5.map(bar=>num(bar.close))))*100;
  const return5Pct=(num(latest.close)/num(bars.at(-6).close)-1)*100;
  const deviation20Pct=(num(latest.close)/ma20-1)*100;
  const closeLocation=(num(latest.close)-num(latest.low))/Math.max(0.000001,num(latest.high)-num(latest.low));
  const downBars=last5.filter((bar,index)=>index>0&&num(bar.close)<num(last5[index-1].close));
  const upBars=last5.filter((bar,index)=>index>0&&num(bar.close)>num(last5[index-1].close));
  const avgDownVolume=mean(downBars.map(bar=>num(bar.volume)));
  const avgUpVolume=mean(upBars.map(bar=>num(bar.volume)));
  const downVolumeRatio20=avgDownVolume===null?null:avgDownVolume/baselineVolume;
  const downVsUpVolumeRatio=avgDownVolume!==null&&avgUpVolume>0?avgDownVolume/avgUpVolume:null;
  const recentPeak=Math.max(...bars.slice(-6,-1).map(bar=>num(bar.high)));
  const pullbackDepthPct=(recentPeak-num(latest.close))/recentPeak*100;
  const recentImpulsePct=(recentPeak/num(bars.at(-6).close)-1)*100;
  const suppliedBreakout=num(breakoutLevel);
  const breakoutWasEstablished=suppliedBreakout!==null&&suppliedBreakout>0&&
    bars.slice(-10).some(bar=>num(bar.close)>=suppliedBreakout*1.003);
  const supportLevel=breakoutWasEstablished?suppliedBreakout:ma20;
  const supportHeld=num(latest.close)>=supportLevel*0.98&&num(latest.close)>=ma20*0.98;
  const downVolumeContracted=downBars.length>0&&
    ((avgDownVolume!==null&&avgDownVolume<=baselineVolume*0.9)||
     (avgUpVolume!==null&&avgUpVolume>0&&avgDownVolume<=avgUpVolume*0.85));
  const hasPriorImpulse=recentImpulsePct>=3||bars.slice(-10,-1).some((bar,index,rows)=>{
    const prev=index?rows[index-1]:bars.at(-11);
    return prev&&num(bar.close)/num(prev.close)-1>=0.025;
  });
  const pullbackSetup=hasPriorImpulse&&pullbackDepthPct>=0.5&&pullbackDepthPct<=8&&
    downBars.length>=1&&downBars.length<=4&&downVolumeContracted&&supportHeld;
  const prePullbackBars=bars.slice(-6,-1);
  const prePeak=Math.max(...prePullbackBars.map(bar=>num(bar.high)));
  const preDepthPct=(prePeak-num(previous.close))/prePeak*100;
  const preDownBars=prePullbackBars.filter((bar,index)=>index>0&&num(bar.close)<num(prePullbackBars[index-1].close));
  const preUpBars=prePullbackBars.filter((bar,index)=>index>0&&num(bar.close)>num(prePullbackBars[index-1].close));
  const preDownVolume=mean(preDownBars.map(bar=>num(bar.volume)));
  const preUpVolume=mean(preUpBars.map(bar=>num(bar.volume)));
  const prePullbackContracted=preDownBars.length>0&&
    ((preDownVolume!==null&&preDownVolume<=baselineVolume*0.9)||
     (preUpVolume!==null&&preUpVolume>0&&preDownVolume<=preUpVolume*0.85));
  const priorPullbackSetup=hasPriorImpulse&&preDepthPct>=0.5&&preDepthPct<=8&&
    preDownBars.length>=1&&prePullbackContracted&&
    num(previous.close)>=supportLevel*0.98&&num(previous.close)>=ma20*0.98;
  const reacceleration=priorPullbackSetup&&num(latest.close)>num(latest.open)&&
    num(latest.close)>num(previous.high)*1.001&&lastVolumeRatio20>=1.15&&closeLocation>=0.65&&supportHeld;
  const supportBroken=num(latest.close)<supportLevel*0.98||num(latest.close)<ma20*0.98;
  const heavyDownVolume=downBars.length>=2&&downVolumeRatio20!==null&&downVolumeRatio20>=1.2&&return5Pct<0;
  const highVolumeWeakClose=num(latest.close)<num(latest.open)&&lastVolumeRatio20>=1.5&&
    closeLocation<=0.35&&pullbackDepthPct>=3;
  const distribution=supportBroken||heavyDownVolume||highVolumeWeakClose;
  const earlyBreakout=num(latest.close)>prior20High*1.003&&lastVolumeRatio20>=1.15&&
    lastVolumeRatio20<=3.5&&closeLocation>=0.6&&return5Pct<=10&&deviation20Pct<=10;
  const accelerationRisk=return5Pct>=10||deviation20Pct>=10;
  const tightConsolidation=range5Pct<=6&&fiveDayVolumeRatio<=0.9&&num(latest.close)>=ma20*0.98;
  let classification='NEUTRAL';
  if(distribution)classification='DISTRIBUTION_RISK';
  else if(reacceleration)classification='REACCELERATION';
  else if(pullbackSetup)classification='CONSTRUCTIVE_PULLBACK';
  else if(accelerationRisk)classification='ACCELERATION_RISK';
  else if(earlyBreakout)classification='EARLY_BREAKOUT';
  else if(tightConsolidation)classification='TIGHT_CONSOLIDATION';
  const reasons=[];
  if(classification==='EARLY_BREAKOUT')reasons.push('收盘有效越过20日高点，成交量高于20日基准');
  if(classification==='CONSTRUCTIVE_PULLBACK')reasons.push('前期有价格推进，回撤幅度受控，回落日成交量收缩且守住支撑');
  if(classification==='REACCELERATION')reasons.push('缩量回踩后收盘重新越过前一日高点，成交量恢复');
  if(classification==='TIGHT_CONSOLIDATION')reasons.push('近5日振幅收窄且成交量低于20日基准');
  if(classification==='ACCELERATION_RISK')reasons.push('5日涨幅或相对MA20乖离偏高，存在追高风险');
  if(classification==='DISTRIBUTION_RISK')reasons.push('放量回落、弱收盘或关键支撑失守，不能按缩量洗盘解释');
  if(classification==='NEUTRAL')reasons.push('当前日线量价结构不满足已定义的启动、回踩或整理条件');
  return {
    status:'AVAILABLE',classification,label:LABELS[classification],confidence:bars.length>=60?'HIGH':'MEDIUM',
    researchAdjustment:ADJUSTMENTS[classification]??0,mainScoreAdjustment:0,usedForSelection:false,
    visibleBarCount:bars.length,latestBarDate:latest.date,source:latest.source,
    metrics:{
      close:num(latest.close),ma20:round(ma20),prior20High:round(prior20High),supportLevel:round(supportLevel),
      return5Pct:round(return5Pct),deviation20Pct:round(deviation20Pct),volumeRatio20:round(lastVolumeRatio20),
      fiveDayVolumeRatio:round(fiveDayVolumeRatio),downVolumeRatio20:downVolumeRatio20===null?null:round(downVolumeRatio20),
      downVsUpVolumeRatio:downVsUpVolumeRatio===null?null:round(downVsUpVolumeRatio),
      pullbackDepthPct:round(pullbackDepthPct),range5Pct:round(range5Pct),
      downDays:downBars.length,closeLocation:round(closeLocation),supportHeld,
      downVolumeContracted,breakoutWasEstablished
    },
    reasons,warnings:[
      '这是日线量价结构分类，不是逐笔主动买卖或主力真实持仓判断。',
      '未复权价格用于避免未来公司行动复权造成回看偏差；除权除息附近可能出现价格跳变，需单独核验。'
    ],
    calibration:'NOT_CALIBRATED',use:'SHADOW_RESEARCH_ONLY'
  };
}

export const VOLUME_PRICE_PHASE_LABELS=LABELS;
