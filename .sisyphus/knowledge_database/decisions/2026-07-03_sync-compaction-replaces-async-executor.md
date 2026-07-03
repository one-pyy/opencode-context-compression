## sync-compaction-replaces-async-executor
Date: 2026-07-03

### Decision

将压缩调度从异步 background executor 模式改为同步执行：在 `messages.transform` 构造完 projection state 后，若存在 pending 且 token 达标，同步调用小模型压缩，等结果写 result group，再继续投影。去掉 background executor、lock、send-entry-gate。

### Rationale

当前异步模式有一轮延迟：mark 在轮次 N 末尾产生（tool call 在 chat.params 之后），N+1 才能写 pending，N+2 才能写 lock 开始压缩，N+3 才能用结果。同步模式在 N+2 即可用结果，且去掉 lock/gate/send-entry-gate 三套异步基础设施，只保留一条路径。

projection state 已经在 `messages.transform` 中构造，同步路径不需要跨 hook 传递 state。插件是请求驱动的，两次请求之间没有代码运行，所以"同步在请求时做"是自然落点。

### Alternatives Considered

- **保持当前异步模式**：延迟一轮但用户不等。拒绝原因：异步基础设施（lock、gate、batch freeze、send-entry-gate）维护成本高，且一轮延迟在实际使用中感知明显。
- **idle-time 后台压缩**：利用消息 `time.end` 字段，距上次请求结束超过阈值时同步压缩，用 idle 时间吸收等待。拒绝作为初始实现原因：需要额外的时间门槛逻辑和兜底阈值（pending 累积问题），但可作为同步路径的后续优化叠加，不需要回到异步架构。

### Consequences

- 有 pending 时用户发消息后要等压缩完成（几秒到几十秒）才发出请求；正常对话（无 pending）不受影响。
- lock、gate、send-entry-gate、background executor 相关代码和测试需要移除。
- `compaction-runner` 模块职责合并入 `messages.transform` 同步路径。
- idle-time 触发可作为后续优化，在同步路径上加时间门槛，不需要重建异步基础设施。
- docs 中 `compaction-lifecycle.md`、`lock-and-send-gate.md`、`runtime-model.md`、`system-overview.md` 已标注当前实现与目标设计的差异。

Tags: #compaction #architecture #runtime #scheduling #sync-vs-async
