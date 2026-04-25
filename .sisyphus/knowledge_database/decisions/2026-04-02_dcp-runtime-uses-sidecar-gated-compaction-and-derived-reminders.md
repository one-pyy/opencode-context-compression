## runtime-uses-sidecar-gated-compaction-and-derived-reminders
Date: 2026-04-02

### Decision
当前设计应采用 SQLite sidecar、显式 compaction model array、derived reminder/visible-id 逻辑，以及 compaction pending 时的受控 send gate。

### Rationale
旧文档体系中关于 `new-dcp-plugin-config-and-compaction-gates` 与生命周期教程的内容，曾收敛到一个更窄、更一致的方向：

- canonical host history 仍然是唯一真相源
- SQLite sidecar 保存派生状态，而不是复制第二套历史
- reminder、mark、replacement 与 visible-id 的很多行为需要 deterministic projection
- compaction 是异步但不能无限放任普通 send 路径继续乱跑，否则会在 pending 窗口里产生大量可避免的 prompt/cache 漂移

因此新的 clean-slate 设计保留了受控 send gate、ordered compaction models、明确的 `keep | delete` route，以及独立的 debug snapshot 入口。

### Alternatives Considered
- 保留多种持久化后端：拒绝，因为让状态解释矩阵膨胀，设计边界变模糊。
- 让 compaction pending 时普通对话继续无阻塞发送：拒绝，因为会在 replacement 即将稳定时制造额外 prompt/cache 偏移。
- 只保留单一 compaction model：拒绝，因为有序数组更清楚地表达 retry/fallback 次序。

### Consequences
- 当前设计与实现讨论必须围绕 host history + SQLite sidecar + projection + scheduling 这条主线。
- 运行时设计中的 debug snapshots、route、compaction models 与 blocking gate 都是第一类配置/行为，不应再埋入临时实现细节。
- 与生命周期缺口相关的未完成部分，应记录到 problems/docs，而不是稀释这条主决策。

### Additional Observations

**2026-03-26**: 早期 DCP 分叉方向曾强调 single-pass semantic compression：原始内容默认只压缩一次，后续 stale compressed content 应走 `keep | notepad+delete | delete` 路由，而不是继续做 summary-of-summary。当前 clean-slate 设计已把这条线收敛为 result group、replacement projection 与 delete permission 的组合语义。

**2026-03-26**: DCP 设计必须区分 cache identity stability 与 exact-prefix stability。稳定 `promptCacheKey` 或 session identity 不能保证 provider exact-prefix cache hit；任何 compaction/pruning 对早期 prompt-visible 内容的重写都会从重写点破坏 exact-prefix 复用。

**2026-03-29**: 旧 fork 曾存在“下游消费链不完整”的判断，但后续 provider mapper 已能消费 `dcpBackendContext` prompt override，并按 `message.id -> message.messageID -> metadata.dcp.visibleMessageId -> positional fallback` 解析 visible id。这类历史判断应按当前 host/provider seam 重新核验，不能直接沿用旧问题结论。

**2026-03-30**: OpenCode 1.3.7 的 `chat.params` 不应被当成完整 transcript seam；真实 payload 主要是当前 message 与 provider/model/session 信息。需要 transcript-driven 逻辑时，应从 `experimental.chat.messages.transform` 或等价 session-level source 缓存 normalized transcript，再让 narrow scheduler/readiness seam 消费该缓存。

**2026-03-30**: marked-token accounting 应使用一个共享 tokenizer-backed estimator。可接受 fallback 是 tokenizer 解析或编码失败后的粗略估计；不应把 turn-level token telemetry 的差值当作每消息 token 归因，因为 prompt cache、provider packaging 或 prompt shape 都可能让 delta 变小甚至为负。

**2026-03-30**: authoritative live-context token telemetry 可以通过完成后的 assistant token usage 被观察到，但它不等同于总能在本轮 decision 前稳定可用。严格 reminder correctness 应在缺少 authoritative source 时暴露 `DCP_LIVE_CONTEXT_TOKENS_MISSING`，而不是用 transcript estimate 伪装 live context。

**2026-03-30**: runtime log 应作为带 `kind` 字段的 mixed JSONL stream：普通 lifecycle event 可受 log level 控制，但 terminal host alert 不能被普通 event log level 静默关闭。调试时先按 `kind` 过滤，再解释 schema。

**2026-03-30**: committed replacement 真正 model-visible 的最小可靠 seam 是 `experimental.chat.messages.transform`，而不是仅把 `dcpBackendContext` 写入 `chat.params` side-channel。`chat.params` 应保留调度和 base transcript decisioning 角色，transform 负责最终 prompt-visible projection。

**2026-03-30**: reminder 可见性也沿同一 seam 边界处理：decision 可以在 `chat.params` 做出，但模型可见 artifact 必须经 `messages.transform` 投影。后续 current design 已进一步把 reminder 收敛为 canonical-history-derived projection，而非 durable host-history append。

**2026-03-31**: 中期设计从 codex-provider-centric flattening 转向以 `@ai-sdk/openai` / structured messages 为主模型；codex 风格 prompt text flattening 只应作为 provider-specific serializer edge case，不应主导 DCP 核心架构。

**2026-04-02**: clean-slate 插件设计进一步固定为 canonical history + SQLite sidecar + deterministic projection + narrow scheduler/gate。SQLite 保存派生状态、visible sequence、marks、replacements、jobs 与 gate，不是第二份 transcript；`messages.transform` 是唯一 prompt materialization seam，`chat.params` 只保留调度/门控职责。

**2026-04-02**: `compressing` lock 是 batch/job-chain 级门闩：后台 compaction 开始时写入，所有 retry/fallback 完成后清除，超时可忽略，手动删除可恢复。batch 在 dispatch 时冻结，lock 期间新增 mark 自然进入后续轮次，不需要 special-case branching。

**2026-04-04**: reminder prompt 的稳定结论是“纯文本提醒、非模板”；compaction prompt 才需要 `compressible_content` / `compaction_target` / `preserved_fields` 类模板输入。后续四 reminder 文件设计 supersede 了早期两个 reminder 文件数量，但不改变“reminder 不做模板注入”的结论。

Tags: #architecture #runtime #compaction #history
