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

## Scheduler diagnostics（已实现）

`chat.params` metadata 会随 runtime events 一起记录调度诊断，避免只看到“没有待压缩 mark”而看不到原因。诊断字段包括：

- replay 出来的 mark 数量与 mark id
- mark tree 中实际进入覆盖树的 mark id 与冲突列表
- 阈值过滤前的 queued mark id
- 已提交 result group 的 mark id
- 未压 marked token 数与当前 token 阈值
- scheduler mark 数量阈值
- 是否使用 sidecar-backed canonical identity service
- visible id 样本

`chat.params` 调度器必须使用 sidecar-backed canonical identity service 读取 `state.db.visible_sequence_allocations` 中已经分配过的 visible id。它不能按当前 replay sequence 重新生成 visible id；宿主会话可能回滚、裁剪或分支切换，当前 replay sequence 不再等价于模型发出 `compression_mark.from/to` 时看到的持久 visible sequence。

这些字段用于定位为什么 mark 没进入 pending 队列；其中 sidecar-backed identity 现在属于调度正确性的输入，不是可选优化。

## 相关文档

- `compaction-lifecycle.md`
- `../architecture/runtime-model.md`
- `../projection/projection-rules.md`
