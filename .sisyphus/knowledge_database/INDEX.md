# opencode-context-compression — Knowledge Database Index

Project: /root/_/opencode/opencode-context-compression
Purpose: 记录本子项目中具有长期价值的决策、问题、规律与教程。

---

## Summary

这个知识库承接具有长期价值的设计决策、历史问题、运行规律与可复用教程。最新设计与当前正式实现参考应进入 `docs/`；这里保留的是能帮助未来避免重复踩坑、理解演化背景、或复用既有判断方法的 durable 信息。最新高风险陷阱是压缩输入使用 text-only 与完整 tool object fallback 两套错误口径，既会漏掉模型可见 tool 内容，也会把宿主 metadata 膨胀到百万 token 级别。

## Decisions

[decisions/2026-04-02_dcp-runtime-uses-sidecar-gated-compaction-and-derived-reminders.md] — 旧阶段曾收敛到 host history + sidecar + gate 的主线，可作为演化背景参考 #history #architecture #runtime
[decisions/2026-04-22_repo-owned-operator-contract-remains-the-doc-truth-boundary.md] — operator-facing 文档与 live verification 必须继续坚持 repo-owned truth boundary #operator #docs #verification #contract
[decisions/2026-04-22_design-contract-keeps-token-cadence-and-delete-permission.md] — 设计契约继续采用 token cadence reminder 与真实 delete permission 语义 #design #reminder #delete-permission #contract
[decisions/2026-04-22_assistant-visible-id-rendering-rule.md] — assistant 与 tool result 的 visible id 渲染规则收敛为稳定前置模式 #visible-id #rendering #projection #design
[decisions/2026-04-26_accept-one-turn-delayed-opportunistic-compaction-execution.md] — 当前接受一轮延迟的 opportunistic compaction execution，不把它当作启动慢 bug #compaction #scheduler #runtime #lifecycle #architecture

## Issues

[issues/2026-04-03_bun-sqlite-runtime-compat-requires-adapter.md] — Bun-flavored runtime 需要 SQLite adapter 与 named-parameter normalization #runtime #sqlite #bun #trap
[issues/2026-05-12_tool-object-transcript-rendering-bloats-and-omits-compaction-input.md] — 压缩输入必须使用统一模型可见 transcript renderer，不能 text-only 或完整序列化 tool object #compaction #tool-calls #token-estimation #runtime #trap

## Learnings

[learnings/2026-04-22_hook-observation-and-session-prompt-transport-must-stay-separated.md] — seam observation 与默认 compaction transport 选择必须分开判断 #hooks #transport #seams #runtime #pattern
[learnings/2026-04-22_batch-lock-must-not-outlive-undurable-freeze.md] — 先拿 lock 后写 batch 时，持久化失败必须立即清锁 #lock #batch #compaction #runtime #trap
[learnings/2026-04-22_send-entry-wait-must-join-lock-and-batch-status.md] — send-entry wait 必须联合 live lock 与 batch terminal status 判断结果 #send-gate #lock #batch-status #runtime #pattern
[learnings/2026-04-22_transform-hook-role-surface-cannot-express-literal-system-artifacts.md] — 当前 transform hook 类型面不应被误当作可随意输出字面 system-role artifact #projection #types #hooks #artifact #pattern
[learnings/2026-04-26_scheduler-must-use-sidecar-visible-id-truth.md] — 调度器消费 mark range 时必须使用 sidecar 持久 visible id，不能按当前 replay sequence 重算 #visible-id #scheduler #sidecar #runtime #trap
[learnings/2026-04-26_runtime-state-must-not-rewrite-history-prefix.md] — 运行时生命周期状态不能动态回写历史前缀，否则破坏 exact-prefix cache #projection #cache #tool-result #runtime #trap

## Tutorials

[tutorials/2026-04-22_repo-owned-operator-docs-and-live-verification-maintenance.md] — operator docs / live verification / durable memory 的协同维护流程 #operator #verification #docs #workflow
[tutorials/2026-04-22_read-design-and-changelog-without-confusing-target-and-current-state.md] — 阅读 design 与 changelog 时区分目标态和当前态的标准流程 #design #changelog #workflow #docs
[tutorials/2026-04-22_live-host-debug-needs-correct-config-activation-and-artifact-truth.md] — 真实宿主调试时如何先确认配置激活与 artifact truth #live-debug #artifacts #verification #workflow

## Problems

[problems/2026-03-31_dcp-current-runtime-still-trails-target-lifecycle.md] — 当前运行时仍落后于目标生命周期模型 #runtime #lifecycle #gap
