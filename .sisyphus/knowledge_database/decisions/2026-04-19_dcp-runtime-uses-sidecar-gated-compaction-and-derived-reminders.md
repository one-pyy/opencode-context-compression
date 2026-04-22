## runtime-uses-sidecar-gated-compaction-and-derived-reminders
Date: 2026-04-19

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

Tags: #architecture #runtime #compaction #history
