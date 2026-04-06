# 新项目切断记录

本仓库已按“**与旧方案断干净**”执行破坏性 cutover。

目标不是兼容迁移，也不是维持旧插件还能继续运行；目标是：

1. 直接移除旧方案主链
2. 不再保留 route / allowDelete / mark/source snapshot / replay fallback 等旧语义兼容层
3. 只留下可在新项目中单独复用、且不依赖旧业务模型的通用工具件

---

## 一、已删除的旧功能 / 旧模块

下面这些能力被视为“旧方案主链”，已直接删除，而不是继续修补：

### 1. 旧插件运行入口与业务 wiring

- 旧 `src/index.ts` 的完整 hooks wiring 已删除
- 不再注册旧版：
  - `compression_mark`
  - `experimental.chat.messages.transform`
  - `chat.params` scheduler
  - send-entry gate

现在的 `src/index.ts` 只保留一个**明确报错的 cutover stub**，防止任何人误把当前仓库当成还能继续沿用旧实现的可运行插件。

### 2. mark / source snapshot 持久化主模型

以下文件已删除：

- `src/marks/mark-service.ts`
- `src/state/store.ts`
- `src/state/schema.ts`
- `src/state/session-db.ts`

对应删除的旧能力：

- 持久化 `mark`
- 持久化 `source_snapshot`
- 用 SQLite 承担 mark/source truth source
- 用 `allowDelete` 参与 source fingerprint / snapshot equivalence / replacement matching
- route-era schema 迁移与兼容逻辑

### 3. hook 重放与覆盖树旧实现

以下文件已删除：

- `src/replay/mark-replay.ts`
- `src/replay/coverage-tree.ts`

对应删除的旧能力：

- 从 `marks` 表回读 mark 再重建覆盖树
- 旧的 mark runtime state 回写
- 旧的 invalid mark / intersect fallback 链

### 4. projection / replacement / reminder 旧实现

以下文件已删除：

- `src/projection/projection-builder.ts`
- `src/projection/messages-transform.ts`
- `src/projection/reminder-service.ts`
- `src/projection/policy-engine.ts`
- `src/identity/canonical-identity.ts`
- `src/identity/visible-sequence.ts`

对应删除的旧能力：

- 旧 prompt projection builder
- 旧 visible-id 注入与 materialize 逻辑
- 旧 replacement 渲染
- 旧 result-group fallback 到单 replacement 的逻辑
- legacy visible-id normalization
- reminder 投影实现
- 旧 canonical identity / visible sequence 主链耦合

### 5. compaction 执行与 transport 主链

以下文件已删除：

- `src/compaction/runner.ts`
- `src/compaction/input-builder.ts`
- `src/compaction/output-validation.ts`
- `src/transport/contract.ts`
- `src/runtime/default-compaction-transport.ts`
- `src/runtime/chat-params-scheduler.ts`
- `src/runtime/send-entry-gate.ts`
- `src/runtime/lock-gate.ts`
- `src/runtime/frozen-batch.ts`
- `src/runtime/runtime-events.ts`
- `src/marks/batch-freeze.ts`

对应删除的旧能力：

- 自动 compaction batch 冻结
- 旧 scheduler marked-token readiness 主链
- 旧 runner / retry / fallback model chain
- 旧 output validation
- 旧 transport safe-default assessment
- 旧 send-entry wait gate
- 旧 runtime gate audit / runtime event logging 主链

### 6. 旧工具入口

以下文件已删除：

- `src/tools/compression-mark.ts`

对应删除的旧能力：

- 旧 `compression_mark` 工具
- 旧 visible selector 解析
- 旧 delete admission + compatibility allowDelete 传播
- 旧 mark persistence 行为

### 7. 旧运行时配置主链

以下文件已删除：

- `src/config/runtime-config.ts`

对应删除的旧能力：

- 旧 runtime-config 解析
- 旧 compaction/reminder/logging/runtime path 配置入口
- 旧 prompt 资产加载主链

---

## 二、明确不再保留的旧语义

这次 cutover 的重点不是删文件本身，而是明确宣布以下旧语义**不再延续**：

- 不再保留 `route` 时代的兼容迁移语义
- 不再保留 `allowDelete` 作为长期持久业务字段的实现
- 不再保留 marks/source snapshots 作为 projection 真相源
- 不再保留旧 replacement fallback（尤其是 result group → 单 replacement fallback）
- 不再保留 legacy visible-id 格式兼容
- 不再保留“旧插件还能勉强继续工作”的过渡目标

---

## 三、保留下来、可在新项目继续复用的模块

下面这些文件没有承载旧业务主链，仍可在新项目中单独复用：

### 1. `src/runtime/path-safety.ts`

可复用能力：

- session id 作为路径段的安全校验
- 目录内安全路径拼接

### 2. `src/runtime/file-lock.ts`

可复用能力：

- 基于文件的 session lock
- stale lock 判断
- wait / settle / release 的通用锁语义

说明：这是通用运行时门闩工具，不再自动等同于旧 compaction 业务。

### 3. `src/seams/noop-observation.ts`

可复用能力：

- hook shape 观测
- 输入输出 shape 摘要
- identity 字段抽取
- noop observation hooks

### 4. `src/seams/file-journal.ts`

可复用能力：

- 将 observation journal 持久化到 JSONL 文件

### 5. `src/token-estimation.ts`

可复用能力：

- 基于 `tiktoken` 的 envelope 文本 token 估算
- tokenizer alias 机制

### 6. `src/state/sqlite-runtime.ts`

可复用能力：

- Node/Bun 下的 SQLite runtime 装载适配
- 统一的 database / statement 抽象

### 7. `src/index.ts`

保留为**cutover stub**，用途不是运行旧业务，而是：

- 阻止误加载旧插件
- 明确向调用方提示：旧实现已被移除

---

## 四、当前仓库状态

当前仓库不是“旧插件的下一步迭代”，而是：

- **旧实现已截断**
- **旧主链已删除**
- **只剩可复用底层工具件 + cutover 记录**

如果要继续做“新项目”，建议从保留下来的通用模块重新组装，而不是恢复任何已删除的旧业务文件。
