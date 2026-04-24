# 压缩失败处理与 user-role 提示（未实现）

## 文档定位

本文档描述压缩任务失败时的运行时处理目标：即时 toast、失败累计、三次失败后停止自动重试，以及在后续投影中按锚点追加一条给 AI 的 `user` 角色提示。

## 范围澄清

- 这里的“提示”不是给真人用户看的产品文案。
- 这里的提示是写入投影结果、让后续模型轮次看到的 **`user-role notice`**。
- UI toast 与投影提示是两条不同链路：
  - **direct toast**：压缩 runner 直接调用 `ToastService`
  - **database-backed toast**：先写 sidecar 事件表，下一轮 hook 再读取并播放

## 当前状态

### 已存在

- `ToastService` 可直接播放：`compressionStart` / `compressionComplete` / `compressionFailed`
- `toast_events` 表及其消费端已存在
- projection 已支持按锚点插入 reminder 风格的 `user` 消息
- sidecar 已保存 pending compaction 与 result group 状态

### 当前缺口

- 后台压缩失败路径没有稳定写入 database-backed toast
- 失败 mark 缺少 durable failure state
- 失败超过阈值后，系统不会停止自动重试
- 后续轮次里没有针对 abandoned compaction 的 `user-role notice`

## 目标行为

### 1. 后台失败时立即提醒

- 某个后台 compaction mark 失败时，运行时应产生一条失败提醒
- 这条提醒至少要让操作员知道“压缩失败了”与“最近错误是什么”

### 2. 同一 mark 失败三次后停止自动重试

- 连续失败次数按 **`mark_id`** 累计
- 第 1、2 次失败：允许后续自动重试
- 第 3 次失败：该 mark 进入 **abandoned** 状态
- abandoned mark 不再加入后续自动执行

### 3. 三次失败后写入 user-role notice

- 当某个 mark 进入 abandoned 状态时，sidecar 应保存一条 notice
- notice 的用途是在后续 projection 中，按锚点消息后插入一条 `role: "user"` 的提示
- 这条提示用于告诉后续模型：
  - 某个 earlier compaction 已连续失败三次
  - 系统已停止继续自动重试
  - 最近失败原因是什么

## 锚点规则

- notice 必须保存稳定锚点，优先使用 **canonical message id**
- projection 时仅当锚点消息仍存在时才插入提示
- **如果对应的 msg id 不存在，就不 append**

## Sidecar 表设计目标

当前更适合采用一张失败状态表来同时承接：

- 连续失败次数
- 最近错误
- 是否已经 abandoned
- 对应的锚点消息
- 最终要追加给 AI 的 `user-role notice text`

推荐最小字段：

- `mark_id`
- `anchor_canonical_id`
- `failure_count`
- `last_error_message`
- `status`（`retrying` / `abandoned` / `resolved`）
- `notice_text`
- `first_failed_at`
- `last_failed_at`

## 执行规则

## 失败计数口径

- `failure_count` 的单位必须是 **同一个 `mark_id` 的完整 compaction task 最终失败次数**
- 一次 compaction task 内部的模型 retry / fallback 不单独计数
- 这意味着以下情况都仍只算 **同一次任务执行**：
  - 同模型的第 1 / 2 次重试
  - 从主模型切换到 fallback 模型
  - transport retryable error 后继续尝试同一模型链
- 只有当整条模型链耗尽、该次 compaction task 最终仍失败时，才把 `failure_count += 1`

### 为什么必须区分

- 如果把模型内部 retry 也算进 `failure_count`，一次短暂的上游抖动就可能错误触发“三次失败后停止自动重试”
- fallback 是单次任务内部的恢复机制，不应被误判成多次独立失败
- 因此“三次失败停重试”的语义必须固定为：**同一 mark 的完整压缩任务最终失败三次**

### 后台执行前

- 若某个 pending mark 已是 `abandoned`，则跳过执行
- 该 pending 项应被清理，避免无限重试

### 后台执行失败后

- 更新失败状态表中的 `failure_count` 与 `last_error_message`
- 小于 3 次时保持 `retrying`
- 达到 3 次时切换到 `abandoned`
- 同时生成 `notice_text`

### 后台执行成功后

- 若对应 mark 之前有失败状态，应转为 `resolved`
- resolved 后不再继续投影失败提示

## Projection 规则

- projection 读取 `status = abandoned` 且锚点仍存在的失败记录
- 在锚点 canonical message 后插入一条 `source = synthetic/reminder-like`、`role = user` 的 notice
- 若锚点不存在，则直接跳过

## 与 toast 的关系

- successful toast 可能来自 direct toast，不应误解为 database-backed toast 已经接通
- database-backed toast 仍可保留，用于“下一轮再播放”的延迟提醒
- 但 abandoned mark 的 durable 提示真相应进入 projection，而不是只依赖 toast

## 实现状态

- **未实现**：失败累计表、三次失败 stop-retry、abandoned notice projection
- **半实现**：toast 消费端与 direct toast 已存在，但后台失败到 database-backed toast 的生产链仍不完整

## 相关文档

- `compaction-lifecycle.md`
- `lock-and-send-gate.md`
- `../architecture/runtime-model.md`
- `../projection/projection-rules.md`
