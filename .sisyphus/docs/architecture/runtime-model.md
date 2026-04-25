# 运行时模型（已实现 / 半实现）

## 文档定位

本文档集中描述当前运行时模型：sidecar 布局、文件锁语义、模块职责边界，以及哪些状态属于长期真相、哪些只是运行时附属信息。

## 四个操作员可见规则

1. **Canonical history 保持 upstream-owned**
   - 插件不覆盖宿主历史
   - 每次 transform 前重新同步 live host messages 到 sidecar

2. **SQLite 是 sidecar state，不是第二套会话**
   - 每个 session 一个数据库：`state/<session-id>.db`
   - SQLite 只保存结果组、visible-id 映射、schema 元信息等 sidecar 状态
   - mark 的真值来自 host history / tool history replay，不单独持久化 marks/source snapshots 真值表

3. **文件锁是实时压缩门控**
   - 活跃 batch 写入 `locks/<session-id>.lock`
   - 普通 chat 等待该锁
   - `compression_mark` 保持在已冻结 batch 之外

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
- schema 版本与数据库自描述元数据

### `visible_sequence_allocations`
- `canonical_id -> (seq6, base62)` 的稳定映射

### `result_groups`
- 某个 mark id 对应的一次成功提交的完整结果组头信息

### `result_fragments`
- 同一结果组被原始 gap 打散后的有序 replacement 片段

## 模块职责边界

- `messages.transform`：唯一 prompt projection seam
- `chat.params`：窄调度缝，不负责 prompt authoring 或普通对话等待入口
- `compaction-input-builder`：构造压缩输入，不复用 projected prompt 再清洗
- `compaction-runner`：后台压缩任务、retry/fallback、lock 生命周期
- `send-entry-gate`：普通对话等待入口

## Host seam 输入边界（已实现 / 半实现）

`chat.params` 不能被当成完整 transcript source。历史验证中，真实 OpenCode 1.3.7 payload 主要提供当前 `message`、`provider`、`model` 与 `session` 信息；完整 transcript 应来自 `experimental.chat.messages.transform` 或等价 session-level source，再由 runtime 缓存 normalized transcript 给调度/decision 路径读取。

marked-token accounting 可以使用 tokenizer-backed estimator；live-context reminder input 必须来自 authoritative telemetry。若 decision 前没有 authoritative source，应暴露缺失状态，而不是用 transcript estimate 伪造 live-context total。

### 关于“下一轮”的消歧

- `chat.params` / dispatcher 只负责根据当前 replay 结果冻结“这一轮待压缩 batch”并写入 pending queue
- `compaction-runner` 持有当前 batch 的 live lock；同一 session 在 lock 存活期间不应并发再启动第二个压缩 batch
- lock 期间新增的 mark 仍会出现在宿主历史里，但它们不会属于当前 batch；它们要等当前 lock 结束后，下一次真正穿过 send gate 并重新 replay 时，才会进入新的 batch 评估

## Metadata 边界

metadata 可以存在，但不是跨轮真相源。跨轮真相在 SQLite sidecar。

## 相关文档

- `system-overview.md`
- `verification-boundary.md`
- `../compaction/lock-and-send-gate.md`
- `../config/runtime-config-surface.md`
