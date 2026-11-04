# 冰山冷热 000530 漏选诊断（2026-10-28）

## 旧生产路径

当前 main 的 index.html 中：

- hardFilter() 过滤日涨幅小于 -4%；
- hardFilter() 过滤换手率大于 25%；
- breakoutStage1Score() 只接受涨幅 4%～10.1%、换手率 4%～25%、mainNet>0、mainPct>2%；
- runScan() 先 hardFilter，再只给主模型 Top30 和影子 Top5 深扫。

因此，大跌且高换手的股票可能在深度行情、资金流、题材和风险分析之前被移除。该结论来自 main 的实际代码审计，没有修改 main。

## V14.1 研究修复

研究分支新增 extremeDisagreementReversal 通道：

- 允许大跌、高换手或异常放量股票进入研究观察池；
- 大跌与高换手只作为结构和风险特征；
- 缺少资金、板块或企稳证据时状态为 EXTREME_DISAGREEMENT_UNCONFIRMED；
- 只有前期强势、回撤后出现多项企稳和承接证据时才标记 REVERSAL_CONFIRMED；
- reversalConfirmed 不会自动产生 entryEligible；
- 合并候选时按代码去重并保留通道来源。

## 点时结论

仓库没有 2026-10-28 的 000530 完整点时快照，也没有该日全市场证券状态、资金流、题材和分钟数据归档。2026-10-29 的涨幅只能作为事后标签，不能回填到 10-28 特征。

因此：

- 10-28 是否进入全市场池：NOT_MEASURABLE
- 是否进入反转漏斗：NOT_MEASURABLE
- 是否完成深度资金/题材扫描：NOT_MEASURABLE
- 是否有提前涨停预警：NOT_MEASURABLE
- 不能声称修复后已经提前发现冰山冷热。

合成回归测试只验证通道逻辑，不代表真实历史回放成功。
