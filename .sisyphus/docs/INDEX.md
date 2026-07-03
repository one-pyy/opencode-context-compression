# opencode-context-compression — Docs Index

Project: /root/_/opencode/opencode-context-compression
Purpose: 记录本子项目当前最新设计与正式实现参考。

## Summary

当前 docs 承载最新设计与当前正式实现参考，重点覆盖系统总览、消息投影、压缩与删除许可、运行时模型、配置面、验证边界，以及 operator / prompt 相关使用说明。排查真实宿主 session 时，先读 operator live artifact 入口，确认会话、runtime log 尾部、debug snapshot、sidecar database 与 lock 的真相源。压缩输入与 token 估算现已共享同一条文本口径：只保留 `text + tool input/output`，不再把 `reasoning`、`patch`、`file` 当成独立文本来源。Reminder 已通过 no-op 工具调用 / 工具结果对承载，正文进入工具结果，不再作为独立 user 消息注入。压缩调度当前为异步 background executor 模式（pending 中转 + send-entry-gate，一轮延迟），目标设计改为异步压缩 + 替换门槛解耦：N+1 在 `messages.transform` 末尾直接启动后台压缩（去掉 pending 中转和 `chat.params` 调度），result group 入库后不立即替换，替换由 token 达标或 idle 超阈值触发，send-entry-gate 移除，lock 保留防并发。涉及当前设计契约、运行时边界、工具用法或 prompt 评估时，应先读本目录。

---

## Architecture

[architecture/system-overview.md] — 已实现/半实现并列：系统总览、真相源与主组件边界
[architecture/runtime-model.md] — 已实现/半实现并列：运行时模型、sidecar 布局与模块职责
[architecture/verification-boundary.md] — 已实现：自动化测试、live verification 与 truth boundary

## Projection

[projection/message-classification-and-visible-state.md] — 已实现：消息分类、visible state 与可见世界规则
[projection/visible-id-system.md] — 已实现：visible id 规则、落库映射与渲染约束
[projection/projection-rules.md] — 已实现/半实现并列：replacement、artifact 清理与最终投影规则

## Compaction

[compaction/reminder-system.md] — 已实现：reminder 语义、token 口径、cadence、prompt 选择与 no-op 工具载体
[compaction/allow-delete.md] — 已实现：delete permission 的语义与准入边界
[compaction/mark-tool-contract.md] — 已实现：`compression_mark` / `compression_inspect` 公共契约与 replay 入口语义
[compaction/recall-tool-contract.md] — 已实现：`compression_recall` tool 契约，按 seq 范围召回原始 host history transcript
[compaction/compaction-lifecycle.md] — 半实现：压缩生命周期、replay-first 模型与 fallback 行为；含异步压缩+替换门槛解耦目标设计（未实现）
[compaction/model-visible-transcript.md] — 已实现：压缩输入、token 估算与 tool 渲染共享的模型可见 transcript 契约
[compaction/lock-and-send-gate.md] — 当前实现，部分待移除：lock 保留、send-entry-gate 目标设计中移除
[compaction/failure-handling-and-user-notice.md] — 未实现：失败累计、三次失败停重试、database-backed toast 与 user-role notice 追加规则

## Config

[config/runtime-config-surface.md] — 已实现：配置字段、env 覆盖与 metadata 边界
[config/prompt-assets.md] — 已实现：prompt 资产清单与硬约束

## Operator

[operator/live-artifact-investigation.md] — 已实现：真实宿主 session、runtime log 尾部、debug snapshot、sidecar database 与 lock 的排查入口
[operator/compaction-records.md] — 已实现：每次压缩模型请求的输入 / 原始输出记录目录与文件命名契约
[operator/compression-mark-usage.md] — 已实现：`compression_mark` / `compression_inspect` 工具使用说明与常见错误
[operator/json-snapshot-trimming.md] — 已实现：调试快照 JSON 的安全读取方法
[operator/runtime-config-live-validation-runbook.md] — 已实现：runtime config 在真实宿主中的验证 runbook

## Prompting

[prompting/compaction-prompt-evaluation.md] — 已实现：如何评估 `prompts/compaction.md` 的压缩质量

## Migration

[migration/design-and-memory-cutover-map.md] — 旧 `DESIGN.md` / `notepad` / `notepads` 向新 docs / knowledge_database 的迁移图
