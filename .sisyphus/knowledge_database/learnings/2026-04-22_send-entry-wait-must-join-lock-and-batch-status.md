## send-entry-wait-must-join-lock-and-batch-status
Date: 2026-04-22

### Pattern
send-entry waiting 不能只看 lock 文件本身；lock 只代表 live running，而 terminal outcome 必须结合 SQLite 中与该 lock-start 对应的 batch status 一起判断。

### Detail
旧文档体系中这条规律的核心是：

- runner 在开始时创建 lock
- terminal status 落到 SQLite
- `finally` 中移除 lock

所以“lock 消失”不是 success 的充分条件。可靠做法是：

1. 读取 live lock
2. 记住 `startedAtMs`
3. lock 消失后，按 `startedAtMs` / frozen batch 时间去查对应 batch
4. 根据 batch status 区分 succeeded / failed / cancelled / manual clear / inconsistent recovery

### Applies To
- send-entry gate
- runner
- batch freeze
- 任何需要在 lock 消失后判断 terminal outcome 的逻辑

Tags: #send-gate #lock #batch-status #runtime #pattern
