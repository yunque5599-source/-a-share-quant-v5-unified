'use strict';

// Point-in-time policy taxonomy and market-regime overlay.
// Policy alignment is thematic exposure, NOT proof of a grant, subsidy, order, or company-specific government support.

export const POLICY_CATALOG_VERSION = 'CN-policy-map-2026-10-26-v3';
export const POLICY_CATALOG_REVIEWED_AT = '2026-10-26T12:08:00+08:00';

export const OFFICIAL_POLICIES = [
  {
    id: 'tech-industry-integration-2026-10-21',
    title: '关于推动科技创新和产业创新深度融合的意见',
    publishedAt: '2026-10-21',
    source: '中华人民共和国科学技术部',
    url: 'https://www.most.gov.cn/xxgk/xinxifenlei/fdzdgknr/fgzc/gfxwj/gfxwj2026/202610/t20261021_197540.html',
    priority: 100
  },
  {
    id: 'new-quality-productivity-2026-10-09',
    title: '关于发展新质生产力的意见',
    publishedAt: '2026-10-09',
    source: '中华人民共和国工业和信息化部',
    url: 'https://www.miit.gov.cn/xwfb/szyw/art/2026/art_bb063b402f814c2d829cb53688ee84c0.html',
    priority: 96
  },
  {
    id: 'ai-plus-action-2025-08-26',
    title: '国务院关于深入实施“人工智能+”行动的意见',
    issuedAt: '2025-08-21',
    publishedAt: '2025-08-26',
    source: '国务院（工业和信息化部转载）',
    url: 'https://www.miit.gov.cn/xwfb/szyw/art/2025/art_f8bd63905b384841a84e643c1b9455c7.html',
    priority: 99
  },
  {
    id: 'new-energy-storage-2025-09-12',
    title: '国家发展改革委 国家能源局关于印发《新型储能规模化建设专项行动方案（2025—2027年）》的通知',
    issuedAt: '2025-08-27',
    publishedAt: '2025-09-12',
    source: '国家发展改革委、国家能源局',
    url: 'https://www.ndrc.gov.cn/xxgk/zcfb/tz/202509/t20250912_1400425.html',
    priority: 93
  },
  {
    id: 'tech-commerce-2026-10-13',
    title: '关于加快推进科技兴商的意见',
    issuedAt: '2026-10-13',
    publishedAt: '2026-10-19',
    source: '中华人民共和国商务部等9部门',
    url: 'https://www.mofcom.gov.cn/zcfb/zc/art/2026/art_202618c40d1943e9abfed97cef83e671.html',
    priority: 82
  }
];

