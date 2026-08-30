# opencode-context-compression — Docs Index

Project: /root/_/opencode/opencode-context-compression
Purpose: 记录本子项目当前最新设计与正式实现参考。
Current Stage: 实现参考与验收

## Summary

当前 docs 承载最新设计与当前正式实现参考，重点覆盖系统总览、消息投影、压缩与删除许可、运行时模型、配置面、验证边界，以及 operator / prompt 相关使用说明。排查真实宿主 session 时，先读 operator live artifact 入口，确认会话、runtime log 尾部、debug snapshot、sidecar database 与 lock 的真相源。压缩输入与 token 估算现已共享同一条文本口径：只保留 `text + tool input/output`，不再把 `reasoning`、`patch`、`file` 当成独立文本来源。Compaction 模型响应采用 JSON envelope，按 `plan`、`compression_output`、可选 `explanation` 顺序生成，只有 `compression_output` 参与映射与持久化；每次发送只执行一轮完整模型链，整链失败累计一次，达到 `compressing.maxFailureCount` 后才停止自动执行，默认上限为 `99999`。DeepSeek provider 或模型使用 `reasoning_effort: "medium"`。Reminder 已通过 no-op 工具调用 / 工具结果对承载，正文进入工具结果，不再作为独立 user 消息注入。压缩执行当前已去掉 pending 中转，N+1 在 `messages.transform` 末尾直接启动后台压缩；result group 替换门槛解耦与 send-entry-gate 缩小仍是目标设计。sidecar schema bootstrap 必须增量创建/迁移当前表，已知 legacy `pending_compactions` 只能被单表清理，不能触发整库 reset。涉及当前设计契约、运行时边界、工具用法或 prompt 评估时，应先读本目录。

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
[compaction/compaction-lifecycle.md] — 半实现：压缩生命周期、replay-first 模型与 fallback 行为；压缩执行已 N+1 直接启动，替换门槛解耦仍未实现
[compaction/model-visible-transcript.md] — 已实现：压缩输入、token 估算与 tool 渲染共享的模型可见 transcript 契约
[compaction/lock-and-send-gate.md] — 当前实现，部分待调整：lock 保留、send-entry-gate 缩小到仅在"该替换但压缩未完成"时阻塞
[compaction/failure-handling-and-user-notice.md] — 半实现：跨发送累计整链失败、可配置停止上限与自动跳过已实现；database-backed toast 和 user-role notice 未实现

## Config

[config/runtime-config-surface.md] — 已实现：配置字段、env 覆盖与 metadata 边界
[config/prompt-assets.md] — 已实现：prompt 资产清单与硬约束

## Operator

[operator/live-artifact-investigation.md] — 已实现：真实宿主 session、runtime log 尾部、debug snapshot、sidecar database、lock 与 result fragment sequence repair 的排查入口
[operator/compaction-records.md] — 已实现：每次压缩模型请求的输入 / 原始输出记录目录与文件命名契约
[operator/compression-mark-usage.md] — 已实现：`compression_mark` / `compression_inspect` 工具使用说明与常见错误
[operator/json-snapshot-trimming.md] — 已实现：调试快照 JSON 的安全读取方法
[operator/runtime-config-live-validation-runbook.md] — 已实现：runtime config 在真实宿主中的验证 runbook

## Prompting

[prompting/compaction-prompt-evaluation.md] — 已实现：如何评估 `prompts/compaction.md` 的压缩质量

## Migration

[migration/design-and-memory-cutover-map.md] — 旧 `DESIGN.md` / `notepad` / `notepads` 向新 docs / knowledge_database 的迁移图
