# 运行时模型（已实现 / 半实现）

## 文档定位

本文档集中描述当前运行时模型：sidecar 布局、文件锁语义、模块职责边界，以及哪些状态属于长期真相、哪些只是运行时附属信息。

## 四个操作员可见规则

1. **Canonical history 保持 upstream-owned**
   - 插件不覆盖宿主历史
   - 每次 transform 前重新同步 live host messages 到 sidecar

2. **SQLite 是 sidecar state，不是第二套会话**
   - 每个 session 一个数据库：`state/<session-id>.db`
   - SQLite 只保存结果组、visible-id 映射、跨发送 compaction failure counts、toast events、schema 元信息等 sidecar 状态
   - mark 的真值来自 host history / tool history replay，不单独持久化 marks/source snapshots 真值表

3. **文件锁是实时压缩门控**（当前实现，目标设计中缩小 gate 触发范围）
   - 活跃 batch 写入 `locks/<session-id>.lock`
   - 普通 chat 等待该锁（当前实现；目标设计中仅在"该替换但压缩未完成"时阻塞，复用 lock 超时）
   - `compression_mark` 保持在已冻结 batch 之外
   - 目标设计保留 lock 防并发压缩，send-entry-gate 缩小到最小必要范围

4. **投影是确定性的**
   - 已提交 replacement 通过 `experimental.chat.messages.transform` 渲染
   - 相同 canonical history + 相同 sidecar 结果组 → 相同最终可见输出

## Sidecar 布局

```text
<plugin-root>/state/<session-id>.db
<plugin-root>/locks/<session-id>.lock
<plugin-root>/logs/runtime-events.jsonl
<plugin-root>/logs/seam-observation.jsonl
```

这些路径都必须相对于**插件根目录**解析。

## SQLite 存储原则

SQLite 应保存：

- replacement 结果组及其与 mark id 的关联
- canonical message identifier 到 visible-id 序号/后缀的稳定映射
- 必要的 schema 元信息

SQLite 不应承担：

- 第二份完整 transcript
- marks/source snapshots 的长期真值库
- 独立于 host history 的平行会话

## 当前最小表设计

### `schema_meta`
- schema 版本与数据库自描述元数据；当前 `schema_version=2`
- v2 增加 `compaction_failures`，bootstrap 采用增量建表，不重置既有 result data

### `visible_sequence_allocations`
- `canonical_id -> (seq6, base62)` 的稳定映射

### `result_groups`
- 某个 mark id 对应的一次成功提交的完整结果组头信息

### `result_fragments`
- 同一结果组被原始 gap 打散后的有序 replacement 片段

### `toast_events`
- database-backed toast / notice 事件

### `compaction_failures`
- 保存每次发送完整模型链耗尽后的累计失败状态
- 记录 `mark_id`、`failure_count`、最近错误与最近失败时间
- background executor 允许 `failure_count < 3` 的 mark 在后续发送重试，并跳过 `failure_count >= 3` 的 terminal mark

### Legacy `pending_compactions`
- `pending_compactions` 不是当前运行时表
- 旧 DB 中存在该表时，schema bootstrap 只应删除这张旧队列表，不得清空 `result_groups`、`result_fragments` 或 `visible_sequence_allocations`

## Schema bootstrap 约束（已实现）

sidecar bootstrap 可以自动创建缺失的当前表、补齐兼容列，并清理已知 legacy 表。它不得因为出现无关旧表就重建整个数据库；如果关键结果表缺少当前代码必须读取的列，应失败并要求显式迁移，而不是静默丢弃已提交 result group。

## 模块职责边界

- `messages.transform`：唯一 prompt projection seam
- `chat.params`：窄调度缝，不负责 prompt authoring 或普通对话等待入口
- `compaction-input-builder`：构造压缩输入，不复用 projected prompt 再清洗
- `compaction-runner`：后台压缩任务、retry/fallback、lock 生命周期；当前由 N+1 的 `messages.transform` 末尾直接触发
- `send-entry-gate`：普通对话等待入口（当前实现，目标设计中缩小到仅在"该替换但压缩未完成"时阻塞）

## Host seam 输入边界（已实现 / 半实现）

`chat.params` 不能被当成完整 transcript source。历史验证中，真实 OpenCode 1.3.7 payload 主要提供当前 `message`、`provider`、`model` 与 `session` 信息；完整 transcript 应来自 `experimental.chat.messages.transform` 或等价 session-level source，再由 runtime 缓存 normalized transcript 给调度/decision 路径读取。

marked-token accounting 可以使用 tokenizer-backed estimator；live-context reminder input 必须来自 authoritative telemetry。若 decision 前没有 authoritative source，应暴露缺失状态，而不是用 transcript estimate 伪造 live-context total。

### 关于“下一轮”的消歧（已实现）

当前异步实现：

- `messages.transform` replay 完历史后，直接根据当前 projection state 启动后台压缩，不经过 pending queue 或 `chat.params` 调度
- `compaction-runner` 持有当前 batch 的 live lock；同一 session 在 lock 存活期间不应并发再启动第二个压缩 batch
- 本次调用冻结 eligible mark 集合；之后新增的 mark 不属于当前 batch，在下一次 `messages.transform` replay 时进入新的评估

仍未实现的目标设计仅包括替换门槛解耦：

- lock 仍保留防并发压缩，send-entry-gate 缩小到仅在"该替换但压缩未完成"时阻塞，复用 lock 超时
- 替换由门槛触发（token 达标或 idle 超阈值），result group 入库后不立即替换

## Metadata 边界

metadata 可以存在，但不是跨轮真相源。跨轮真相在 SQLite sidecar。

## 相关文档

- `system-overview.md`
- `verification-boundary.md`
- `../compaction/lock-and-send-gate.md`
- `../config/runtime-config-surface.md`