export const POLICY_THEMES = [
  { id:'ai-computing', label:'人工智能/算力/智能终端', priority:98, policyIds:['tech-industry-integration-2026-10-21','ai-plus-action-2025-08-26','new-quality-productivity-2026-10-09','tech-commerce-2026-10-13'], keywords:['人工智能','AI','算力','算法','大模型','智能终端','智能手机','智能电脑','数据中心','服务器','液冷','云计算','数据要素','智能计算','AIDC'] },
  { id:'robotics-embodied-ai', label:'机器人/具身智能', priority:97, policyIds:['tech-industry-integration-2026-10-21','ai-plus-action-2025-08-26','new-quality-productivity-2026-10-09'], keywords:['机器人','具身智能','人形机器人','工业机器人','服务机器人','机器视觉','减速器','灵巧手'] },
  { id:'semiconductors-next-gen-it', label:'新一代信息技术/半导体', priority:96, policyIds:['tech-industry-integration-2026-10-21','ai-plus-action-2025-08-26','new-quality-productivity-2026-10-09'], keywords:['半导体','芯片','集成电路','先进封装','光刻','存储芯片','电子元件','通信设备','新一代信息技术','光模块','高速连接','PCB','算力芯片'] },
  { id:'smart-manufacturing-industrial-digital', label:'智能制造/工业互联网/数字化改造', priority:94, policyIds:['tech-industry-integration-2026-10-21','new-quality-productivity-2026-10-09','tech-commerce-2026-10-13'], keywords:['智能制造','工业互联网','工业软件','数字孪生','自动化设备','数控机床','机器视觉','工业数字化','制造业数字化','设备更新','工业控制','工业母机'] },
  { id:'new-energy-materials', label:'新能源/新材料', priority:93, policyIds:['tech-industry-integration-2026-10-21','new-quality-productivity-2026-10-09'], keywords:['新能源','光伏','风电','新材料','电池材料','固态电池','钠离子电池','电网设备','特高压','电力设备'] },
  { id:'energy-storage-grid', label:'新型储能/电网灵活性', priority:98, policyIds:['new-energy-storage-2025-09-12','tech-industry-integration-2026-10-21','new-quality-productivity-2026-10-09'], preferredPolicyId:'new-energy-storage-2025-09-12', keywords:['新型储能','储能','储能系统','储能电站','独立储能','电化学储能','液流电池','压缩空气储能','构网型储能','储能变流器','PCS','电力调峰'] },
  { id:'smart-ev', label:'智能网联新能源汽车', priority:92, policyIds:['tech-industry-integration-2026-10-21','new-quality-productivity-2026-10-09'], keywords:['智能网联汽车','新能源汽车','汽车零部件','自动驾驶','车路云','汽车电子','动力电池','智能座舱'] },
  { id:'biomed-bio-manufacturing', label:'生物医药/生物制造', priority:91, policyIds:['tech-industry-integration-2026-10-21','new-quality-productivity-2026-10-09'], keywords:['生物制造','生物医药','创新药','医疗器械','合成生物','基因技术','生物技术','医药制造','细胞治疗','核酸药物'] },
  { id:'aerospace-low-altitude', label:'航空航天/商业航天/低空经济', priority:91, policyIds:['tech-industry-integration-2026-10-21','new-quality-productivity-2026-10-09'], keywords:['航空航天','商业航天','卫星','卫星互联网','低空经济','无人机','航空装备','航天装备','火箭','eVTOL'] },
  { id:'future-frontier', label:'量子/氢能核聚变/脑机接口/6G', priority:90, policyIds:['tech-industry-integration-2026-10-21','ai-plus-action-2025-08-26','new-quality-productivity-2026-10-09'], keywords:['量子科技','量子通信','量子计算','氢能','核聚变','脑机接口','第六代移动通信','6G','前沿科技'] },
  { id:'high-end-equipment', label:'高端装备/重大技术改造', priority:89, policyIds:['tech-industry-integration-2026-10-21','new-quality-productivity-2026-10-09'], keywords:['高端装备','高端制造','重大技术改造','设备更新','工程机械','轨道交通装备','精密制造'] },
  { id:'tech-commerce-digital', label:'科技兴商/商贸数字化', priority:84, policyIds:['tech-commerce-2026-10-13'], keywords:['科技兴商','商贸数字化','智慧零售','智慧物流','供应链数字化','物联网','区块链','云计算','大数据','数字孪生','商贸智能化'] }
];

function n(value) {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return null;
  return Number(value);
}
function clamp(value, min=0, max=100) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}
function cutoffMs(value) {
  const raw = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return Date.parse(raw + 'T15:00:00+08:00');
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : Date.now();
}
function parseNewsTimestamp(value) {
  if (typeof value === 'number') {
    const ms = value < 1e12 ? value * 1000 : value;
    return Number.isFinite(ms) ? ms : NaN;
  }
  const raw = String(value ?? '').trim();
  if (!raw) return NaN;
  // Date-only news has no verifiable publication time; treat it as end-of-day China time.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return Date.parse(raw + 'T23:59:59+08:00');
  // Public Chinese finance feeds often omit the timezone; interpret naive timestamps as China Standard Time.
  const naive = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)$/);
  if (naive) return Date.parse(naive[1] + 'T' + naive[2] + '+08:00');
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : NaN;
}
function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g,' ').trim().slice(0,1000);
}
function matchKeywords(text, keywords) {
  const haystack = normalizeText(text).toLowerCase();
  return keywords.filter(keyword => {
    const needle = String(keyword).toLowerCase();
    // Short Latin acronyms (especially "AI") need token boundaries: "AI" must not match "retail".
    if (/^[a-z0-9]{1,2}$/.test(needle)) {
      return new RegExp('(^|[^a-z0-9])' + needle + '([^a-z0-9]|$)', 'i').test(haystack);
    }
    return haystack.includes(needle);
  });
}
function policyAgeFactor(publishedAt, cutoff) {
  const ageDays = Math.max(0, (cutoff - Date.parse(publishedAt + 'T23:59:59+08:00')) / 86400000);
  return 0.75 + 0.25 * Math.exp(-ageDays / 45);
}
function effectivePolicy(policyId, cutoff) {
  return OFFICIAL_POLICIES.find(policy =>
    policy.id === policyId && Date.parse(policy.publishedAt + 'T00:00:00+08:00') <= cutoff
  ) ?? null;
}

