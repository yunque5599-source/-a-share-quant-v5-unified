# V16 Early Trend Detection：研究协议与输入契约

V16 是独立、默认且强制 SHADOW 的日线趋势研究模块。生产 V10.2.4-S 和 V15 文件保持原样；分数不是上涨概率，WATCH/TRIGGERED 不是买入信号。CONFIRMED 仅允许独立买入计划评估，不产生订单、价格区间或生产仓位。

## 架构

`v16_config.js → v16_early_trend.js → v16_dashboard.js / v16_replay.js`。
纯函数 scanV16(snapshot, previousPoolState, overrides) 不读网络、时钟或随机数。
市场门控、风险硬否决、扣分、观察警告分别输出。全市场来源不使用候选证券统计。
相同快照、模型、配置、初始池状态可重现；重复同一快照复用池状态缓存，不重复推进状态。历史池状态是输入，metadata.priorPoolFingerprint 记录这一依赖，回放必须从同一初始状态顺序执行。

## 初始参数与算法

所有研究阈值和权重位于 v16_config.js，配置覆盖会生成新 configFingerprint。
权重：趋势启动22、相对强度18、量价15、资金15、行业15、催化8、流动性7，总和100。
综合分 = 加权分 - 独立风险扣分；硬否决无论多少分均阻止入池。系统性风险额外降低高位突破贡献，并将计划仓位上限置零、全局 WAIT。

日线 MA5/10/20 拐头、排列、MA10/20收复、前20/60日高点突破、20日整理宽度、ATR收缩扩张、压力位保持、MA20/60偏离和5/10日收益决定 A蓄势/B启动/C确认/D加速/E过热。压力位不包含当前日。
优先 B/C，A观察；D/E不能进入 TOP 池。首次突破和温和量能需共同满足，不把涨幅单调映射为高分。
3/5日资金必须覆盖最后五个完整交易日，并标注 estimated 布尔值。资金不等于机构持仓，单日大流入不可替代持续性。
行业必须有独立行业范围来源、足够样本/覆盖率和完整指标；不足不确认，绝不补100分。各指标绝对强度连续加权，满分上界99。
事件正分只接收已核验业务关联、实际发布时间、证据URL和业务解释的结构化事件。无法确认/混合只警告；不使用关键词猜测公司受益。当前不提供自动业务语义核验器，需要采集/复核层提供证据。

## 时间与输入

所有时间必须为带 Z 或偏移的 ISO 字符串；交易日期 YYYY-MM-DD，时区 Asia/Shanghai。
顶层必填：
- id、universeId、asOf（扫描评估时点）、capturedAt（采集时点）、expectedDailyDate（最近完整交易日）。
- calendar：source、availableAt、verified=true、coverageThrough（覆盖到扫描日期）、tradingDates。最近完成交易日由日历和15:00收盘推导，不能通过填写陈旧 expectedDailyDate 绕过过期检查。
- securities：每只 code/name/industry/bars/moneyFlow/metadata/news/fundamentals/evidenceCoverage。
- market、industries：独立来源，不可从候选池冒充。

bars 至少65根，必须包含 date、availableAt、source、open/high/low/close/volume/amount，turnover单位为百分比。只接受 asOf 前已公开且对应交易日已收盘的日线。同日盘中完整日线即使错误声称提前 availableAt 也会排除。不支持合成分钟线或盘口。
moneyFlow 最后5交易日每条 date/availableAt/source/netMain/amount/estimated，币种与成交额统一人民币元。全部缺失不得变成0流入或中性利好。
metadata 包含 source/availableAt/exchange/board/tradingDate（扫描当日）/isST/delistingRisk/tradingStatus=TRADING/ruleSource/ruleEffectiveAt，以及当日交易所有效 limitUpPrice/limitDownPrice 或已核验 noPriceLimit=true。不依代码前缀计算涨跌幅。新股、ST、改革生效日期等由基础信息供应商按日给出规则及价格。
fundamentals：source/availableAt/reportPeriod、netProfitGrowth（小数）、operatingCashFlow、previousOperatingCashFlow、pe、industryMedianPE，可选 pledgeRatio/auditGoingConcern/fraudVerified。财报发布时间必须早于扫描时点；负现金流恶化和盈利下降是扣分，高估值单独不硬否决。审计持续经营/核验造假硬否决。
evidenceCoverage：source/availableAt/newsComplete/fundamentalsComplete。不能凭存在一条新闻就声称新闻覆盖完整。

