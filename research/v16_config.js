// V16 initial research parameters. Frozen defaults; changes alter config fingerprint.
function freezeDeep(o) { for(const v of Object.values(o)) if(v && typeof v==='object') freezeDeep(v); return Object.freeze(o); }
export const V16_CONFIG = freezeDeep({
  modelVersion: 'V16.0.0-early-trend-shadow', configVersion: 'v16-initial-1', mode: 'SHADOW',
  weights: {earlyTrend:22, relativeStrength:18, volumePrice:15, fundFlow:15, industry:15, news:8, liquidity:7},
  data: {minBars:65, maxSnapshotSkewMinutes:15, maxMarketSkewMinutes:15, minIndustrySamples:15, minIndustryCoverage:0.8},
  trend: {breakoutBuffer:0.003, maxBaseWidth:0.16, moderateVolumeMin:1.15, moderateVolumeMax:2.5,
    compressionRatio:0.85, expansionRatio:1.05, maxEarlyReturn5:0.07, acceleratedReturn5:0.10,
    overheatedReturn5:0.16, maxEarlyDeviation20:0.10, overheatedDeviation20:0.18,
    failureBuffer:0.02, holdBuffer:0.005, minCloseLocation:0.65},
  flow: {minPositiveDays:3, minRatio:0.005, spikeMultiple:4, spikePenalty:12, outflowPenalty:18},
  volume: {upperWickRatio:0.45, extremeRatio:4, highTurnover:25, stagnantReturn:0.01, riskPenalty:12},
  industry: {minConfirmationScore:55, weakReturn5:-0.03, weakPenalty:10},
  market: {indices:['SSE','SZSE','CHINEXT','STAR50'], systemicReturn:-0.035, systemicBreadth:0.20,
    systemicLimitDownShare:0.015, weakReturn:-0.01, weakBreadth:0.4, strongReturn:0.008, strongBreadth:0.6,
    thresholds:{STRONG:62,RANGE:68,WEAK:78,SYSTEMIC:100,UNKNOWN:100},
    maxPosition:{STRONG:0.3,RANGE:0.2,WEAK:0.1,SYSTEMIC:0,UNKNOWN:0},
    volatilityThreshold:0.045, systemicVolatilityPenalty:15, systemicBreakoutMultiplier:0.5},
  risk: {overheatPenalty:25, accelerationPenalty:14, failedBreakoutPenalty:20,
    earningsDecline:-0.5, earningsPenalty:12, cashFlowPenalty:12, valuationRatio:3,
    valuationPenalty:8, pledgeRatio:0.5, pledgePenalty:10, severeDeteriorationPenalty:20},
  pool: {retentionMargin:3, maxSize:50},
  scoring: {base:20, maTurn:12, maOrder:12, reclaim:12, breakout20:18, breakout60:8,
    compression:8, hold:10, rsBase:50, rsScale:400, rsIndustryScale:300,
    volumeBase:30, moderateVolume:35, constructive:20, flowScale:500, flowBase:20,
    flowContinuity:35, flowPositiveWindows:25, industryBase:35, industryReturnScale:180,
    industryRelativeScale:120, industryBreadthScale:30, industryFlowScale:15,
    industryBreakoutScale:15, industryAmountScale:8, industryLeaderScale:10, industryAdvanceDeclineScale:5,
    newsBase:40, catalystPoints:15, newsMax:85, liquidityTargetAmount:200000000,
    liquidityMax:90, incompleteIndustryCap:49}
});
export function mergeV16Config(overrides={}) {
  function merge(a,b) {
    const out={...a};
    for(const [k,v] of Object.entries(b)) {
      if(!(k in a)) throw Error('Unknown V16 parameter: '+k);
      out[k]=v && typeof v==='object' && !Array.isArray(v) ? merge(a[k],v) : v;
    }
    return out;
  }
  const c=merge(V16_CONFIG,overrides);
  if(c.mode!=='SHADOW') throw Error('V16 is restricted to SHADOW');
  if(Object.values(c.weights).some(x=>!Number.isFinite(x)||x<0) ||
    Math.abs(Object.values(c.weights).reduce((a,b)=>a+b,0)-100)>1e-9) throw Error('Weights must sum to 100');
  function validate(x) { for(const v of Object.values(x)) { if(typeof v==='number' && !Number.isFinite(v)) throw Error('Non-finite parameter'); if(v && typeof v==='object') validate(v); } }
  validate(c); return c;
}