export function scorePolicyAlignment({ industry='', themeNames=[], companyNews=[], asOf=null } = {}) {
  const cutoff = cutoffMs(asOf);
  const catalogReviewedMs = Date.parse(POLICY_CATALOG_REVIEWED_AT);
  const catalogNotYetAvailable = Number.isFinite(cutoff) && Number.isFinite(catalogReviewedMs) && cutoff < catalogReviewedMs;
  const catalogAgeDays = Number.isFinite(catalogReviewedMs) && !catalogNotYetAvailable
    ? Math.max(0,(cutoff-catalogReviewedMs)/86400000) : 0;
  const catalogStale = !catalogNotYetAvailable && catalogAgeDays > 14;
  // Do not retroactively apply a taxonomy first reviewed after the requested signal cutoff.
  // The policy documents themselves are date-filtered below, but the keyword map is also
  // knowledge that must have existed at the time of the signal.
  if (catalogNotYetAvailable) {
    return {
      score:50,
      evidenceAvailable:false,
      matchedThemeCount:0,
      matchedThemes:[],
      catalogVersion:POLICY_CATALOG_VERSION,
      catalogReviewedAt:POLICY_CATALOG_REVIEWED_AT,
      catalogAgeDays:0,
      catalogStale:false,
      catalogNotYetAvailable:true,
      catalogAvailableAtCutoff:false,
      catalogWarning:'policy-catalog-not-available-at-signal-cutoff',
      asOf:String(asOf??''),
      interpretation:'policy-catalog-not-available-at-signal-cutoff'
    };
  }
  const industries = normalizeText(industry);
  const themes = (Array.isArray(themeNames) ? themeNames : [themeNames]).map(normalizeText).filter(Boolean);
  const news = (Array.isArray(companyNews) ? companyNews : []).filter(item => {
    const timestamp = item?.publishedAt ?? item?.publishTime ?? item?.date ?? item?.time ?? null;
    if (timestamp === null) return false;
    const parsed = parseNewsTimestamp(timestamp);
    return Number.isFinite(parsed) && parsed <= cutoff;
  });
  const scoredThemes = [];
  for (const theme of POLICY_THEMES) {
    const industryMatches = matchKeywords(industries, theme.keywords);
    const themeMatches = themes.flatMap(name => matchKeywords(name, theme.keywords).map(keyword => ({name, keyword})));
    const newsMatches = news.flatMap(item => {
      const title = normalizeText(item.title ?? item.headline ?? item.name);
      // A generic sector headline is not company-level exposure; require a business/action signal.
      if (!/(中标|订单|合同|供货|客户定点|量产|投产|获批|入选|布局|研发|签约|建设|采购|供应链|主营|业务|产品|收入|产能|技术突破|战略合作|正式上线|实现应用|交付)/.test(title)) return [];
      return matchKeywords(title, theme.keywords).map(keyword => ({keyword, title, url:item.url??item.link??null,
        source:item.source??item.media??null, publishedAt:item.publishedAt??item.publishTime??item.date??item.time??null}));
    });
    const policies = theme.policyIds.map(id => effectivePolicy(id, cutoff)).filter(Boolean);
    if (!policies.length) continue;
    const preferredPolicy = theme.preferredPolicyId
      ? effectivePolicy(theme.preferredPolicyId, cutoff) : null;
    const policy = preferredPolicy ?? policies.sort((a,b) => b.priority-a.priority)[0];
    const evidenceType = themeMatches.length ? 'sector-theme-match' : industryMatches.length ? 'industry-match' : newsMatches.length ? 'timestamped-company-news-theme-match' : null;
    if (!evidenceType) continue;
    const relevance = themeMatches.length ? 1 : industryMatches.length ? 0.82 : 0.76;
    const directNewsBonus = newsMatches.length ? Math.min(4, newsMatches.length * 1.5) : 0;
    const score = clamp(theme.priority * policyAgeFactor(policy.publishedAt, cutoff) * relevance + directNewsBonus, 0, 100);
    scoredThemes.push({
      themeId:theme.id, label:theme.label, score:Number(score.toFixed(1)), priority:theme.priority,
      evidenceType, matchedKeywords:[...new Set([...industryMatches,...themeMatches.map(x=>x.keyword),...newsMatches.map(x=>x.keyword)])].slice(0,12),
      matchedIndustry:industryMatches.length>0, matchedTheme:themeMatches.length>0, matchedDatedNews:newsMatches.length>0,
      policy:{id:policy.id,title:policy.title,publishedAt:policy.publishedAt,source:policy.source,url:policy.url},
      datedNewsEvidence:newsMatches.slice(0,3)
    });
  }
  scoredThemes.sort((a,b)=>b.score-a.score);
  const strongest = scoredThemes.slice(0,3);
  const score = strongest.length ? clamp(0.72*strongest[0].score + 0.20*(strongest[1]?.score ?? strongest[0].score) + 0.08*(strongest[2]?.score ?? strongest[0].score)) : 50;
  return {
    score:Number(score.toFixed(1)),
    evidenceAvailable:scoredThemes.length>0,
    matchedThemeCount:scoredThemes.length,
    matchedThemes:strongest,
    catalogVersion:POLICY_CATALOG_VERSION,
    catalogReviewedAt:POLICY_CATALOG_REVIEWED_AT,
    catalogAgeDays:Number(catalogAgeDays.toFixed(1)),
    catalogStale,
    catalogNotYetAvailable:false,
    catalogAvailableAtCutoff:true,
    catalogWarning:catalogStale?'policy-catalog-review-older-than-14-days':'',
    asOf:String(asOf??''),
    interpretation:scoredThemes.length ? 'sectoral-policy-alignment-not-company-specific-subsidy' : 'no-verifiable-policy-theme-match'
  };
}

