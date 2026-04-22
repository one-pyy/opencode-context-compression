# Lock 与 Send Gate（已实现 / 半实现）

## 文档定位

本文档描述文件锁、batch freeze、普通对话等待入口以及 lock 消失后如何判断 terminal outcome。

## Lock 生命周期

- 后台压缩任务真正开始时写入 lock 文件
- lock 文件记录当前时间
- retry/fallback 尝试全部完成后清除
- 超过 `compressing.timeoutSeconds` 后，后续请求自动忽视该 lock
- 手动删除 `locks/<session-id>.lock` 可恢复

## 阻塞范围

- 普通对话发送时等待到 lock 解除 / 终态失败 / 超时 / 手工恢复后再继续
- `compression_mark` 不加入已冻结 batch
- 非 compaction 工具调用不阻塞

## Batch Snapshot 冻结规则

当前 compaction batch 的 mark 集合在 dispatch 时冻结。

这意味着：

- lock 期间新增的 mark 自动进入下一轮
- 不需要写“lock 期间新加的 mark” special-case branching

这里的“进入下一轮”要精确理解为：

- 它们不会并入当前已经冻结并持有 lock 的 batch
- 普通对话在 lock 期间会先被 send gate 挡住，因此当前这次发送还不会处理这些新 mark
- 只有等当前 lock 释放后，下一次真正进入 replay / projection / scheduling 的处理轮次时，系统才会把这些新 mark 纳入评估

换句话说，新增 mark 会先被 gate 挡在当前轮之外，然后在 lock 结束后的下一轮被系统正式看见；“下一轮”不是指用户物理上下一次按下发送键的瞬间，而是指下一次成功穿过 send gate 的运行时处理轮次。

## 普通对话等待入口

普通对话的等待应发生在真正进入 send path 之前，而不是在更晚阶段才返回错误。

当前更精确的要求是：

- 若存在活跃 compaction gate，应在 `messages.transform` 的最早阶段检查
- 活跃时先等待，再继续当前轮 projection

## Lock 与 batch status 的联合判断

send-entry waiting 不能只看 lock 文件本身。

可靠做法：

1. 读 live lock
2. 记住 `startedAtMs`
3. lock 消失后，按对应 frozen batch 时间查 SQLite batch status
4. 再区分 succeeded / failed / cancelled / manual clear / inconsistent recovery

## 相关文档

- `compaction-lifecycle.md`
- `../architecture/runtime-model.md`
- `../projection/projection-rules.md`
