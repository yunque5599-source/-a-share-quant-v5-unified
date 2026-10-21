export const config = { maxDuration: 30 };

import marketHandler from './market.js';
import { integrateCandidateFlow } from '../research/v11-short-alpha/candidate_flow.js';
import { selectV12Candidates } from '../research/v11-short-alpha/v12_universe.js';

function invoke(handler, url) {
  return new Promise((resolve, reject) => {
    let body = '';
    const req = {method:'GET', url};
    const res = {
      statusCode:200,
      setHeader() {},
      status(code) { this.statusCode = code; return this; },
      json(value) { body = JSON.stringify(value); resolve({statusCode:this.statusCode, body}); },
      send(value) { body = typeof value === 'string' ? value : JSON.stringify(value); resolve({statusCode:this.statusCode, body}); },
      end(value = '') { body = typeof value === 'string' ? value : JSON.stringify(value); resolve({statusCode:this.statusCode, body}); }
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

function parseBody(name, result) {
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(name + ' HTTP ' + result.statusCode + ': ' + result.body.slice(0, 400));
  }
  try { return JSON.parse(result.body); }
  catch (error) { throw new Error(name + ' invalid JSON: ' + error.message); }
}

function median(values) {
  const sorted=[...values].sort((a,b)=>a-b);
  if(!sorted.length)return null;
  const mid=Math.floor(sorted.length/2);
  return sorted.length%2?sorted[mid]:(sorted[mid-1]+sorted[mid])/2;
}

function buildRankedSectorProxy(candidates) {
  const groups=new Map();
  for(const row of candidates){
    const industry=String(row?.f100??row?.industry??'').trim();
    const pct=Number(row?.f3??row?.pct??row?.changePct);
    if(!industry||!Number.isFinite(pct))continue;
    const bucket=groups.get(industry)||[];
    bucket.push(pct);
    groups.set(industry,bucket);
  }
  const sectors=[...groups.entries()]
    .map(([industry,pcts])=>({industry,medianPct:median(pcts),sampleCount:pcts.length}))
    .filter(row=>row.medianPct!==null)
    .sort((a,b)=>b.medianPct-a.medianPct||b.sampleCount-a.sampleCount||a.industry.localeCompare(b.industry));
  return {
    qualifiedForDiscovery:sectors.length>=5,
    quality:{qualified:sectors.length>=5},
    source:'ranked-candidate-sector-proxy-v1',
    sectorResearch:{sectors}
  };
}

function compact(row, rank) {
  const setup=row?.features?.earlyOpportunity??{};
  const metrics=setup.metrics??{};
  return {
    rank:rank??row?.earlyOpportunityRank??null,
    symbol:row?.symbol??null,
    name:row?.name??row?.symbol??null,
    industry:row?.industry??null,
    price:row?.price??null,
    score:setup.score??null,
    stage:setup.stage??'insufficient-data',
    confidence:setup.confidence??0,
    components:setup.components??{},
    metrics,
    reasons:setup.reasons??[],
    diagnostics:setup.diagnostics??{},
    sectorScore:row?.features?.sector?.score??null,
    momentumScore:row?.features?.momentum?.score??null,
    overboughtRisk:row?.features?.momentum?.overboughtRisk??'unknown',
    quality:{
      complete:row?.quality?.complete===true,
      degraded:row?.quality?.degraded===true,
      stale:row?.quality?.stale===true,
      blockedReasons:row?.quality?.blockedReasons??[],
      warnings:row?.quality?.warnings??[]
    }
  };
}

const MAX_EARLY_CODES=18;

export default async function handler(req,res) {
  const startedAt=Date.now();
  try {
    const ranked=parseBody('ranked_candidates',
      await invoke(marketHandler,'/api/market?action=ranked_candidates'));
    const candidates=ranked?.data?.candidates??[];
    const diversified=selectV12Candidates(candidates,30);
    const codes=[...new Set(diversified
      .map(row=>String(row?.f12??'').trim())
      .filter(code=>/^(00|60)\d{4}$/.test(code)))].slice(0,MAX_EARLY_CODES);
    if(codes.length<3) {
      return res.status(422).json({
        schema:'early-opportunity-dashboard-v1',
        status:'INSUFFICIENT_UNIVERSE',
        error:'fewer than three eligible main-board candidates',
        diagnostics:{rankedCandidateCount:candidates.length,evaluatedCodes:codes.length}
      });
    }
    const deep=parseBody('deep_batch',
      await invoke(marketHandler,'/api/market?action=deep_batch&codes='+encodeURIComponent(codes.join(','))));
    const selected=candidates.filter(row=>codes.includes(String(row?.f12??'')));
    const sectorProxy=buildRankedSectorProxy(candidates);
    const decision=integrateCandidateFlow({
      ranked:{...ranked,data:{...ranked.data,candidates:selected}},
      deep,
      discovery:sectorProxy
    },{asOf:ranked?.data?.generatedAt});
    const ranking=(decision.earlyOpportunityRanking??[]).slice(0,18)
      .map((row,index)=>compact(row,index+1));
    const actionable=(decision.earlyOpportunityActionableRanking??[]).slice(0,10)
      .map((row,index)=>compact(row,index+1));
    const status=ranking.length?'READY':'INSUFFICIENT_HISTORY_OR_QUALITY';
    return res.status(200).json({
      schema:'early-opportunity-dashboard-v1',
      version:'V12 Early Opportunity Discovery v1',
      status,
      asOf:decision.asOf,
      market:decision.market,
      diagnostics:{
        rankedCandidateCount:candidates.length,
        evaluatedCodes:codes.length,
        deepHistoryRows:decision.diagnostics?.earlyOpportunityScored??0,
        eligible:decision.diagnostics?.earlyOpportunityEligible??0,
        actionable:decision.diagnostics?.earlyOpportunityActionable??0,
        degraded:deep?.dataQuality?.degraded===true,
        elapsedMs:Date.now()-startedAt,
        sectorSource:sectorProxy.source,
        sectorProxyQualified:sectorProxy.qualifiedForDiscovery,
        psychologySource:'not-required-for-low-base-score'
      },
      scope:'Ranks up to 18 diversified main-board candidates with real historical bars. It is not an exhaustive scan of every A-share stock.',
      ranking,
      actionableRanking:actionable
    });
  } catch(error) {
    return res.status(502).json({
      schema:'early-opportunity-dashboard-v1',
      status:'SOURCE_OR_COMPUTE_FAILED',
      elapsedMs:Date.now()-startedAt,
      error:error?.message||String(error)
    });
  }
}