export function deriveMarketRegime({ indices=[], universeRows=[], capturedAt=null } = {}) {
  const indexRows = (Array.isArray(indices) ? indices : []).map(row => ({
    name:String(row?.name??row?.symbol??row?.code??''),
    pct:n(row?.pct??row?.changePct)
  })).filter(row => row.name && row.pct !== null);
  const broad = (Array.isArray(universeRows) ? universeRows : []).map(row => ({
    code:String(row?.f12??row?.code??''),
    name:String(row?.f14??row?.name??''),
    pct:n(row?.f3??row?.pct??row?.changePct),
    mainNet:n(row?.f62??row?.mainNet),
    amount:n(row?.f6??row?.amount)
  })).filter(row => row.pct !== null && !/(^|\*)ST|退市|退$/i.test(row.name));
  const pctValues = broad.map(row=>row.pct).sort((a,b)=>a-b);
  const medianPct = pctValues.length ? (pctValues.length%2 ? pctValues[(pctValues.length-1)/2] : (pctValues[pctValues.length/2-1]+pctValues[pctValues.length/2])/2) : null;
  const upRatio = broad.length ? broad.filter(row=>row.pct>0).length/broad.length : null;
  const downRatio = broad.length ? broad.filter(row=>row.pct<0).length/broad.length : null;
  const positiveFlowRatio = broad.filter(row=>row.mainNet!==null).length
    ? broad.filter(row=>row.mainNet!==null&&row.mainNet>0).length/broad.filter(row=>row.mainNet!==null).length : null;
  const sortedIndexPcts = [...indexRows.map(row=>row.pct)].sort((a,b)=>a-b);
  const indexMedianPct = !sortedIndexPcts.length ? null
    : sortedIndexPcts.length % 2
      ? sortedIndexPcts[(sortedIndexPcts.length-1)/2]
      : (sortedIndexPcts[sortedIndexPcts.length/2-1] + sortedIndexPcts[sortedIndexPcts.length/2]) / 2;
  const referencePct = indexMedianPct ?? medianPct;
  let regime='neutral', label='震荡/分化', riskAppetite='balanced';
  if ((upRatio!==null&&upRatio>=0.58&&referencePct!==null&&referencePct>=0.25) ||
      (upRatio!==null&&upRatio>=0.64&&referencePct!==null&&referencePct>-0.1)) {
    regime='risk-on';label='风险偏好回升';riskAppetite='growth-and-momentum';
  } else if (referencePct!==null&&referencePct<=-0.65&&upRatio!==null&&upRatio>=0.55) {
    // A weak index alongside positive stock breadth is divergence/rotation, not automatically a broad risk-off market.
    regime='neutral';label='指数走弱、个股分化';riskAppetite='rotation-and-dispersion';
  } else if ((upRatio!==null&&upRatio<0.42) ||
      (referencePct!==null&&referencePct<=-0.65&&(upRatio===null||upRatio<0.50)) ||
      (referencePct!==null&&referencePct<=-1.5&&(upRatio===null||upRatio<0.64)) ||
      (upRatio!==null&&upRatio<0.48&&referencePct!==null&&referencePct<-0.25)) {
    regime='risk-off';label='防守/风险偏好下降';riskAppetite='capital-quality-and-liquidity';
  }
  return {
    regime,label,riskAppetite,capturedAt,
    dataQuality:indexRows.length>=2&&broad.length>=1000?'multi-index-and-broad-quote-proxy':indexRows.length>=2?'multi-index-and-ranked-candidate-sample':'ranked-universe-proxy',
    indexCount:indexRows.length,indexMedianPct:indexMedianPct===null?null:Number(indexMedianPct.toFixed(3)),
    quoteSampleCount:broad.length,medianPct:medianPct===null?null:Number(medianPct.toFixed(3)),
    upRatio:upRatio===null?null:Number(upRatio.toFixed(4)),
    downRatio:downRatio===null?null:Number(downRatio.toFixed(4)),
    positiveFlowRatio:positiveFlowRatio===null?null:Number(positiveFlowRatio.toFixed(4)),
    note:indexRows.length>=2?'Regime is inferred from available index changes and quote breadth; it is a market-state classifier, not a return forecast.':'Index coverage is insufficient; regime is a candidate-universe proxy.'
  };
}

