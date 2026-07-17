# 压缩失败处理与 user-role 提示（半实现）

## 文档定位

本文档描述压缩任务失败时的运行时处理：即时 toast、跨发送累计三次模型链失败后的 terminal failure，以及尚未实现的 user-role notice。

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
- sidecar 已保存 result group 状态和 terminal compaction failure

### 当前缺口

- 后台压缩失败路径没有稳定写入 database-backed toast
- 后续轮次里没有针对 abandoned compaction 的 `user-role notice`

## 目标行为

### 1. 后台失败时立即提醒

- 某个后台 compaction mark 失败时，运行时应产生一条失败提醒
- 这条提醒至少要让操作员知道“压缩失败了”与“最近错误是什么”

### 2. 跨发送累计三次失败后停止自动重试（已实现）

- 每次发送触发的后台执行按顺序让全部配置模型各尝试一次
- 任意模型成功则立即结束并清除已有失败计数
- 整条模型链失败后，按 `mark_id` 将 `failure_count` 增加一次
- 第三次不同发送均整链失败后，该 mark 进入 terminal 状态，不再加入后续自动执行

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

当前 `compaction_failures` 表承接 terminal failure，字段为：

- `mark_id`
- `failure_count`
- `last_error`
- `last_failed_at`

未来接入 user-role notice 时，需要另行增加稳定锚点和 notice 状态；当前表不假装承载尚未实现的 projection 契约。

## 执行规则

## 失败计数口径

- 模型链顺序来自 `compactionModels`
- 每次发送中每个模型最多尝试一次
- transport、`<compression_output>` 协议、opaque 校验和 result-group source-range 映射任一失败，都会继续尝试本次发送中的下一个模型
- 整条模型链耗尽后累计一次失败；不会在同一次发送中立即启动第二轮

### 后台执行前

- 若某个 eligible mark 的 `failure_count >= 3`，则跳过执行
- `failure_count < 3` 的 mark 在下一次发送时仍可重试
- 该 mark 不应再次进入自动执行集合，避免无限重试

### 后台执行失败后

- 只有当前发送中的完整模型链确实耗尽时，才将 `failure_count` 增加一次并更新最近错误与失败时间
- 第三次失败在该 mark 耗尽时立即成为 terminal，不等待同 batch 的其他 mark 完成
- input 构造、SQLite commit、失败计数持久化或其他 operational failure 不增加 `failure_count`
- 已写入 terminal failure 的 mark 在后续自动执行中直接跳过

### 后台执行成功后

- 任意重试成功后删除对应失败计数记录

## Projection 规则

- 目标态 projection 读取 abandoned notice 且锚点仍存在的失败记录
- 在锚点 canonical message 后插入一条 `source = synthetic/reminder-like`、`role = user` 的 notice
- 若锚点不存在，则直接跳过

## 与 toast 的关系

- successful toast 可能来自 direct toast，不应误解为 database-backed toast 已经接通
- database-backed toast 仍可保留，用于“下一轮再播放”的延迟提醒
- 但 abandoned mark 的 durable 提示真相应进入 projection，而不是只依赖 toast

## 实现状态

- **已实现**：每次发送执行一轮完整模型链、跨发送累计三次失败、terminal failure sidecar 表、后续自动调度跳过 terminal mark、direct failure toast
- **未实现**：abandoned notice projection
- **半实现**：toast 消费端与 direct toast 已存在，但后台失败到 database-backed toast 的生产链仍不完整

## 相关文档

- `compaction-lifecycle.md`
- `lock-and-send-gate.md`
- `../architecture/runtime-model.md`
- `../projection/projection-rules.md`
