## batch-lock-must-not-outlive-undurable-freeze
Date: 2026-04-22

### Pattern
如果 compaction batch 在 durable 写入前就先拿到了 session lock，那么之后任何持久化失败都必须立刻释放该 lock；不能让文件锁代表一个从未 durable 的 phantom batch。

### Detail
旧文档体系总结出的关键失败模式是：

- 运行时 lock 已在磁盘存在
- SQLite batch row 仍未写成
- send-entry gating 会误以为 compaction 仍在有效运行

因此，lock 只有在以下两种状态下才可信：

1. batch 真正仍在 live running
2. 失败前已经留下可供下游检查的完整 durable state

否则就必须清锁。

### Applies To
- batch freeze
- runner
- send gate
- 任何先 acquire lock、后写 batch/job state 的流程

Tags: #lock #batch #compaction #runtime #trap