market：source/availableAt/verified=true/scope=full-market、up/down/flat、limitUp/limitDown、amount；indices包含 SSE/SZSE/CHINEXT/STAR50，各自 source/availableAt/return1（小数）。四指数、广度与扫描时点误差不能超过配置15分钟。
benchmarkReturns：source/availableAt/throughDate=expectedDailyDate/return5/return10，为与证券日线对齐的市场收益。
externalEvents：source/availableAt/verified/systemicRisk，用于可验证宏观/海外冲击门控。
overseas、macro、keyIndustries 为带 source/availableAt 的外部证据对象，缺失明确列于 market.missing；当前不包含这些源的自动获取器，未提供证据不得宣称已覆盖。
industries 每个对象：industry/source/availableAt/verified=true/scope=industry/throughDate=expectedDailyDate/sampleCount/eligibleCount，
return3/return5/return10/benchmarkReturn5/upShare/amountGrowth/positiveFlowShare/breakout20Share/leaderPersistence/medianReturn/advanceDeclineRatio。
收益及比例使用小数，上涨下跌比为比值。样本至少15、覆盖率至少80%。供应商需保存点时成分列表及聚合明细，以复核样本分母；引擎无法独立验证供应商的 verified 声明。

news 每项 publishedAt/source/url/category/impact。正分另需 businessVerified=true、businessRationale、evidenceUrl。
category：earnings_up/earnings_down/earnings_reversal/contract/product_price/industry_policy/supply_demand/company_event/shareholder_sale/pledge/regulatory_penalty/litigation/operating_risk/abnormal_volatility/major_risk/delisting。
impact：positive/negative/mixed/unknown。exchangeVerified=true 的异常波动、重大风险、退市公告直接硬否决。采集层须按点时维护有效风险事件；历史已解除公告不应作为仍然生效风险送入。

## 状态与稳定池

WATCH（蓄势观察）→ TRIGGERED（B/C日线信号）→ CONFIRMED（C、资金、行业、公告财务覆盖、市场及分数门槛全部通过）。
突破失败、重大风险、核心数据质量失败为 INVALIDATED；已有启动/确认证券资金3/5日反转也失效。
风险失效立即移出；D/E移出；缺失证券数据立即移出。旧池在排序时享有配置3分保留边际，突破强信号仍可取代旧候选。同分按代码稳定排序。
TOP10/30/50 是嵌套研究列表，少于K不补虚假证券；记录首次入池/启动/确认/失效、分数变动、状态变动和排名原因。
全局 WAIT 是市场/数据决策，与逐股四状态分开。任何结果均 execution=SHADOW_NO_ORDERS。
浏览器池只保存在设备本地，并可导出；不是跨设备、服务器持久化能力。

## 回放和验证纪律

V15原始协议、JSON格式和脚本保持原样。V16扩展格式不反向污染旧快照。
原始 V15 截面本身没有65日日线、历史资金、独立行业广度、全市场指数、交易所规则和公告点时证据，不能硬转成完整 V16 信号。
V10对照必须使用当时保存的正式终排，不把 stage-one primaryTop 伪装成 V10 正式模型；TOP10/30/50未保存或未选满必须披露。
同日同扫描时点、相同点时股票池、价格口径和成本，比较完整 TOP10/30/50，不仅事后赢股；证券入池后的日线仅用于 outcome，禁止进入 scanV16。
T+1/3/5/10采用后续交易日可交易开盘入场的预注册研究定义，费率/滑点对所有模型一致。执行约束、停牌、涨停无法成交、公司行动等缺失时交易收益不可测，报价收益不可包装成实盘回测。
每个收益指标应报告样本数/数据覆盖，不能把缺失视为0，不能用不全涨停标签声称全市场召回率。
采用时间顺序滚动样本外窗口，训练区间与测试区间至少清除10交易日结果重叠；同一测试集只评估一次，不得将未来收益用于调参。
预注册配置是当前固定初值，不是优化后的参数。回放不自动寻找使三个案例表现最好的阈值。
2026-11-24四川长虹600839、江化微603078、华友钴业603799：无对应真实点时数据时分别 NOT_MEASURABLE。不可把今天查到的公告/财务值回填至过去。

## 升级门槛

当前允许软件工程层面的离线审查和受控 SHADOW 数据采集；不满足基于收益的灰度升级或替换生产资格。
进入下一阶段须补齐真实点时历史、独立行业成分与广度、跨板块交易规则、公告/资金/财务发布档案、可成交数据与公司行动，完成相同预算的滚动样本外比较，确认风险调整收益、追高率和回撤改善后再独立审批。
