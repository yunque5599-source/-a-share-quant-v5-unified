# A股量化 V10.3.8：历史证据审计与前向归档交付
日期：2026-09-26。性质：研发交付，未部署到新仓库；不构成交易信号。

## 已有历史证据能回答什么

- 已有四只**事后选定**股票的价格代理连续账户模拟；覆盖截至9月22日的20/60/120/177交易日。这不是完整原V10历史收益。例：8万元、持有3个交易日、单边5bps滑点，20日末值83402.67元，60日84766.25元，177日83292.67元。样本选择和B/Y设计包含事后偏差，不可声称“当时按照原模型买卖就赚这么多”。
- 已有LIVE-001彩虹股份的持股和历史浮盈亏截图，不能替代整个账户的已实现收益或成交流水。
- 缺失当时逐日六路真实全市场榜单、Top30资金、新闻发布时间、浏览器原始BUY/WAIT、成交价格与委托排队记录。历史原V10累计收益标记为 UNKNOWN，不得填0或代理收益。

## 2026-09-26 周末接口勘查

- 正式生产网页仍为V10.2.4-S，`/api/market?action=ranked_candidates`得到200；回包示例为`universeTotal=5920`、`candidateCount=392`、`listsOk/listsTotal=6/6`、`failures=[]`、`serverStale=false`。
- 服务端generatedAt在周末也可更新，并非逐股行情报价时间；候选记录未提供可验证的逐股报价时间。因此**不能**把回包200、`serverStale=false`或generatedAt较新认定为实时合格选股信号。

## 本次交付的文件

- `research/forward_capture.py`：只读抓取排名候选，保留原始字节和SHA256、源码commit、捕获时间及各项质量旗标；任何情形不推导BUY、WAIT或成交。
- `.github/workflows/forward-evidence.yml`：仅手动运行，自动上传本次raw及manifest为Actions artifact，失败时也保存。
- `tests/test_forward_capture.py`：有效原始回包、缺页、条数不符、周末及重复代码的离线测试。

## 操作注意

1. 先在**新账号**`yunque5599-source/-a-share-quant-v5-unified`的独立分支或作为新增文件导入，勿触碰`index.html`、`api/market.js`、`api/discovery_universe.js`、生产Vercel项目或当前交易建议。
2. `forward-evidence`只是原始候选来源档案，不含原模型BUY/WAIT。正式做收益回放必须额外获取网页在当时时刻的决策输出及实际券商成交/可卖持仓；不允许拿这份ranked candidates事后重选涨停股。
3. 先手动运行一次，确认artifact里包含`rank_raw_response.bin`和`manifest.json`。盘外/假期仅做链路诊断，标记不合格。
4. 首次交易时段验证后再考虑增加定时触发；实际执行时间要记录，不能把cron时刻当采样时间。GitHub artifact留存期有限（工作流当前设30天），需另存长期备份并核验SHA256。
5. 待真实历史输入与信号完整后，再冻结账户执行规则：整手、T+1、当日可卖数量、现金余额、仓位上限、止损/退出、成交可能性、滑点、税费，并使用同源同窗简单动量基准对照。