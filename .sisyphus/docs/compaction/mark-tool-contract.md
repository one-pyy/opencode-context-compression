# `compression_mark` 公共契约（已实现）

## 文档定位

本文档描述 `compression_mark` 作为当前唯一公开压缩工具的职责、输入输出与 replay 入口语义。

## 职责边界

`compression_mark` 只负责打 tag / mark：

- 不负责压缩执行
- 不负责调度
- 不负责 prompt projection

## 工具契约

- `mode` 是 `"compact" | "delete"`
- `from` 与 `to` 来自当前 projected visible view
- 成功调用时立即返回随机 `mark id`
- `mode=delete` 且当前策略不允许 delete 时，返回错误结果

## 成功结果与错误结果的区别

- 成功结果：返回合法 `mark id`，表示创建了可重放的 mark intent
- 错误结果：本次调用没有成功创建 mark；它仍留在历史与最终可见世界里，但不进入 mark 覆盖树

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
