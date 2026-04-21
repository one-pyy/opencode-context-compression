# DCP 生命周期与 runtime 契约（半实现）

## 文档定位

本文档用于把 DCP 子项目里“当前 runtime 主契约”和“目标生命周期模型”放在同一处说明，并明确哪些已经实现、哪些仍然是目标。

## 当前 runtime 主契约（已实现）

- canonical host history 是唯一真相源
- SQLite sidecar 保存派生状态与运行时状态
- policy/projection/scheduling 分层存在
- config 支持 ordered compaction model array
- runtime 存在 compaction pending 时的受控 gate 设计
- debug snapshots 通过专门环境变量触发，而不是混入常规日志

这些内容的权威实现参考应以：

- `DESIGN.md`
- `src/`
- `tests/`

为主。

## 目标生命周期模型（半实现）

目标模型强调以下顺序：

1. 总上下文超过 `hsoft` / `hhard`
2. 插入 durable reminder `R.n`
3. AI 发出 `M[...]` mark
4. runtime 累积 marked tokens
5. 达到 `markedTokenAutoCompactionThreshold` 后触发 compaction
6. 成功后用 `C[...]` 替换 prompt-visible 历史，并清理过时 reminder / mark / tool artifacts

其中以下部分仍是目标态或只部分实现：

- durable reminder 真正进入长期历史的语义
- mark 与 marked-token accounting 的完整闭环
- compaction 后 cleanup 语义的完全收敛

## 用户消息规则（已实现为设计约束）

- 用户消息不是一律不可压缩
- 只有长度不超过 `smallUserMessageThreshold` 的小用户消息永久保护
- 更大的用户消息允许进入可压缩集合

## 当前建议的阅读顺序（已实现）

1. `DESIGN.md` — 当前总设计契约
2. 本文档 — 区分当前主契约与目标生命周期
3. `knowledge_database/problems/2026-04-19_dcp-current-runtime-still-trails-target-lifecycle.md` — 当前缺口基线

## 非目标（已实现）

- 不把历史 notepad 教程继续当作唯一现行规范
- 不把所有 DCP 讨论都塞进一个 problems 条目
- 不把目标设计描述成已经完整实现
