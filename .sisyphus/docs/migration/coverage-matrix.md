# 旧资料到新体系的覆盖矩阵（进行中）

## 目的

这份矩阵用于证明：旧 `DESIGN.md`、`.sisyphus/notepad/`、`.sisyphus/notepads/` 中的高价值信息，已经被新的 `docs/` 与 `knowledge_database/` 正式承接；删除旧入口后，新体系仍能独立工作。

## 覆盖表

| 旧来源 | 信息类型 | 新落点 | 状态 |
|---|---|---|---|
| `DESIGN.md` §1 | 最新系统总览 | `docs/architecture/system-overview.md` | 已覆盖 |
| `DESIGN.md` §2 | 最新消息分类 / visible state | `docs/projection/message-classification-and-visible-state.md` | 已覆盖 |
| `DESIGN.md` §3 | 最新 reminder 契约 | `docs/compaction/reminder-system.md` | 已覆盖 |
| `DESIGN.md` §4 | 最新 delete permission 语义 | `docs/compaction/allow-delete.md` | 已覆盖 |
| `DESIGN.md` §5 | 最新 visible id 系统 | `docs/projection/visible-id-system.md` | 已覆盖 |
| `DESIGN.md` §6 | 最新 `compression_mark` 契约 | `docs/compaction/mark-tool-contract.md` | 已覆盖 |
| `DESIGN.md` §7-8 | 最新生命周期 / lock / gate | `docs/compaction/compaction-lifecycle.md`, `docs/compaction/lock-and-send-gate.md` | 已覆盖 |
| `DESIGN.md` §9 | 最新配置面 | `docs/config/runtime-config-surface.md` | 已覆盖 |
| `DESIGN.md` §10 | 最新投影规则 | `docs/projection/projection-rules.md` | 已覆盖 |
| `DESIGN.md` §11 | 最新 prompt 资产约束 | `docs/config/prompt-assets.md` | 已覆盖 |
| `DESIGN.md` §12-13 | 最新运行时模型 / 验证边界 | `docs/architecture/runtime-model.md`, `docs/architecture/verification-boundary.md` | 已覆盖 |
| `DESIGN.md` §14-15 | 历史决策、张力、replay-first 演化语境 | `knowledge_database/decisions/*`, `knowledge_database/problems/*`, `knowledge_database/learnings/*`, `knowledge_database/tutorials/*` | 已部分覆盖，继续筛选 |
| `.sisyphus/notepad/compression-mark-usage-guide.md` | 当前工具使用说明 | `docs/operator/compression-mark-usage.md` | 已覆盖 |
| `.sisyphus/notepad/trim-json-usage.md` | 当前调试快照读取方法 | `docs/operator/json-snapshot-trimming.md` | 已覆盖 |
| `.sisyphus/notepad/compression-improvements.md` | 混合：当前行为说明 + 历史修复总结 | `docs/*` + `knowledge_database/*` | 已部分覆盖，剩余内容待筛后决定保留或丢弃 |
| `.sisyphus/notepads/decisions/*` | durable 决策 | `knowledge_database/decisions/*` | 已筛选迁移核心条目 |
| `.sisyphus/notepads/problems/*` | durable 问题 / 冲突 / 演化背景 | `knowledge_database/problems/*` | 已筛选迁移核心条目 |
| `.sisyphus/notepads/learnings/*` | durable 规律 | `knowledge_database/learnings/*` | 已筛选迁移核心条目 |
| `.sisyphus/notepads/tutorials/*` | 可复用工作流 | `knowledge_database/tutorials/*` | 已筛选迁移核心条目 |
| `.sisyphus/notepads/design-cutover-db-api-e2e/*` | 任务专题，混合高价值与任务噪音 | `knowledge_database/*` / 丢弃 | 已筛选，少量高价值结论待最终确认 |
| `.sisyphus/notepads/2026-04-06_design-md-alignment-refactor-plan/*` | 迁移期冲突审计与任务拆解 | 以少量 problems / tutorials 形式保留，其余丢弃 | 已筛选 |
| `.sisyphus/notepads/toast-integration/*` | 功能专题与 review 噪音 | 当前 docs 已有正式文档；其余多数丢弃 | 已筛选 |
| `.sisyphus/notepads/handoff/handoff.md` | 单次交接上下文 | 不迁入正式体系 | 丢弃 |

## 删除前检查

删除旧入口前，需再次确认：

1. 新 docs 已完整承接当前最新设计
2. knowledge_database 已承接旧但有价值的决策 / 问题 / 规律 / 教程
3. 旧入口中不再存在“只能在那里找到的关键信息”
4. docs 与 knowledge_database 的索引都能独立导航
