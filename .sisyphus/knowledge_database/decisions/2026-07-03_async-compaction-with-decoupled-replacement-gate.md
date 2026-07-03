## async-compaction-with-decoupled-replacement-gate
Date: 2026-07-03

### Decision

将压缩调度从当前"pending 中转 + N+2 启动 + result group 存在即替换"改为"N+1 直接启动后台压缩 + 替换门槛解耦"：

1. 压缩执行提前到 N+1：`messages.transform` 末尾直接启动后台压缩，去掉 pending 中转和 `chat.params` 调度职责
2. 替换应用解耦：result group 入库后不立即替换，替换由门槛触发（token 达标 **或** idle 超阈值）
3. send-entry-gate 缩小触发范围：仅在"替换门槛已满足但压缩仍在进行中"时阻塞等待，复用当前 lock 超时机制（`compressing.timeoutSeconds`，默认 600 秒）；正常对话（门槛未满足）不阻塞

### Rationale

当前异步模式有一轮延迟（mark 在 N+0 末尾产生，N+1 写 pending，N+2 才启动压缩），且 pending 中转存在的原因是 `chat.params` 拿不到 `messages.transform` 的 projection state。但 `messages.transform` 本身就有这个 state，在它末尾直接启动压缩可以去掉中转。

替换与压缩解耦的原因：用户标记压缩后通常还会继续对话几轮（模型总结、用户确认），这几轮不需要立即替换原内容。用 idle 时间（消息 `time.end` 字段）作为替换门槛，用户休息后再发消息时 result group 已就绪，直接替换无感知。token 阈值作为兜底，防止 pending 无限累积。

### Alternatives Considered

- **同步压缩**（在 `messages.transform` 中同步调小模型，等结果再投影）：N+2 即可用结果，去掉全部异步基础设施。拒绝原因：有 pending 时用户发消息后要等几秒到几十秒，体验代价大；且压缩和替换耦合，无法利用 idle 时间。
- **保持当前异步模式**：延迟一轮但用户不等。拒绝原因：pending 中转是过度设计（`chat.params` 和 `messages.transform` 都要独立 replay 历史、构建 mark tree，重复工作），一轮延迟在实际使用中感知明显。
- **idle-time 后台压缩**（请求结束后定时器触发压缩）：需要新基础设施（插件是请求驱动的，两次请求之间没有代码运行）。拒绝原因：利用 `time.end` 在请求时检查 idle 时间即可达到同样效果，不需要常驻定时器。

### Consequences

- 压缩从 N+2 提前到 N+1，result group 在 N+2 已入库
- `chat.params` 调度职责合并回 `messages.transform`，pending 中转去掉
- send-entry-gate 缩小到仅在"该替换但压缩未完成"时阻塞，lock 保留防并发压缩 + gate 等待
- 替换逻辑从"result group 存在即替换"改为"result group 存在 **且** 门槛满足"
- 开放问题：`time.end` 是否包含 tool 执行耗时需验证
- docs 中 `compaction-lifecycle.md`、`lock-and-send-gate.md`、`runtime-model.md`、`system-overview.md` 已标注当前实现与目标设计的差异

Tags: #compaction #architecture #runtime #scheduling #async #replacement-gate
