# 压缩工具公共契约（已实现）

## 文档定位

本文档描述 `compression_mark` 与 `compression_inspect` 的职责、输入输出与 replay 入口语义。

## 职责边界

`compression_mark` 只负责打 tag / mark：

- 不负责压缩执行
- 不负责调度
- 不负责 prompt projection

`compression_inspect` 只负责请求查看当前可见范围内尚未被压缩结果覆盖的 compressible 消息 token 情况：

- 不负责计算 token
- 不负责读取 sidecar
- 不负责压缩执行或调度

## 工具契约

- `mode` 是 `"compact" | "delete"`
- `from` 与 `to` 来自当前 projected visible view
- `from` 与 `to` 是双闭区间端点，端点消息自身也包含在目标范围内
- `from` 与 `to` 的公共输入形态是 `<visible-type>_<seq6>_<base62>`；replay 定位端点时使用稳定的 `seq6 + base62`，不把 `visible-type` 当作长期身份字段
- 成功调用时立即返回随机 `mark id`
- `mode=delete` 且当前策略不允许 delete 时，返回错误结果

## Inspect 工具契约

- `compression_inspect` 输入为 `{ to, mergeAdjacent? }`；`mergeAdjacent` 缺省为 `true`
- inspect 范围从当前投影中的首个 compressible 消息开始，到 `to` 端点结束，端点消息包含在范围内
- 工具调用当下只返回 `inspectId` 占位结果
- 后续 `messages.transform` 使用当前 `ProjectionState.messagePolicies` 中已经计算出的 `tokenCount` 生成真实结果
- `mergeAdjacent=true` 时，真实结果返回两级结构：referable replacement 切分外层 `sections`，protected 消息在 section 内切分连续 compressible `atoms`
- 每个 atom 返回起止 visible id、消息数与 token 数；每个 section 返回首尾 atom 的 visible id 与 atom token 总数；顶层同时返回所有 section 的 token 总数
- `mergeAdjacent=false` 时，真实结果保留按消息顺序排列的明细：`[{"id":"compressible_...","tokens":123}]`
- sections / atoms 只提供确定性的范围与计数结构，不判断内容是否已完成，也不构成自动 mark 建议；语义选择由调用模型完成

`compression_inspect` 的 token 数据来自消息级策略，不是 mark tree 本身：

1. `messagePolicies` 持有 canonical 消息的 `tokenCount`。
2. 最终 projected messages 提供当前可见的 protected / compressible / referable 顺序，已被 replacement 接管的 source 不再作为 compressible 返回。
3. `compression_inspect` 按输入 visible-id 范围读取当前可见结构，再按 `mergeAdjacent` 决定返回逐消息明细或 sections / atoms。
4. scheduler 则用同一批 message token，按 mark tree range 汇总为 `uncompressedMarkedTokenCount` 后再和自动压缩阈值比较。

因此 inspect 明细之和只有在 inspect 范围与当前待压 mark range 完全一致时，才应等于 scheduler 的 `uncompressedMarkedTokenCount`。

## 成功结果与错误结果的区别

- 成功结果：返回合法 `mark id`，表示创建了可重放的 mark intent
- 错误结果：本次调用没有成功创建 mark；它仍留在历史与最终可见世界里，但不进入 mark 覆盖树
- 确定性失败结果在最终投影中会被改写为 `{"ok":false,"errorCode":"...","message":"...","details":{...}}` 格式的结构化 tool result，保留原始错误码、具体失败原因与可定位的失败详情
- 已 accepted 但暂无 pending / result 的 mark 仍是正常悬挂状态，不属于失败结果

## Mark 与 replacement 的关系

mark 是 lookup hint，不是 source of truth：

1. 重放历史中的合法 mark tool 调用
2. 构造当前有效覆盖树
3. 对树上的当前节点按 mark id 去 SQLite 查询结果组
4. 只有存在完整结果组时才替换该范围

## 最小 lookup 结构

当前最小 replacement lookup 结构是：

- mark id
- 原始消息跨度
- 结果组是否完整

命中条件：

1. 节点在覆盖树中仍合法有效
2. 数据库存在该 mark id 对应结果组
3. 结果组完整

## 相关文档

- `allow-delete.md`
- `compaction-lifecycle.md`
- `../operator/compression-mark-usage.md`
