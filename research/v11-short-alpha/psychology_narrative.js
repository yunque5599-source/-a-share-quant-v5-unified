import { asOfDate, clamp, finiteNumber, round, validDate } from './schema.js';

export const PSYCHOLOGY_NARRATIVE_VERSION = 'V12 Psychology Narrative Auto Phase 3';

const n = finiteNumber;
const list = value => Array.isArray(value) ? value : [];

const CATALYST_TERMS = [
  '政策','规划','意见','方案','行动','发布','获批','批准','订单','签约',
  '量产','投产','中标','涨价','出口','扩产','并购','重组','突破','发布会',
  '产业化','商业化','落地','催化','重大进展'
];

const POSITIVE_TERMS = [
  '增长','突破','加速','创新高','超预期','放量','景气','订单','量产',
  '落地','商业化','国产替代','政策支持','需求旺盛','扩产','提价'
];

const NEGATIVE_TERMS = [
  '下滑','下降','不及预期','亏损','减产','风险','监管','处罚','诉讼',
  '终止','延期','暂停','下调','承压','需求疲软','竞争加剧','过剩'
];

const SCALE_TERMS = [
  '市场规模','市场空间','万亿','千亿','百亿','十亿','亿美元','万亿美元',
  '天花板','TAM','SAM','SOM','需求空间','蓝海'
];

const PENETRATION_TERMS = [
  '渗透率','普及率','覆盖率','替代率','渗透','普及','低渗透','早期',
  '导入期','尚未普及','仍处于早期','空间广阔'
];

const POLICY_TERMS = [
  '国务院','国家发改委','发改委','工信部','国家数据局','财政部','科技部',
  '商务部','证监会','央行','政策','规划','实施意见','行动方案','专项行动',
  '试点','示范','专项规划'
];

const OPTIONALITY_TERMS = [
  '多场景','跨行业','平台','生态','智能体','终端','软件','硬件','应用',
  '商业化','量产','出口','国产替代','工业','医疗','汽车','消费','能源',
  '通信','机器人','无人机','航空航天','数据','云','算力'
];

const HIGH_CREDIBILITY = [
  '新华社','人民日报','央视','中央电视台','中国政府网','国务院','发改委',
  '工信部','国家数据局','科技部','财政部','商务部','证监会','证券时报',
  '中国证券报','上海证券报','证券日报'
];

const FINANCIAL_MEDIA = [
  '财联社','东方财富','新浪财经','21世纪经济报道','第一财经','证券之星',
  '同花顺','华尔街见闻','界面新闻'
];