export function regimeAwareScore({ coreScore, policyScore=50, policyEvidence=false, policyCatalogStale=false, marketRegime='neutral', trend=50, volumePrice=50, flow=50, sector=50, momentum=50, base=50 } = {}) {
  const regime = typeof marketRegime === 'string' ? marketRegime : marketRegime?.regime ?? 'neutral';
  const core = clamp(n(coreScore) ?? 50);
  const flowScore = clamp(n(flow) ?? 50);
  const trendScore = clamp(n(trend) ?? 50);
  const volumeScore = clamp(n(volumePrice) ?? 50);
  const sectorValue = clamp(n(sector) ?? 50);
  const momentumScore = clamp(n(momentum) ?? 50);
  const baseScore = clamp(n(base) ?? 50);
  let marketWeight=0.10, policyWeight=0.10;
  if(regime==='risk-on'){marketWeight=0.10;policyWeight=0.14;}
  else if(regime==='risk-off'){marketWeight=0.14;policyWeight=0.06;}
  let marketFit;
  if(regime==='risk-on') marketFit=0.30*trendScore+0.24*volumeScore+0.20*flowScore+0.18*sectorValue+0.08*momentumScore;
  else if(regime==='risk-off') marketFit=0.38*flowScore+0.24*baseScore+0.18*volumeScore+0.12*sectorValue+0.08*trendScore;
  else marketFit=0.24*trendScore+0.22*volumeScore+0.22*flowScore+0.18*sectorValue+0.09*momentumScore+0.05*baseScore;
  let effectivePolicy=clamp(n(policyScore) ?? 50);
  // Policy narrative alone cannot compensate for weak price/flow confirmation.
  if(flowScore<40 || trendScore<35) effectivePolicy=Math.min(effectivePolicy,55);
  const freshnessMultiplier=policyCatalogStale?0.25:1;
  const effectivePolicyWeight=policyEvidence?policyWeight*freshnessMultiplier:policyWeight*0.25;
  const adjusted=core*(1-marketWeight-effectivePolicyWeight)+marketFit*marketWeight+effectivePolicy*effectivePolicyWeight;
  return {
    score:Number(clamp(adjusted).toFixed(2)),
    coreScore:Number(core.toFixed(2)),
    marketFitScore:Number(clamp(marketFit).toFixed(2)),
    policyScore:Number(clamp(n(policyScore) ?? 50).toFixed(2)),
    effectivePolicyScore:Number(effectivePolicy.toFixed(2)),
    marketWeight:Number(marketWeight.toFixed(3)),
    policyWeight:Number(effectivePolicyWeight.toFixed(3)),
    policyCatalogStale,
    regime
  };
}
