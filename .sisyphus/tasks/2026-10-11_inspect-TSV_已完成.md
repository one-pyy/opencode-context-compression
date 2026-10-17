# inspect 顺序清单与 TSV 展示

## 进度
- 清单生成与展示：已完成（四列 TSV、时间顺序及两种模式范围；两种模式均隐藏 protected，保留区间边界）
- 契约与说明：已完成（同步工具说明、输出契约及 Inspect 文档；端点保持原格式）
- 验证与审查：已完成（26 项相关测试、生产源码类型检查、修改模块诊断与差异检查通过；独立静态审查无实质问题。全项目类型检查及无关日志断言仍失败；未验证真实宿主与构建产物）

## 当前约定

列为类型、起点、终点、token数。行按消息先后排列。默认模式在请求上界内显示首个至最后一个可压缩条目之间的原文和摘要；delete 模式显示请求上界以内全部原文和摘要，包括边缘摘要。两种模式均隐藏 protected 行，但保护消息仍划分原文区间。摘要使用完整端点。mergeAdjacent=false 保留逐消息展示。没有可压缩条目时，默认模式返回空表。分组思路保存在正式契约的「分组设计备忘」，当前展示不计算或输出组号。

展示类型沿用 compressible、referable。端点保持原 inspect 格式：原文使用裸编号，摘要保留 referable 标记对，不额外添加前缀。

宿主记录的 JSON 占位与错误结果、历史重放、权限和提醒锚点保持不变。默认模式原文使用策略 token 数，摘要与 delete 条目使用现有可见文本计数；表格总计为各行之和，不与面板摘要计数混用。

## 修改与验证

1. 修改共享 TSV 展示 → verify: 默认边界、摘要完整端点、两种模式隐藏保护消息且不合并跨保护区间、delete 边缘摘要、四列与总计、空表和逐消息测试。
2. 更新 src/tools/compression-inspect/tool.ts 与 .sisyphus/docs/compaction/mark-tool-contract.md 的 Inspect 工具契约 → verify: 差异核对；保持旧 JSON 重放契约。
3. 更新受影响的提醒与投影测试 → verify: npm run typecheck 与相关 node --import tsx --test 测试；只读审查。

恢复点：refs/checkpoints/inspect-tsv/2026-10-11_10-11-16_recovery_41d814b9f038。只恢复本任务触及的路径，不覆盖此前提示词与分词服务修改。