function clean(value) {
  return String(value ?? '').replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function parseSourceDate(raw) {
  if (raw instanceof Date) return Number.isFinite(raw.getTime()) ? raw : null;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const value = raw.trim();
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  const iso = value.includes('T') ? value : value.replace(' ', 'T');
  const normalized = hasZone ? iso : iso + '+08:00';
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function asOfInstant(asOf) {
  if (typeof asOf !== 'string' || !asOf.trim()) return null;
  const value = asOf.trim();
  if (validDate(value)) {
    const timestamp = Date.parse(value + 'T23:59:59.999+08:00');
    return Number.isFinite(timestamp) ? new Date(timestamp) : null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function dateOnly(date) {
  return date?.toISOString?.().slice(0, 10) ?? null;
}

function inAsOf(date, asOf) {
  if (!date) return false;
  const cutoff = asOfInstant(asOf);
  return !cutoff || date.getTime() <= cutoff.getTime();
}

function daysAgo(date, asOf) {
  const cutoff = asOfInstant(asOf);
  if (!date || !cutoff) return null;
  return (cutoff.getTime() - date.getTime()) / 86400000;
}

function normalizeNews(raw, asOf) {
  const source = list(raw).map(item => {
    const date = parseSourceDate(item?.date ?? item?.published ?? item?.time ?? item?.datetime);
    return {
      title:clean(item?.title),
      content:clean(item?.content ?? item?.snippet ?? item?.description),
      source:clean(item?.mediaName ?? item?.source ?? item?.medianname),
      url:String(item?.url ?? item?.link ?? '').trim(),
      date:date?.toISOString() ?? null
    };
  }).filter(item => item.title && item.date && inAsOf(new Date(item.date), asOf));

  const seen = new Set();
  return source.filter(item => {
    const key = item.title + '|' + item.source + '|' + item.date.slice(0, 10);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => b.date.localeCompare(a.date));
}

function textOf(item) {
  return (item.title + ' ' + item.content).trim();
}

function countTerms(text, terms) {
  const value = String(text ?? '').toLowerCase();
  return terms.reduce((count, term) => count + (value.includes(term.toLowerCase()) ? 1 : 0), 0);
}

function sourceScore(source) {
  const value = String(source ?? '');
  if (!value) return 50;
  if (HIGH_CREDIBILITY.some(term => value.includes(term))) return 95;
  if (FINANCIAL_MEDIA.some(term => value.includes(term))) return 82;
  return 65;
}

function scaleScore(text) {
  const value = String(text ?? '');
  if (/\d+(?:\.\d+)?\s*(?:万亿美元|万亿)/.test(value)) return 98;
  if (/\d+(?:\.\d+)?\s*(?:亿美元|千亿)/.test(value)) return 90;
  if (/\d+(?:\.\d+)?\s*(?:百亿|十亿)/.test(value)) return 82;
  if (/\d+(?:\.\d+)?\s*亿/.test(value)) return 74;
  return countTerms(value, SCALE_TERMS) > 0 ? 66 : null;
}

function penetrationScore(text) {
  const value = String(text ?? '');
  const hits = countTerms(value, PENETRATION_TERMS);
  if (!hits) return null;
  const low = /(低|不足|仍处|早期|尚未|提升空间|广阔|未普及)/.test(value);
  return clamp(58 + hits * 8 + (low ? 16 : 0));
}

function policyScore(text, credibleSources) {
  const hits = countTerms(text, POLICY_TERMS);
  if (!hits) return null;
  return clamp(52 + Math.min(35, hits * 9) + Math.min(13, credibleSources * 3));
}

function optionalityScore(text) {
  const value = String(text ?? '');
  const unique = OPTIONALITY_TERMS.filter(term => value.includes(term)).length;
  if (!unique) return null;
  return clamp(45 + Math.min(50, unique * 7));
}

function companyCaptureScore(theme, members, text) {
  const candidateName = clean(theme?.candidateName);
  const leaderName = clean(theme?.leaderName);
  const candidateCode = clean(theme?.candidateCode);
  const leaderCode = clean(theme?.leaderCode);
  const candidateHit = candidateName && text.includes(candidateName);
  const leaderHit = leaderName && text.includes(leaderName);
  const memberLeader = list(members).find(row =>
    String(row?.code ?? '') === leaderCode
  );
  if (!candidateName && !leaderName && !candidateCode && !leaderCode) return null;
  let score = 52;
  if (candidateHit) score += 18;
  if (leaderHit) score += 14;
  if (memberLeader && leaderCode === candidateCode) score += 10;
  if (n(theme?.candidatePremiumPct) !== null) {
    score += clamp(10 + n(theme.candidatePremiumPct) * 2, 0, 12);
  }
  return clamp(score);
}

function topEvidence(items) {
  return items.slice(0, 8).map(item => ({
    title:item.title, source:item.source, date:item.date, url:item.url || null
  }));
}

function buildNarrative(items, theme) {
  if (items.length < 3) {
    return {
      complete:false, score:null, confidence:items.length / 3,
      components:{}, evidence:topEvidence(items),
      diagnostics:{articleCount7d:items.length},
      reason:'insufficient-news-sample'
    };
  }

  const allText = items.map(textOf).join(' ');
  const recent3 = items.filter(item => (daysAgo(new Date(item.date), theme.asOf) ?? 99) <= 3);
  const recent7 = items.filter(item => (daysAgo(new Date(item.date), theme.asOf) ?? 99) <= 7);
  const sources = new Set(items.map(item => item.source).filter(Boolean));
  const days = new Set(items.map(item => item.date.slice(0, 10)));
  const catalystHits = items.reduce((sum, item) => sum + countTerms(textOf(item), CATALYST_TERMS), 0);
  const positiveHits = items.reduce((sum, item) => sum + countTerms(textOf(item), POSITIVE_TERMS), 0);
  const negativeHits = items.reduce((sum, item) => sum + countTerms(textOf(item), NEGATIVE_TERMS), 0);
  const credibleSources = [...sources].filter(source => sourceScore(source) >= 90).length;
  const uniqueTitleRatio = new Set(items.map(item => item.title)).size / items.length;
  const recentRatio = recent3.length / Math.max(1, recent7.length);
  const catalystDensity = catalystHits / Math.max(1, items.length);
  const sentimentBalance = (positiveHits - negativeHits) /
    Math.max(1, positiveHits + negativeHits);

  const candidatePremium = n(theme?.candidatePremiumPct);
  const leaderDelta = n(theme?.leaderChangePct) !== null && n(theme?.changePct) !== null
    ? n(theme.leaderChangePct) - n(theme.changePct) : null;

  const components = {
    novelty:clamp(40 + recentRatio * 35 + uniqueTitleRatio * 15 +
      Math.min(10, catalystDensity * 4)),
    credibility:clamp(
      items.reduce((sum, item) => sum + sourceScore(item.source), 0) /
      Math.max(1, items.length) * 0.85 + Math.min(15, credibleSources * 5)
    ),
    propagation:clamp(
      30 + Math.min(35, Math.log1p(items.length) * 16) +
      Math.min(25, sources.size * 6) + Math.min(10, recent3.length * 2)
    ),
    persistence:clamp(
      days.size / 7 * 70 + Math.min(30, items.length * 3)
    ),
    expectationGap:candidatePremium !== null
      ? clamp(50 + candidatePremium * 5)
      : leaderDelta !== null ? clamp(50 + leaderDelta * 4) : null,
    // News tone is itself a crowd-psychology input: positive/negative
    // propagation should affect narrative quality, not remain diagnostics-only.
    sentiment:clamp(50 + sentimentBalance * 50)
  };

  if (components.expectationGap === null) {
    return {
      complete:false, score:null, confidence:0.55,
      components, evidence:topEvidence(items),
      diagnostics:{articleCount7d:items.length, sourceCount:sources.size,
        distinctDays:days.size, catalystHits, sentimentBalance},
      reason:'expectation-gap-evidence-missing'
    };
  }

  const score = Object.values(components).every(value => value !== null)
    ? Object.values(components).reduce((sum, value) => sum + value, 0) / 6 : null;
  const complete = score !== null && sources.size >= 2 && days.size >= 2 &&
    catalystHits >= 2;

  return {
    complete, score:complete ? round(score) : null,
    confidence:complete ? 1 : 0.68,
    components:Object.fromEntries(Object.entries(components).map(([key, value]) =>
      [key, {score:value, weight:{novelty:0.21,credibility:0.21,
        propagation:0.17,persistence:0.13,expectationGap:0.18,sentiment:0.10}[key]}])),
    evidence:topEvidence(items),
    diagnostics:{
      articleCount7d:items.length, recent3Count:recent3.length,
      sourceCount:sources.size, credibleSourceCount:credibleSources,
      distinctDays:days.size, catalystHits, positiveHits, negativeHits,
      sentimentBalance
    },
    reason:complete ? 'automatic-news-evidence-complete' : 'automatic-news-evidence-partial'
  };
}

function buildImagination(items, theme, members) {
  if (items.length < 3) {
    return {
      complete:false, score:null, confidence:items.length / 3,
      components:{}, evidence:topEvidence(items),
      diagnostics:{articleCount7d:items.length},
      reason:'insufficient-news-sample'
    };
  }

  const text = items.map(textOf).join(' ');
  const sources = new Set(items.map(item => item.source).filter(Boolean));
  const evidence = topEvidence(items);
  const scale = scaleScore(text);
  const penetration = penetrationScore(text);
  const policy = policyScore(text, [...sources].filter(source => sourceScore(source) >= 90).length);
  const optionality = optionalityScore(text);
  const capture = companyCaptureScore(theme, members, text);

  const values = {marketSize:scale, penetrationGap:penetration,
    policyRunway:policy, technologyOptionality:optionality, companyCapture:capture};
  const weights = {marketSize:0.25,penetrationGap:0.20,
    policyRunway:0.20,technologyOptionality:0.20,companyCapture:0.15};
  const available = Object.entries(values).filter(([, value]) => value !== null);
  const missing = Object.entries(values).filter(([, value]) => value === null).map(([key]) => key);

  // Imagination is inherently harder to observe than price/flow. Do not require a
  // single article to contain all five dimensions. Compute a renormalized partial
  // score when at least two dimensions have dated evidence, while lowering confidence
  // as evidence coverage falls. This prevents "unknown" from becoming a fake zero,
  // but also prevents thin imagination evidence from silently receiving full confidence.
  const weightSum = available.reduce((sum, [key]) => sum + weights[key], 0);
  const score = weightSum > 0
    ? available.reduce((sum, [key, value]) => sum + value * weights[key], 0) / weightSum
    : null;
  const evidenceFactor = evidence.length >= 4 ? 1 : evidence.length >= 2 ? 0.90 : 0.65;
  const coverage = available.length / Object.keys(values).length;
  const confidence = score === null ? 0 : Math.min(0.90, 0.45 + coverage * 0.45) * evidenceFactor;
  const complete = available.length === Object.keys(values).length &&
    sources.size >= 2 && evidence.length >= 2;

  if (score === null || available.length < 2 || evidence.length < 2) {
    return {
      complete:false, score:null, confidence,
      components:Object.fromEntries(Object.entries(values).map(([key, value]) => [key, {
        score:value, weight:weights[key]
      }])),
      evidence, diagnostics:{
        articleCount7d:items.length, sourceCount:sources.size, availableCount:available.length,
        missing
      },
      reason:'automatic-imagination-evidence-incomplete'
    };
  }

  return {
    complete, score:round(score), confidence,
    components:Object.fromEntries(Object.entries(values).map(([key, value]) => [key, {
      score:value, weight:weights[key]
    }])),
    evidence,
    diagnostics:{
      articleCount7d:items.length, sourceCount:sources.size, availableCount:available.length,
      missing
    },
    reason:complete ? 'automatic-imagination-news-proxy-complete' :
      'automatic-imagination-news-proxy-partial'
  };
}

export function buildAutomaticPsychologyResearch(theme = {}, news = [], members = []) {
  const items = normalizeNews(news, theme?.asOf);
  // Short-term psychology must not be contaminated by stale search results.
  // Narrative/crowd-emotion evidence is a 7-day window; imagination can use a
  // wider 30-day window because policy runway and market-space evidence persists longer.
  const recent7 = items.filter(item => (daysAgo(new Date(item.date), theme?.asOf) ?? Infinity) <= 7);
  const recent30 = items.filter(item => (daysAgo(new Date(item.date), theme?.asOf) ?? Infinity) <= 30);
  const narrative = buildNarrative(recent7, theme);
  const imagination = buildImagination(recent30, theme, members);
  return {
    version:PSYCHOLOGY_NARRATIVE_VERSION,
    asOf:asOfDate(theme?.asOf) ?? null,
    narrativeResearch:{
      complete:narrative.complete,
      novelty:narrative.components?.novelty?.score ?? null,
      credibility:narrative.components?.credibility?.score ?? null,
      propagation:narrative.components?.propagation?.score ?? null,
      persistence:narrative.components?.persistence?.score ?? null,
      expectationGap:narrative.components?.expectationGap?.score ?? null,
      evidence:narrative.evidence
    },
    imaginationResearch:{
      complete:imagination.complete,
      score:imagination.score ?? null,
      confidence:imagination.confidence ?? 0,
      marketSize:imagination.components?.marketSize?.score ?? null,
      penetrationGap:imagination.components?.penetrationGap?.score ?? null,
      policyRunway:imagination.components?.policyRunway?.score ?? null,
      technologyOptionality:imagination.components?.technologyOptionality?.score ?? null,
      companyCapture:imagination.components?.companyCapture?.score ?? null,
      evidence:imagination.evidence
    },
    researchQuality:{
      narrative:{complete:narrative.complete,confidence:narrative.confidence,
        reason:narrative.reason,diagnostics:narrative.diagnostics},
      imagination:{complete:imagination.complete,confidence:imagination.confidence,
        reason:imagination.reason,diagnostics:imagination.diagnostics}
    },
    news:items.slice(0, 20),
    researchWindows:{
      narrative7d:recent7.length,
      imagination30d:recent30.length,
      excludedNarrativeBeyond7d:Math.max(0, items.length - recent7.length),
      excludedImaginationBeyond30d:Math.max(0, items.length - recent30.length)
    }
  };
}

export const _internal = {
  parseSourceDate, asOfInstant, normalizeNews, countTerms, sourceScore,
  scaleScore, penetrationScore, policyScore, optionalityScore,
  buildNarrative, buildImagination
};
