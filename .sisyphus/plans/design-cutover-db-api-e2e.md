# Design Cutover：数据库、插件接口与 E2E 规划

## TL;DR
> **Summary**: 唯一规范来源是 `DESIGN.md`。本计划围绕 cutover 后仅存的 primitives，重建数据库侧边车、插件外部/内部接口契约，以及仅使用 safe transport fixture 的 hermetic E2E 体系；不写单元测试，不依赖 `rubbish/` 或已删除旧实现；凡现有项目与 `DESIGN.md` 不符，直接删除或破坏性重写，不做任何兼容旧行为。
> **Deliverables**:
> - 中文数据库侧边车与结果组存储方案
> - 插件外部 hook/tool 契约与内部模块接口设计
> - 仅基于 safe transport 的 E2E 方案与场景矩阵
> - 面向执行代理的分波次 TODO、验收条件与 QA 场景
> **Effort**: XL
> **Parallel**: YES - 2 waves
> **Critical Path**: 1 → 2 → 7 → 8 → 10 → 12

## Context
### Original Request
- 读取 `src/` 全部代码、`DESIGN.md`、changelog、`NEW_PROJECT_CUTOVER.zh.md`
- 忽略 `rubbish/`
- 不写单元测试
- 以 `DESIGN.md` 为准，撰写数据库、接口、e2e 测试规划
- “接口”同时包括插件对外 hook/tool 契约与插件内部模块接口
- 首先产出中文规划

### Interview Summary
- 当前仓库不是可直接补丁式修复的工作态插件，而是 cutover 后的骨架仓库
- 可复用 primitives 主要集中在 `src/state/sqlite-runtime.ts`、`src/runtime/file-lock.ts`、`src/runtime/path-safety.ts`、`src/seams/noop-observation.ts`、`src/seams/file-journal.ts`、`src/token-estimation.ts`
- `src/index.ts`、projection、scheduler/send-entry gate、compaction、identity、`compression_mark`、runtime-config loader 等核心链路仍是 TODO stub
- 现有活跃测试文件缺失；`package.json` 中 Node test runner 已配置，`scripts/run-seam-probe.mjs` 可作为现有唯一可复用验证入口
- E2E 路线明确为 injected safe transport，不将 repo-owned 默认执行器纳入本次计划

### Metis Review (gaps addressed)
- 明确收敛 truth model：host history / tool history 是 mark truth source；SQLite 只持久化 result groups keyed by mark id、visible-id 映射与 schema 元信息
- 明确收敛 delete 语义：`allowDelete` 按 delete-admission gate 处理，而非长期真值语义中心
- 增补 guardrails：禁止把“接口”扩展成 HTTP API 或通用插件框架；禁止假设现有活跃 tests/ 已存在；禁止 live network
- 增补 acceptance focus：所有验收标准必须 agent 可执行，且仅使用 E2E / contract-style / integration-style 测试，不写 unit tests

## Work Objectives
### Core Objective
在不扩展到 HTTP/API/UI 或默认执行器实现的前提下，产出一份可直接执行的单一计划，指导执行代理完成：
1. 数据库侧边车设计与落地顺序；
2. 插件对外 hook/tool 契约与插件内部模块接口设计；
3. 只依赖 safe transport fixture 的 hermetic E2E 设计与验证矩阵。

### Deliverables
- sidecar SQLite schema、文件布局、result-group/visible-id/lock 关联设计
- 插件外部接口设计：`experimental.chat.messages.transform`、`chat.params`、`tool.execute.before`、`compression_mark`
- 插件内部模块接口设计：config、identity、storage、replay/projection、policy/reminder、compaction、scheduler/gate、transport adapter
- `tests/e2e/**` 目录结构、fixture 规范、network-deny 策略、场景矩阵
- 失败恢复、重放、删除准入、无网络执行等关键边界行为的验收标准

### Definition of Done (verifiable conditions with commands)
- `node --import tsx --test tests/e2e/database/*.test.ts`
- `node --import tsx --test tests/e2e/interfaces/*.test.ts`
- `node --import tsx --test tests/e2e/runtime/*.test.ts`
- `node --import tsx --test tests/e2e/compaction/*.test.ts`
- `node --import tsx --test tests/e2e/recovery/*.test.ts`
- `node --import tsx --test tests/e2e/**/*.test.ts`
- `node scripts/run-seam-probe.mjs`
- `npm run typecheck`

### Must Have
- `DESIGN.md` 是唯一规范来源；所有 SQL / API / E2E / 数据流都必须直接贴合 `DESIGN.md`
- changelog 与 cutover 文档仅用于说明“旧项目到当前仓库发生了哪些变化”，不得覆盖、修正或替代 `DESIGN.md`
- 数据库设计必须围绕“host history replay + result-group store”而非旧 mark/source snapshot 真值模型
- 所有接口设计必须同时覆盖外部 hook/tool 合同与内部模块之间的 request/response/type ownership
- E2E 必须 hermetic、默认拒绝 live network，并显式依赖 injected safe transport
- 所有任务都要内含 happy path + failure path 的 QA 场景与证据路径

### Must NOT Have (guardrails, AI slop patterns, scope boundaries)
- 不得引用 `rubbish/` 中任何实现、测试或路径作为当前事实依据
- 不得规划 HTTP/RPC/REST 外部服务接口
- 不得把 repo-owned 默认执行器、实时网络代理、通用插件 SDK、UI/可视化扩展纳入本次范围
- 不得写 unit tests，且不得以“后续人工验证”替代 agent-executable 验收
- 不得回退到“SQLite/mark 表是真值源”的旧模型
- 不得把文档里提到但当前仓库不存在的 tests/ 文件当成可复用资产
- 不得为旧行为保留兼容分支、迁移适配层或 fallback 语义；凡与 `DESIGN.md` 冲突者，直接删除、替换或重写

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: 无 unit tests；仅使用 E2E / contract-style / integration-style 场景，统一落在 `tests/e2e/**` 下并通过 Node test runner 执行
- QA policy: 每个任务都必须包含 agent-executed 场景；默认工具为 Bash，必要时配合 seam probe 与 network-deny fixture
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`

## Execution Strategy
### Global Decisions / Non-Goals / Contract Precedence
- **Truth model**：host history / tool history 是 mark 真值源；SQLite 是仅保存 result groups、visible-id 映射与 schema 元信息的 sidecar
- **Delete semantics**：`allowDelete` 是 delete-admission gate；持久化核心是 `mode` 与结果组，不是旧 allowDelete 传播语义
- **Transport policy**：E2E 只允许 injected safe transport；未注入 transport 视为确定性配置错误
- **Non-goals**：不交付默认 live executor、不设计 HTTP API、不处理 `rubbish/`、不重建广义 event platform
- **Contract precedence**：`DESIGN.md` 是唯一规范；`DESIGN-CHANGELOG*.zh.md` 与 `NEW_PROJECT_CUTOVER.zh.md` 仅用于解释“旧项目到当前仓库发生了哪些变化”，不得作为覆盖 `DESIGN.md` 的规范来源
- **Rewrite policy**：若现有代码、目录、类型、行为与 `DESIGN.md` 不一致，执行代理必须直接删除、替换或破坏性重写；禁止兼容旧行为

### Parallel Execution Waves
> Target: 5-8 tasks per wave. <3 per wave (except final) = under-splitting.
> Extract shared dependencies as Wave-1 tasks for max parallelism.

Wave 1: 数据侧边车基础、外部/内部接口边界、safe transport E2E 基础
Wave 2: projection/compaction/gate 接口收口与完整 E2E 场景实现

### Dependency Matrix (full, all tasks)
| Task | Depends On | Enables |
|---|---|---|
| 1 | - | 2, 6, 10 |
| 2 | 1 | 7, 8, 10, 12 |
| 3 | - | 7, 9, 11 |
| 4 | - | 1, 2, 6, 7, 8, 9 |
| 5 | 3 | 7, 8, 11 |
| 6 | 1, 3, 4 | 10, 11, 12 |
| 7 | 2, 3, 4, 5 | 10, 11, 12 |
| 8 | 2, 5, 7 | 10, 12 |
| 9 | 3, 4, 6, 7, 8 | 11, 12 |
| 10 | 1, 2, 6, 7, 8 | F1-F4 |
| 11 | 3, 5, 6, 7, 9 | F1-F4 |
| 12 | 2, 6, 8, 9, 10, 11 | F1-F4 |

### Agent Dispatch Summary (wave → task count → categories)
- Wave 1 → 6 tasks → deep / unspecified-high / quick
- Wave 2 → 6 tasks → deep / unspecified-high / quick
- Final Verification → 4 tasks → oracle / unspecified-high / deep

## Locked SQL Design
> 本节不是建议稿，而是执行代理必须直接照做的数据库设计基线。若实现与本节不一致，必须先回到计划修订，而不是自行改动设计。

### Citation Rule
- `DESIGN.md §X.Y` = 唯一规范来源
- 计划中可以保留极少量“Historical context only”说明，目的仅是帮助阅读仓库现状；它们**不能**被执行代理当成设计判定依据

### Storage Layout
- SQLite sidecar：`state/<session-id>.db`
- 文件锁：`locks/<session-id>.lock`
- seam log：`logs/seam-observation.jsonl` 或运行时指定路径
- 输入/输出调试快照：`state/debug/<session-id>.in.json`、`state/debug/<session-id>.out.json`
- **禁止新增** `marks`、`source_snapshots`、`canonical_sources` 之类旧模型真值表

**Primary design sources**:
- `DESIGN.md §1.2, §1.3, §12.1, §12.3`

### SQL Principles
- host history / tool history 是 mark 真值源；数据库**不是** mark/source truth store
- 数据库只存：
  1. result groups keyed by mark id
  2. fragments
  3. visible sequence 分配映射
  4. schema 自描述元信息
- projection / reminder 必须每次基于 host history 做**全量 replay**；数据库不保存增量 checkpoint
- result group 的“完整成功才可见”是 **insert 事务规则**，不是结果组本体状态机；压缩失败时不写入 result group
- `allowDelete` 不作为主键、不作为结果匹配语义中心；持久化以 `mode` 与最终结果组为核心

**Primary design sources**:
- `DESIGN.md §6.4, §14.15, §15.1-§15.5, §15.12, §15.27`
- `DESIGN.md §4.3, §4.4, §14.5`（旧语义与新语义冲突处，按后者收敛）

### SQLite DDL (Locked)
```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = FULL;

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR REPLACE INTO schema_meta(key, value) VALUES
  ('schema_version', '1'),
  ('truth_model', 'history-replay-result-groups');

CREATE TABLE IF NOT EXISTS visible_sequence_allocations (
  canonical_id TEXT PRIMARY KEY,
  visible_seq INTEGER NOT NULL UNIQUE CHECK (visible_seq >= 1),
  visible_kind TEXT NOT NULL,
  visible_base62 TEXT NOT NULL,
  assigned_visible_id TEXT NOT NULL UNIQUE,
  allocated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS result_groups (
  mark_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('compact', 'delete')),
  source_start_seq INTEGER NOT NULL,
  source_end_seq INTEGER NOT NULL,
  fragment_count INTEGER NOT NULL CHECK (fragment_count >= 1),
  model_name TEXT,
  execution_mode TEXT NOT NULL,
  created_at TEXT NOT NULL,
  committed_at TEXT,
  payload_sha256 TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS result_fragments (
  mark_id TEXT NOT NULL,
  fragment_index INTEGER NOT NULL,
  source_start_seq INTEGER NOT NULL,
  source_end_seq INTEGER NOT NULL,
  replacement_text TEXT NOT NULL,
  PRIMARY KEY (mark_id, fragment_index),
  FOREIGN KEY (mark_id) REFERENCES result_groups(mark_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_result_groups_source_range
  ON result_groups(source_start_seq, source_end_seq);

CREATE INDEX IF NOT EXISTS idx_visible_sequence_allocations_seq
  ON visible_sequence_allocations(visible_seq);

CREATE INDEX IF NOT EXISTS idx_result_fragments_mark_order
  ON result_fragments(mark_id, fragment_index);
```

**Primary design sources**:
- `DESIGN.md §1.3, §5.1, §5.3, §6.4, §8.1, §10.2, §12.3, §14.15, §15.12, §15.27`
- 说明：以上章节锁定的是“必须持久化的语义对象与约束”，DDL 表名/列名是按这些章节推导出的唯一执行版命名，不允许执行代理自行改模型。

### Atomic Write Rules (Locked)
- 创建成功 result group 时必须使用单事务：
```sql
BEGIN IMMEDIATE;
INSERT INTO result_groups (...);
INSERT INTO result_fragments (...);
COMMIT;
```
- 任一步失败必须 `ROLLBACK`，并保证该 `mark_id` 在读模型中**零可见行**
- 失败 compaction 不写入 `result_groups` / `result_fragments`
- timeout / malformed output / validation failure 只体现在错误返回、日志和测试证据中，不进入结果组读模型
- `visible_sequence_allocations` 的分配必须在单独的可重入事务中完成，并保证 `visible_seq` 严格递增、`assigned_visible_id` 全局唯一

**Primary design sources**:
- `DESIGN.md §6.4, §7.3, §10.2, §14.15, §15.12, §15.18, §15.27`

### Read Model Rules (Locked)
- projection 查询直接读取 `result_groups`；库中存在的结果组即表示“已完成、已提交、可消费”
- 同一 `mark_id` 必须一次性读取全部 `fragment_count` 个 fragment；若片段数量不一致，视为数据库损坏并 fail-fast
- visible id 分配采用 `visible_sequence_allocations`，一经分配永久不变，不重排、不回收
- visible id 的格式锁定为：`<visible_kind>_<6位递增十进制序号>_<base62后缀>`；其中 `6位序号` 来源于 `visible_seq`
- projection / reminder 每次都从历史头到尾全量 replay，按全量 token 统计决定 reminder 插入位置
- reminder 不写入任何 durable history 表；它是 projection runtime 产物

**Primary design sources**:
- `DESIGN.md §3.1, §3.7, §5.1, §5.3, §5.4, §6.3, §10.3, §10.4, §14.8, §14.9, §14.10, §14.15, §14.23, §15.26, §15.27`

### Database Narrative Explanation
- 该数据库不是“对话真值库”，而是 `DESIGN.md` 所要求的 **sidecar**。真值仍然存在于 host history / tool history，sidecar 的职责只有三类：
  1. 保存已经成功生成并通过校验的 result group；
  2. 保存稳定的 visible id 分配映射；
  3. 为 projection 提供可恢复的本地结果状态。
- 这意味着：
  - 不能建 `marks` 真值表，因为 mark 真值来自历史重放；
  - 不能建 `source_snapshots` 真值表，因为 `DESIGN.md` 的目标是按历史与结果组重建可见状态；
  - 不能为旧行为保留兼容表结构，因为用户明确要求一切以 `DESIGN.md` 为准，不兼容旧项目。
- 由于 reminder 的插入位置必须依赖从头到尾的 token 统计与覆盖树演化，本计划锁定：**projection 每次全量 replay**。因此不单独持久化 replay checkpoint，避免引入与真实投影不一致的增量游标。
- 数据库存储的核心实体是：
  - `result_groups`：某个 `markId` 的完整结果组元数据；
  - `result_fragments`：该结果组的顺序片段；
  - `visible_sequence_allocations`：从宿主原始 `id` / canonical id 到我们内部稳定 visible id 的映射；其中 `visible_seq` 为严格递增的 6 位十进制编号，`assigned_visible_id` 的完整格式是 `<visible_kind>_<seq6>_<base62>`。
- 运行时协调不单独落库；由 `src/runtime/file-lock.ts` 与进程内状态承担。这样更贴合“数据库仅保存结果与重放辅助状态”的收敛方向，也避免引入非 design 明示的持久化运行时表。
- `result_fragments` 不再区分 `fragment_kind`。fragment 的定义非常简单：**同一 result group 被原始 gap 打散后的有序替换片段**。gap 本身不入库；projection 在重放原始历史时自然把 gap 补回。

**Primary design sources**:
- `DESIGN.md §1.2, §1.3, §5.1-§5.4, §6.3, §6.4, §10.2, §12.1, §12.3, §14.15, §15.1-§15.5, §15.12, §15.27`

## Locked Plugin API Design
> 本节锁定插件外部合同与插件内部模块接口。执行代理不得把这些接口继续留给实现时拍脑袋决定。

### External Plugin Contract

#### 1) `compression_mark` tool
```ts
type CompressionMarkMode = 'compact' | 'delete'

interface CompressionMarkInputV1 {
  contractVersion: 'v1'
  mode: CompressionMarkMode
  target: {
    startVisibleMessageID: string
    endVisibleMessageID: string
  }
}

interface CompressionMarkSuccess {
  ok: true
  markId: string
}

interface CompressionMarkFailure {
  ok: false
  errorCode:
    | 'INVALID_RANGE'
    | 'DELETE_NOT_ALLOWED'
    | 'OVERLAP_CONFLICT'
    | 'SESSION_NOT_READY'
  message: string
}

type CompressionMarkResult = CompressionMarkSuccess | CompressionMarkFailure
```

Locked behavior:
- 只接受单一 range，不接受批量 range
- `mode='delete'` 时必须先做 delete admission；blocked 则直接返回 `DELETE_NOT_ALLOWED`
- 成功时立即返回随机 `markId`
- mark 真值来自 host/tool history replay；数据库不额外维护 marks 真值表

**Primary design sources**:
- `DESIGN.md §6.1, §6.2, §15.1-§15.5`
- `DESIGN.md §14.5, §15.4`

#### 2) `experimental.chat.messages.transform`
```ts
interface MessagesTransformContext {
  sessionId: string
  inputMessages: HostMessage[]
  outputMessages: HostMessage[]
}

type MessagesTransformHandler = (ctx: MessagesTransformContext) => Promise<void>
```

Locked behavior:
- 必须原地更新 `outputMessages`
- 负责：history replay → mark 树合法性判断 → result-group fallback → visible id/render → reminder 注入/移除
- 不负责：调度模型调用、普通聊天 gate、live transport 执行

**Primary design sources**:
- `DESIGN.md §1.4, §12.4, §12.5, §14.17`
- `DESIGN.md §6.3, §10, §15`

#### 3) `chat.params`
```ts
interface ChatParamsContext {
  sessionId: string
  params: Record<string, unknown>
}

type ChatParamsHandler = (ctx: ChatParamsContext) => Promise<Record<string, unknown>>
```

Locked behavior:
- 只做 narrow scheduling 与必要 runtime metadata 注入
- 不做 projection/rendering
- 不做 messages 改写
- 不做 reminder 输出

**Primary design sources**:
- `DESIGN.md §8.4, §12.4, §14.18`

#### 4) `tool.execute.before`
```ts
interface ToolExecuteBeforeContext {
  sessionId: string
  toolName: string
  toolInput: unknown
}

type ToolExecuteBeforeHandler = (ctx: ToolExecuteBeforeContext) => Promise<void>
```

Locked behavior:
- 用于 send-entry gate 与 DCP/non-DCP 分流
- 非 DCP tool 不阻塞
- 不能在这里做 projection 主流程

**Primary design sources**:
- `DESIGN.md §1.4, §8.2, §8.4, §12.4`

### Internal Module Contracts (Locked)

```ts
interface RuntimeConfigLoader {
  load(sessionId: string): Promise<ResolvedRuntimeConfig>
}

interface PromptResolver {
  resolveReminder(kind: 'soft-compact' | 'soft-delete' | 'hard-compact' | 'hard-delete'): Promise<string>
  resolveCompactionPrompt(): Promise<string>
}

interface CanonicalIdentityService {
  getCanonicalId(message: HostMessage): string
  allocateVisibleId(canonicalId: string, visibleKind: VisibleKind): Promise<VisibleIdAllocation>
}

interface HistoryReplayReader {
  read(sessionId: string): Promise<ReplayedHistory>
}

interface ResultGroupRepository {
  upsertCompleteGroup(input: CompleteResultGroupInput): Promise<void>
  getCompleteGroup(markId: string): Promise<CompleteResultGroup | null>
  listGroupsOverlappingRange(startSeq: number, endSeq: number): Promise<CompleteResultGroup[]>
  allocateVisibleId(input: VisibleIdAllocationInput): Promise<VisibleIdAllocation>
  getVisibleId(canonicalId: string): Promise<VisibleIdAllocation | null>
}

interface VisibleIdAllocation {
  canonicalId: string
  visibleKind: VisibleKind
  visibleSeq: number
  visibleBase62: string
  assignedVisibleId: string
}

interface PolicyEngine {
  buildMarkTree(history: ReplayedHistory): MarkTree
  detectConflicts(tree: MarkTree): ConflictRecord[]
}

interface ReminderService {
  compute(state: ProjectionState): ReminderArtifact[]
}

interface ProjectionBuilder {
  build(input: ProjectionBuildInput): Promise<ProjectedMessageSet>
}

interface CompactionInputBuilder {
  build(input: CompactionBuildInput): Promise<CompactionRequest>
}

interface OutputValidator {
  validate(input: CompactionValidationInput): Promise<ValidatedCompactionOutput>
}

interface SafeTransportAdapter {
  execute(request: CompactionRequest): Promise<TransportResponse>
}

interface CompactionRunner {
  run(input: RunCompactionInput): Promise<RunCompactionResult>
}

interface SendEntryGate {
  waitIfNeeded(sessionId: string): Promise<GateResult>
}

interface ChatParamsScheduler {
  scheduleIfNeeded(sessionId: string): Promise<SchedulerDecision>
}
```

**Primary design sources**:
- `DESIGN.md §5, §7, §8, §10, §12.3, §12.7, §14, §15`

Locked dependency direction:
- `index.ts` → external hook adapters only
- external adapters → `RuntimeConfigLoader` / `SendEntryGate` / `HistoryReplayReader` / `ProjectionBuilder` / `CompactionRunner`
- `ProjectionBuilder` → `HistoryReplayReader` + `PolicyEngine` + `ResultGroupRepository` + `CanonicalIdentityService` + `ReminderService`
- `CompactionRunner` → `CompactionInputBuilder` + `SafeTransportAdapter` + `OutputValidator` + `ResultGroupRepository`
- **禁止反向依赖**：`ResultGroupRepository` 不得依赖 `ProjectionBuilder`；`SafeTransportAdapter` 不得依赖 plugin hook adapter；`ReminderService` 不得依赖 `CompactionRunner`
- **禁止多余持久化仓储接口**：不得新增 replay checkpoint、job state、runtime gate state 的 SQLite 仓储方法

### API Error Model (Locked)
- `INVALID_RANGE`: 输入 range 非法或不可定位
- `DELETE_NOT_ALLOWED`: delete admission 被拒绝
- `OVERLAP_CONFLICT`: later mark 与现有合法树只相交不包含
- `SESSION_NOT_READY`: replay/config/runtime 未就绪
- `TRANSPORT_TIMEOUT`: safe transport 超时
- `INVALID_COMPACTION_OUTPUT`: placeholder 缺失或输出不符合合同
- `RESULT_GROUP_INCOMPLETE`: 数据库出现 fragment 不完整状态
- `LOCK_TIMEOUT`: send-entry gate 等待超时

**Primary design sources**:
- `DESIGN.md §7.3, §8.1, §15.15, §15.18`

### API Narrative Explanation
- 外部 API 的目标不是暴露一套新服务，而是在插件宿主提供的 hook/tool seam 上，严格实现 `DESIGN.md` 规定的行为边界：
  - `compression_mark` 只负责接收 `target.startVisibleMessageID` / `target.endVisibleMessageID` 所指定的单 range 意图，并立即返回 `markId`；
  - `messages.transform` 只负责把“历史 + 结果组”投影成模型可见消息；
  - `chat.params` 只负责狭义调度；
  - `tool.execute.before` 只负责 gate 与 DCP/non-DCP 分流。
- 内部 API 的目标是把插件拆成可组合的设计单元，而不是把业务逻辑继续堆进 `index.ts`：
  - `HistoryReplayReader` 管真值输入；
  - `ResultGroupRepository` 只管 result groups 与 visible-id 映射；
  - `ProjectionBuilder` 管最终可见输出；
  - `CompactionRunner` 管模型执行与结果入库，但不暴露持久化 job 状态仓储；
  - `SendEntryGate` / `ChatParamsScheduler` 管运行时节奏。
- 用户已明确要求：若现有项目的 stub、旧入口、旧依赖方式与这些 API 设计冲突，直接删掉重写，不保留兼容桥。

**Primary design sources**:
- `DESIGN.md §1.4, §6.1-§6.4, §7, §8, §10, §12.4, §12.5, §12.7, §14.17, §14.18, §15`

## Locked E2E Flow Design
> 本节直接定义要实现的 E2E 流程，不是“建议覆盖哪些场景”，而是执行代理必须逐条落地的流程剧本。

### End-to-End Data Flow Explanation
1. 用户或模型通过 `compression_mark` 提交单 range 压缩/删除意图。
2. 该意图进入 host/tool history，成为后续 replay 的唯一真值来源。
3. `HistoryReplayReader` 在 transform 或 compaction 前读取历史，重建 mark 树。
4. `CompactionInputBuilder` 只对当前合法 mark 生成 compaction 输入，并冻结原始区间。
5. `SafeTransportAdapter` 以 hermetic 方式执行模型调用，拿回 compact/delete 输出。
6. `OutputValidator` 校验输出结构、placeholder 与 mode 语义。
7. `ResultGroupRepository` 用单事务把合法输出写成 complete result group；失败则完全不入库。
8. `ProjectionBuilder` 再次从头读取 history + result groups，并结合 `visible_sequence_allocations` 生成最终模型可见消息、visible id 与 reminder artifacts。
9. `SendEntryGate` / `ChatParamsScheduler` 负责运行时等待与狭义调度，但不改写 projection 主语义；其运行时状态不要求落库。
10. E2E 通过 safe transport fixture 验证上述链路；任何 live network、旧兼容分支、旧 schema fallback 都视为违反计划。

**Primary design sources**:
- `DESIGN.md §1.4, §3, §5, §6, §7, §8, §10, §12.4, §12.5, §14, §15`

### Flow A: Compact Success
1. 初始化 `session_alpha` 的 config / prompt / sidecar / lock 环境
2. 通过 `compression_mark` 提交 `mode=compact`、单 range mark，请求返回 `markId`
3. `HistoryReplayReader` 从 host/tool history 重放该 mark
4. `CompactionInputBuilder` 冻结原始区间并生成带 opaque placeholder 的 compaction 输入
5. injected safe transport 返回合法 compact 输出
6. `OutputValidator` 校验 placeholder、mode、结构完整性
7. `ResultGroupRepository` 在单事务内写入 `result_groups` + `result_fragments`
8. `ProjectionBuilder` 从头全量 replay 历史，读取 complete result group，并结合 `visible_sequence_allocations` 完成 fallback/render/visible id/reminder 更新
9. 运行 `node --import tsx --test tests/e2e/compact-success/full-success-path.test.ts`
10. 再运行 `node scripts/run-seam-probe.mjs`，仅验证 load/logging，不替代正确性断言

**Primary design sources**:
- `DESIGN.md §6.2, §6.3, §6.4, §10.2, §12.5, §14.15, §14.17, §15.1-§15.5, §15.12, §15.17, §15.18, §15.27`
- `DESIGN.md §3.1-§3.8, §5.1-§5.4`（reminder 与 visible id 渲染）

### Flow B: Delete Blocked
1. 初始化 `allowDelete=false`
2. 调用 `compression_mark(mode='delete')`
3. 立即返回 `DELETE_NOT_ALLOWED`
4. 数据库不得写入 complete result group
5. projection 不得出现 delete-style replacement
6. 运行 `node --import tsx --test tests/e2e/recovery/delete-admission-matrix.test.ts`

**Primary design sources**:
- `DESIGN.md §6.2, §14.5, §15.4, §15.17`

### Flow C: Delete Allowed
1. 初始化 `allowDelete=true`
2. 调用 `compression_mark(mode='delete')`
3. replay 读取 mark，构建 delete-style compaction 输入
4. safe transport 返回合法 delete-style 输出
5. output validation 通过后，单事务写入 `result_groups.mode='delete'`
6. projection 渲染 delete-style replacement，而不是原文或 compact 文本
7. 运行 `node --import tsx --test tests/e2e/recovery/delete-admission-matrix.test.ts`

**Primary design sources**:
- `DESIGN.md §6.2, §10.2, §14.5, §15.4, §15.17`

### Flow D: Timeout Recovery
1. safe transport 被脚本化为 timeout
2. `CompactionRunner` 返回 timeout 错误并写入日志/证据
3. `result_groups` 不得新增任何行
4. `visible_sequence_allocations` 不得因失败 compaction 发生错误重分配
5. projection 保持原始内容或 child fallback，不得暴露部分替换
6. 运行 `node --import tsx --test tests/e2e/recovery/transport-timeout-recovery.test.ts`

**Primary design sources**:
- `DESIGN.md §7.3, §8.1, §15.18`

### Flow E: Restart During In-flight Compaction
1. compaction 进行到 output validation 前，模拟进程中断
2. 重启后重新初始化 runtime
3. 重新从头读取 host history + sidecar 状态
4. 若无 complete result group，则 projection 只能呈现原始/child fallback 内容
5. 不得出现 partial fragment 可见
6. 运行 `node --import tsx --test tests/e2e/recovery/restart-replay-consistency.test.ts`

**Primary design sources**:
- `DESIGN.md §1.3, §6.4, §8.1, §12.3, §15.5, §15.27`

### Flow F: Gate and Non-DCP Tool Bypass
1. 启动 active compaction lock
2. 普通聊天进入 send path，`SendEntryGate.waitIfNeeded()` 开始等待
3. 非 DCP tool 同时触发，必须直接通过
4. compaction 完成或锁被手动清除后，普通聊天恢复
5. 运行：
   - `node --import tsx --test tests/e2e/runtime/send-entry-gate.test.ts`
   - `node --import tsx --test tests/e2e/runtime/non-dcp-tool-bypass.test.ts`

**Primary design sources**:
- `DESIGN.md §8.1, §8.2, §8.4, §12.4, §14.18`

### Locked E2E File Map
- `tests/e2e/harness/network-deny.test.ts`
- `tests/e2e/harness/safe-transport-fixture.test.ts`
- `tests/e2e/database/schema-bootstrap.test.ts`
- `tests/e2e/database/replay-rebuild.test.ts`
- `tests/e2e/database/result-group-atomicity.test.ts`
- `tests/e2e/database/result-group-idempotency.test.ts`
- `tests/e2e/interfaces/runtime-config-contract.test.ts`
- `tests/e2e/interfaces/prompt-resolution.test.ts`
- `tests/e2e/interfaces/plugin-hooks-contract.test.ts`
- `tests/e2e/interfaces/compression-mark-contract.test.ts`
- `tests/e2e/interfaces/chat-params-narrowing.test.ts`
- `tests/e2e/interfaces/internal-module-contracts.test.ts`
- `tests/e2e/interfaces/no-circular-deps.test.ts`
- `tests/e2e/interfaces/projection-replay-contract.test.ts`
- `tests/e2e/interfaces/visible-sequence-rendering.test.ts`
- `tests/e2e/interfaces/reminder-artifact-behavior.test.ts`
- `tests/e2e/compaction/input-builder-contract.test.ts`
- `tests/e2e/compaction/output-validation.test.ts`
- `tests/e2e/compaction/model-fallback-order.test.ts`
- `tests/e2e/runtime/send-entry-gate.test.ts`
- `tests/e2e/runtime/chat-params-scheduler.test.ts`
- `tests/e2e/runtime/non-dcp-tool-bypass.test.ts`
- `tests/e2e/runtime/missing-transport-config-error.test.ts`
- `tests/e2e/runtime/transport-call-recording.test.ts`
- `tests/e2e/recovery/transport-timeout-recovery.test.ts`
- `tests/e2e/recovery/restart-replay-consistency.test.ts`
- `tests/e2e/recovery/delete-admission-matrix.test.ts`
- `tests/e2e/compact-success/full-success-path.test.ts`

### Locked End-to-End Pass Bar
- 必须先通过分层 E2E：database → interfaces → compaction → runtime → recovery → compact-success
- 最后一次总执行必须是：
```bash
node --import tsx --test tests/e2e/**/*.test.ts && node scripts/run-seam-probe.mjs && npm run typecheck
```
- 若 `run-seam-probe.mjs` 成功但 `tests/e2e/**/*.test.ts` 失败，整体仍判定为失败

**Primary design sources**:
- `DESIGN.md §13.1, §13.4`

- 备注：live verification 仅证明 load/logging/sidecar activity，不等于完整 correctness；完整正确性以自动化 E2E 为准

## Final Design Fidelity Verification
> 本节用于核验“本计划是否完全贴合 `DESIGN.md`”。执行代理开始工作前，必须先逐条通过本节核验；任一项为 NO，则先修计划，不得实现。

### Plan-Level Audit Checklist
- [ ] SQL 设计是否仍然把 host history / tool history 作为 mark 真值源，而非把 SQLite 变成真值库？（`DESIGN.md §6.3, §6.4, §15.1-§15.5`）
- [ ] SQL 设计是否只保留 `schema_meta` / `visible_sequence_allocations` / `result_groups` / `result_fragments`，而未恢复旧 marks/source snapshot 真值表？（`DESIGN.md §1.2, §1.3, §12.3, §12.3A`）
- [ ] API 设计是否严格把 `messages.transform` 作为 projection 主出口，而没有把 `chat.params` 或 `tool.execute.before` 扩展为主投影通道？（`DESIGN.md §12.4, §12.5, §14.17, §14.18`）
- [ ] `compression_mark` 是否仍然是唯一 DCP tool、单 range、即时返回 `markId`？（`DESIGN.md §6.1, §6.2, §15.1-§15.5`）
- [ ] E2E 是否完整覆盖 compact/delete、timeout、restart、gate、non-DCP bypass，而不是只验证 seam probe？（`DESIGN.md §7, §8, §13.1, §15`）
- [ ] 计划是否明确声明：现有代码若与 design 冲突，直接删除/破坏性重写，不做兼容？（用户补充要求 + 本计划 Must NOT Have / Rewrite policy）
- [ ] 计划中的 changelog/cutover 是否仅作为历史解释，而没有被用作覆盖 design 的规范来源？

### Audit Verdict Rule
- 全部为 YES：本计划视为“贴合 `DESIGN.md`”
- 任一为 NO：本计划视为“不贴合 `DESIGN.md`”，必须先修订计划，再允许执行

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. 统一数据库真值边界与文件布局

  **What to do**: 仅基于 `DESIGN.md` 定义 sidecar 的最小职责集合：`schema_meta`、`visible_sequence_allocations`、`result_groups`、`result_fragments`；明确 DB 文件、lock 文件、seam log、debug snapshot 的落位规则，以及 fresh bootstrap / full-replay rebuild / restart recovery 的责任边界。
  **Must NOT do**: 不得恢复旧的 mark/source snapshot 真值表；不得把 `rubbish/` 下路径、旧 tests 或旧 schema 当成现成资产；不得在本任务中实现默认 live executor。

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: 需要收敛文档冲突、持久化边界和恢复语义
  - Skills: `[]` - 无额外技能必需
  - Omitted: `["fast"]` - 该任务需要高精度契约收敛，不能轻量化

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: 2, 6, 10 | Blocked By: none

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/state/sqlite-runtime.ts` - 唯一现存 SQLite runtime adapter，必须复用而非重造运行时桥接
  - Pattern: `src/runtime/file-lock.ts` - 现存锁机制实现，文件布局与并发语义需与之兼容
  - Pattern: `src/runtime/path-safety.ts` - 会话路径与文件落位必须复用该安全边界
  - Pattern: `src/seams/file-journal.ts` - 文件级 JSONL 追加日志能力；用于界定 seam/journal 与 SQLite 的职责分离
  - API/Type: `src/config/runtime-config.schema.json` - 路径、提醒阈值、prompt、模型链配置的正式 schema
  - External: `DESIGN.md` - sidecar、replay、result-group、lock 目标语义
  - Historical: `DESIGN-CHANGELOG2.zh.md` - 仅用于理解旧项目到当前仓库的变化，不是规范来源
  - Historical: `NEW_PROJECT_CUTOVER.zh.md` - 仅用于理解当前仓库为何是 cutover skeleton，不是规范来源

  **Acceptance Criteria** (agent-executable only):
  - [ ] `node --import tsx --test tests/e2e/database/schema-bootstrap.test.ts` 通过，并验证 fresh session 仅创建计划中的 sidecar 表/索引/文件
  - [ ] `node --import tsx --test tests/e2e/database/replay-rebuild.test.ts` 通过，并验证删除 DB 后可由 host-history fixture 全量 replay 重建相同可见结果
  - [ ] `npm run typecheck` 通过，且新增类型未违背现有 `src/state/sqlite-runtime.ts` / `src/runtime/path-safety.ts` 契约

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Fresh bootstrap sidecar layout
    Tool: Bash
    Steps: 1) 准备 fixture `session_alpha`; 2) 运行 `node --import tsx --test tests/e2e/database/schema-bootstrap.test.ts`; 3) 检查 evidence 中列出的 DB/lock/log/debug 文件布局
    Expected: 仅创建设计声明的 SQLite sidecar、lock 和日志路径；不存在 legacy mark/source snapshot 表
    Evidence: .sisyphus/evidence/task-1-db-layout.txt

  Scenario: Replay rebuild after DB removal
    Tool: Bash
    Steps: 1) 先运行写入 fixture；2) 删除 `state/session_alpha.db`; 3) 运行 `node --import tsx --test tests/e2e/database/replay-rebuild.test.ts`
    Expected: 通过全量 replay 恢复相同 result-group/query 输出；无重复行、无部分恢复状态
    Evidence: .sisyphus/evidence/task-1-db-rebuild.txt
  ```

  **Commit**: YES | Message: `feat(db): define sidecar boundaries and layout` | Files: `src/state/**`, `src/runtime/**`, `tests/e2e/database/**`, `DESIGN-aligned docs if needed`

- [x] 2. 设计结果组 schema 与仓储接口

  **What to do**: 定义最小可执行 schema：`schema_meta`、visible id 映射表、result group 主表、fragment 子表；同时详细设计 repository 接口（create/read/list/by-mark-id/idempotent upsert/allocate visible id），并约束“同一 mark id 的结果组必须原子提交，可多 fragment 但不可部分可见”；不得出现 replay checkpoint/job/gate 持久化仓储接口。
  **Must NOT do**: 不得引入旧 mark/source truth 表；不得把 allowDelete 作为 schema 主键语义；不得把 job/event store 泛化成通用平台。

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: schema + repository contract 决定后续 projection/compaction 全部边界
  - Skills: `[]` - 无额外技能必需
  - Omitted: `["fast"]` - 需要精确定义原子性与幂等语义

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: 7, 8, 10, 12 | Blocked By: 1

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/state/sqlite-runtime.ts` - repository 必须建立在现有 prepare/run/get/all 抽象上
  - Pattern: `DESIGN.md` `6.4`, `14.15`, `15.12`, `15.27` - result-group keyed by mark id 与 complete-group 语义
  - Historical: `DESIGN-CHANGELOG2.zh.md` `1`, `3.1`, `5` - 仅帮助理解旧项目到当前仓库的变化
  - Historical: `NEW_PROJECT_CUTOVER.zh.md` - 仅帮助理解旧 schema 已删除的现状
  - Test: `package.json` - 统一通过 Node test runner 执行

  **Acceptance Criteria** (agent-executable only):
  - [ ] `node --import tsx --test tests/e2e/database/result-group-atomicity.test.ts` 通过，验证同一 mark id 失败时零部分可见行
  - [ ] `node --import tsx --test tests/e2e/database/result-group-idempotency.test.ts` 通过，验证重复 replay / duplicate write 不会产生双写
  - [ ] `node --import tsx --test tests/e2e/database/result-group-read-model.test.ts` 通过，验证 fragment 顺序与 group completeness 被正确读取

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Atomic result-group commit
    Tool: Bash
    Steps: 1) 注入 mark `mark_0001`; 2) 在 fragment #2 之前模拟提交失败; 3) 运行 `node --import tsx --test tests/e2e/database/result-group-atomicity.test.ts`
    Expected: 数据库中该 mark id 不可见任何部分 fragment；失败不留下部分结果组
    Evidence: .sisyphus/evidence/task-2-result-group-atomicity.txt

  Scenario: Idempotent replay of same mark result
    Tool: Bash
    Steps: 1) 对同一 fixture 连续执行两次 replay; 2) 运行 `node --import tsx --test tests/e2e/database/result-group-idempotency.test.ts`
    Expected: 最终仅存在一组完整 result group；读模型输出稳定且无重复
    Evidence: .sisyphus/evidence/task-2-result-group-idempotency.txt
  ```

  **Commit**: YES | Message: `feat(db): add result group schema and repositories` | Files: `src/state/**`, `tests/e2e/database/**`

- [x] 3. 搭建 hermetic E2E 测试基座与 network-deny 策略

  **What to do**: 在 `tests/e2e/**` 下建立统一 fixture 规范、session 命名规范、evidence 输出规范、network-deny helper 与 safe transport 注入 helper；确保所有测试通过 Node test runner 执行，且任何未授权网络访问立即失败。
  **Must NOT do**: 不得写 unit tests；不得依赖 Playwright、Cypress、真实网络代理或默认执行器；不得把 `scripts/run-seam-probe.mjs` 直接当成完整 E2E 替代品。

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: 需要构建跨数据库/接口/runtime 的统一测试底座
  - Skills: `[]` - 无额外技能必需
  - Omitted: `["playwright"]` - 当前不是浏览器任务

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: 5, 7, 9, 11 | Blocked By: none

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `package.json` - 现有 `test` script 使用 `node --import tsx --test`
  - Pattern: `tsconfig.json` - `tests/**/*.ts` 已被 include
  - Pattern: `scripts/run-seam-probe.mjs` - 可复用部分 plugin loading / seam log harness 思路，但不是完整测试框架
  - External: `docs/live-verification-with-mitmproxy-and-debug-log.zh.md` - live verification 边界说明：不能把 live session 观察当成完整正确性证明
  - Historical: `.sisyphus/notepads/learnings/2026-04-03_task7-e2e-requires-injected-safe-transport.md` - 仅帮助理解当前仓库验证边界

  **Acceptance Criteria** (agent-executable only):
  - [ ] `node --import tsx --test tests/e2e/harness/network-deny.test.ts` 通过，验证未注入 transport 时任何外部访问被拒绝
  - [ ] `node --import tsx --test tests/e2e/harness/safe-transport-fixture.test.ts` 通过，验证 deterministic fake transport 可注入 scripted success/failure/timeout
  - [ ] `node --import tsx --test tests/e2e/harness/evidence-layout.test.ts` 通过，验证证据输出路径与 session 命名规范一致

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Unauthorized network is denied
    Tool: Bash
    Steps: 1) 不注入 transport; 2) 运行 `node --import tsx --test tests/e2e/harness/network-deny.test.ts`
    Expected: 测试稳定失败于预期配置错误；无外部网络请求发生
    Evidence: .sisyphus/evidence/task-3-network-deny.txt

  Scenario: Safe transport fixture simulates timeout
    Tool: Bash
    Steps: 1) 注入 timeout 脚本化 transport; 2) 运行 `node --import tsx --test tests/e2e/harness/safe-transport-fixture.test.ts`
    Expected: runtime 获得确定性 timeout 错误，且 fixture 记录完整请求/响应轨迹
    Evidence: .sisyphus/evidence/task-3-safe-transport-timeout.txt
  ```

  **Commit**: YES | Message: `test(e2e): add hermetic harness and safe transport fixtures` | Files: `tests/e2e/harness/**`, `tests/helpers/**`, `package.json if needed`

- [x] 4. 收敛 runtime config 与 prompt/runtime 依赖接口

  **What to do**: 基于 `src/config/runtime-config.schema.json` 与现有 prompt 文件，详细设计 runtime-config loader、prompt resolver、path resolution、模型链解析与 delete/reminder 阈值读取接口；定义“缺省值、覆盖顺序、配置错误”契约，并让后续 database/interface/e2e 统一依赖这组接口。
  **Must NOT do**: 不得改变 schema 含义；不得在本任务加入新业务配置面；不得实现与 DESIGN 无关的配置热重载或 UI 配置面板。

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: 主要是已有 schema/prompt 资产上的接口收敛
  - Skills: `[]` - 无额外技能必需
  - Omitted: `["fast"]` - 仍需精确遵守 schema 合同

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: 1, 2, 6, 7, 8, 9 | Blocked By: none

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/config/runtime-config.schema.json` - 配置的正式 schema
  - Pattern: `src/config/runtime-config.jsonc` - 默认配置实例
  - Pattern: `prompts/compaction.md` - compaction prompt contract
  - Pattern: `prompts/reminder-soft-compact-only.md`
  - Pattern: `prompts/reminder-soft-delete-allowed.md`
  - Pattern: `prompts/reminder-hard-compact-only.md`
  - Pattern: `prompts/reminder-hard-delete-allowed.md`
  - Historical: `NEW_PROJECT_CUTOVER.zh.md` - 仅帮助理解当前仓库为何缺少 config loader

  **Acceptance Criteria** (agent-executable only):
  - [ ] `node --import tsx --test tests/e2e/interfaces/runtime-config-contract.test.ts` 通过，验证默认值、覆盖顺序与 schema 校验错误
  - [ ] `node --import tsx --test tests/e2e/interfaces/prompt-resolution.test.ts` 通过，验证四套 reminder prompt 与 compaction prompt 可被正确解析
  - [ ] `npm run typecheck` 通过，验证 loader/resolver 类型契约闭合

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Runtime config precedence resolution
    Tool: Bash
    Steps: 1) 准备默认 jsonc + env override fixture; 2) 运行 `node --import tsx --test tests/e2e/interfaces/runtime-config-contract.test.ts`
    Expected: 最终解析值与 schema 一致；非法值报确定性错误；不回退 silent defaults
    Evidence: .sisyphus/evidence/task-4-runtime-config.txt

  Scenario: Missing reminder prompt path
    Tool: Bash
    Steps: 1) 将 `reminder-soft-compact-only` prompt path 指向不存在文件; 2) 运行 `node --import tsx --test tests/e2e/interfaces/prompt-resolution.test.ts`
    Expected: loader 立即失败并返回可断言错误；不进入模糊 fallback
    Evidence: .sisyphus/evidence/task-4-prompt-resolution-error.txt
  ```

  **Commit**: YES | Message: `feat(interfaces): define runtime config and prompt contracts` | Files: `src/config/**`, `tests/e2e/interfaces/**`

- [x] 5. 定义 injected safe transport 适配器合同

  **What to do**: 详细设计 safe transport adapter 的内部接口：请求输入、脚本化响应、timeout、malformed payload、retryable error、call recording、abort/cancel 语义；明确 compaction runner 只能通过该接口访问模型执行能力，且未注入 transport 时立即报配置错误。
  **Must NOT do**: 不得引入默认 live executor；不得直接耦合外部 provider SDK；不得把 transport 接口扩展成通用 workflow engine。

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: 该合同同时约束 compaction、E2E、错误恢复三条链路
  - Skills: `[]` - 无额外技能必需
  - Omitted: `["fast"]` - 需要清晰定义 failure/timeout/retry 语义

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: 7, 8, 11 | Blocked By: 3

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `scripts/run-seam-probe.mjs` - 现有唯一可运行的 plugin 调用入口，可借鉴注入式执行环境思路
  - Pattern: `prompts/compaction.md` - transport 需支持 compaction 输入/输出合同
  - External: `docs/live-verification-with-mitmproxy-and-debug-log.zh.md` - live verification 不是 correctness 证明，transport 必须 hermetic
  - External: `.sisyphus/notepads/learnings/2026-04-03_task7-e2e-requires-injected-safe-transport.md` - safe transport 必须注入，默认执行器未被证明

  **Acceptance Criteria** (agent-executable only):
  - [ ] `node --import tsx --test tests/e2e/interfaces/safe-transport-contract.test.ts` 通过，验证 request/response/timeout/malformed/retryable error 合同
  - [ ] `node --import tsx --test tests/e2e/runtime/missing-transport-config-error.test.ts` 通过，验证未注入 transport 时 fail-fast
  - [ ] `node --import tsx --test tests/e2e/runtime/transport-call-recording.test.ts` 通过，验证调用记录可用于 E2E 断言

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Missing transport fails fast
    Tool: Bash
    Steps: 1) 不注入 transport; 2) 运行 `node --import tsx --test tests/e2e/runtime/missing-transport-config-error.test.ts`
    Expected: 返回明确配置错误；无 DB 变更、无 network 访问
    Evidence: .sisyphus/evidence/task-5-missing-transport.txt

  Scenario: Malformed payload is captured and rejected
    Tool: Bash
    Steps: 1) 注入返回 malformed payload 的 fake transport; 2) 运行 `node --import tsx --test tests/e2e/interfaces/safe-transport-contract.test.ts`
    Expected: 输出校验失败被稳定捕获；调用记录包含原始 payload 供断言
    Evidence: .sisyphus/evidence/task-5-transport-malformed.txt
  ```

  **Commit**: YES | Message: `feat(interfaces): define safe transport adapter contract` | Files: `src/compaction/**`, `src/runtime/**`, `tests/e2e/interfaces/**`, `tests/e2e/runtime/**`

- [x] 6. 设计插件外部 hook/tool 契约

  **What to do**: 针对 `experimental.chat.messages.transform`、`chat.params`、`tool.execute.before`、`compression_mark` 形成明确外部合同：输入形状、输出形状、错误语义、调用时机、可见副作用、与 replay/result-group/scheduler 的关系；其中 `compression_mark` 的输入字段必须使用 `target.startVisibleMessageID` / `target.endVisibleMessageID`；要求 plugin entry 只是薄适配层，把业务逻辑下沉到内部模块接口。
  **Must NOT do**: 不得把 hook 契约写成实现细节清单；不得让 `chat.params` 承担 projection/rendering 主职责；不得把 `compression_mark` 设计成多范围批处理。

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: 对外合同是整个插件行为边界，必须零歧义
  - Skills: `[]` - 无额外技能必需
  - Omitted: `["fast"]` - 需要覆盖 hook 副作用与错误契约

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: 10, 11, 12 | Blocked By: 1, 3, 4

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/index.ts` - 当前插件入口 stub；注释列出预期 hook surfaces
  - Pattern: `src/seams/noop-observation.ts` - 当前唯一实际接触 hook 形状的实现，应作为 host seam shape 参考
  - Pattern: `src/runtime/chat-params-scheduler.ts` - `chat.params` 目标职责是 narrow scheduling seam，但当前为 TODO
  - Pattern: `src/runtime/send-entry-gate.ts` - ordinary-chat wait gate 与 `tool.execute.before` 关系
  - Pattern: `src/tools/compression-mark.ts` - `compression_mark` 的目标方向说明
  - External: `DESIGN.md` sections on `compression_mark`, projection seam, send-entry gating, chat.params narrowing
  - Historical: `DESIGN-CHANGELOG2.zh.md` - 仅帮助理解旧设计变化，不覆盖 `DESIGN.md`

  **Acceptance Criteria** (agent-executable only):
  - [ ] `node --import tsx --test tests/e2e/interfaces/plugin-hooks-contract.test.ts` 通过，验证插件仅暴露允许的 hook/tool 合同
  - [ ] `node --import tsx --test tests/e2e/interfaces/compression-mark-contract.test.ts` 通过，验证 `mode=compact|delete`、单 range、mark id 返回与 delete admission 错误
  - [ ] `node --import tsx --test tests/e2e/interfaces/chat-params-narrowing.test.ts` 通过，验证 `chat.params` 不承担 projection/rendering 主流程

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: compression_mark compact success
    Tool: Bash
    Steps: 1) 使用 fixture `session_alpha`; 2) 调用 `compression_mark` with `mode=compact` and `target.startVisibleMessageID` / `target.endVisibleMessageID`; 3) 运行 `node --import tsx --test tests/e2e/interfaces/compression-mark-contract.test.ts`
    Expected: 返回确定性 `markId`; mark replay 输入可被后续读取；无多-range 接受
    Evidence: .sisyphus/evidence/task-6-compression-mark-success.txt

  Scenario: compression_mark delete blocked by policy
    Tool: Bash
    Steps: 1) 在 `allowDelete=false` 配置下调用 `compression_mark` with `mode=delete` and visible target range; 2) 运行对应 contract test
    Expected: 返回明确 admission 错误；不写入可消费 mark result intent
    Evidence: .sisyphus/evidence/task-6-compression-mark-delete-blocked.txt
  ```

  **Commit**: YES | Message: `feat(interfaces): define external plugin hook contracts` | Files: `src/index.ts`, `src/runtime/**`, `src/tools/**`, `tests/e2e/interfaces/**`

- [ ] 7. 设计插件内部模块接口图与类型合同

  **What to do**: 详细设计内部模块边界与类型合同：`RuntimeConfigLoader`、`PromptResolver`、`CanonicalIdentityService`、`HistoryReplayReader`、`ResultGroupRepository`、`ProjectionBuilder`、`PolicyEngine`、`ReminderService`、`CompactionInputBuilder`、`CompactionRunner`、`OutputValidator`、`SendEntryGate`、`ChatParamsScheduler`、`SafeTransportAdapter`。为每个模块定义输入/输出、只读/可变职责、错误类型、幂等语义、与其他模块依赖方向。
  **Must NOT do**: 不得形成循环依赖；不得把内部模块接口写成“由实现决定”；不得让 plugin entry 直接串联所有业务逻辑。

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: 用户明确要求“插件内部各模块接口也需要详细设计”
  - Skills: `[]` - 无额外技能必需
  - Omitted: `["fast"]` - 该任务是整个计划的决策完备核心

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: 10, 11, 12 | Blocked By: 2, 3, 4, 5

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/projection/messages-transform.ts` - projection seam 入口
  - Pattern: `src/projection/projection-builder.ts` - 目标 projection 聚合器
  - Pattern: `src/projection/policy-engine.ts` - mark legality/覆盖树/policy 判断
  - Pattern: `src/projection/reminder-service.ts` - reminder 作为 projection artifact 的专用模块
  - Pattern: `src/compaction/input-builder.ts` - compaction 输入构建职责
  - Pattern: `src/compaction/output-validation.ts` - 输出校验与 placeholder 保留职责
  - Pattern: `src/compaction/runner.ts` - compaction 执行协调点
  - Pattern: `src/identity/canonical-identity.ts` - canonical host id helpers 入口
  - Pattern: `src/identity/visible-sequence.ts` - visible id sequence 入口
  - Pattern: `src/runtime/chat-params-scheduler.ts` - narrow scheduling seam
  - Pattern: `src/runtime/send-entry-gate.ts` - ordinary-chat wait gate
  - Pattern: `src/tools/compression-mark.ts` - 外部 tool 与内部 replay/result-group 契约连接点
  - External: `DESIGN.md` sections `5`, `6`, `7`, `8`, `10`, `12`, `14`, `15`
  - Historical: `DESIGN-CHANGELOG2.zh.md` - 仅帮助理解旧设计变化，不覆盖 `DESIGN.md`

  **Acceptance Criteria** (agent-executable only):
  - [ ] `node --import tsx --test tests/e2e/interfaces/internal-module-contracts.test.ts` 通过，验证模块输入输出类型、依赖方向，以及不引入 checkpoint/job/gate 持久化仓储接口
  - [ ] `node --import tsx --test tests/e2e/interfaces/no-circular-deps.test.ts` 通过，验证关键模块不存在循环依赖
  - [ ] `npm run typecheck` 通过，验证合同类型闭合且实现方可按接口编译

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Internal contracts compose end-to-end
    Tool: Bash
    Steps: 1) 使用 fake replay + fake repository + fake transport fixture; 2) 运行 `node --import tsx --test tests/e2e/interfaces/internal-module-contracts.test.ts`
    Expected: ProjectionBuilder 可仅依赖声明接口完成组装；无需直接访问 plugin entry 细节
    Evidence: .sisyphus/evidence/task-7-internal-contracts-compose.txt

  Scenario: Circular dependency is rejected
    Tool: Bash
    Steps: 1) 在 contract test 中构造非法依赖图; 2) 运行 `node --import tsx --test tests/e2e/interfaces/no-circular-deps.test.ts`
    Expected: 测试稳定识别并拒绝循环依赖；依赖方向与计划一致
    Evidence: .sisyphus/evidence/task-7-no-circular-deps.txt
  ```

  **Commit**: YES | Message: `feat(interfaces): define internal module contracts` | Files: `src/**`, `tests/e2e/interfaces/**`

- [ ] 8. 实现历史重放、可见 ID 与 projection 合同

  **What to do**: 基于 history replay 真值模型，设计并实现最小 projection 链路：读取 host/tool history、重放 `compression_mark`、构建合法覆盖树、按 result-group fallback 生成 projection、通过 visible-id 映射生成稳定 `type_000001_base62` 风格 ID、渲染 assistant/tool/reminder 的可见 ID。确保 reminder 是 projection artifact，不进入 durable host history。
  **Must NOT do**: 不得让 SQLite 成为 mark/source truth；不得对 compact result 进行内部再压缩；不得让 reminder 消耗 message-layer visible-id sequence。

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: replay/projection/visible-id 是设计合同中心链路
  - Skills: `[]` - 无额外技能必需
  - Omitted: `["fast"]` - 该任务对 DESIGN 契约敏感度最高

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 10, 12 | Blocked By: 2, 5, 7

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/projection/messages-transform.ts` - transform seam 实现入口
  - Pattern: `src/projection/projection-builder.ts` - projection 组装器
  - Pattern: `src/projection/policy-engine.ts` - 覆盖树、冲突 mark、fallback 规则
  - Pattern: `src/projection/reminder-service.ts` - reminder 阈值、锚点与 artifact 语义
  - Pattern: `src/identity/canonical-identity.ts` - canonical host ID 解析
  - Pattern: `src/identity/visible-sequence.ts` - visible sequence 与 render-only prefix 语义
  - Pattern: `src/token-estimation.ts` - compressible token 计数与 reminder cadence 计算基础
  - External: `DESIGN.md` sections `2`, `3`, `5`, `6.3`, `10`, `14`, `15`
  - Historical: `DESIGN-CHANGELOG2.zh.md` sections on replay tree / compact-delete convergence / token metrics，仅作变化背景

  **Acceptance Criteria** (agent-executable only):
  - [ ] `node --import tsx --test tests/e2e/interfaces/projection-replay-contract.test.ts` 通过，验证 mark 重放、覆盖树与 fallback 逻辑
  - [ ] `node --import tsx --test tests/e2e/interfaces/visible-sequence-rendering.test.ts` 通过，验证 visible id 稳定、assistant/tool/reminder 渲染规则
  - [ ] `node --import tsx --test tests/e2e/interfaces/reminder-artifact-behavior.test.ts` 通过，验证 reminder 阈值、锚点、删除后消失与“不入 durable history”

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Parent mark missing result falls back to child result
    Tool: Bash
    Steps: 1) 构造 parent/child marks fixture; 2) 仅为 child mark 写入完整 result group; 3) 运行 `node --import tsx --test tests/e2e/interfaces/projection-replay-contract.test.ts`
    Expected: projection 使用 child result + original gaps fallback；无非法 partial parent replacement
    Evidence: .sisyphus/evidence/task-8-projection-fallback.txt

  Scenario: Reminder disappears after successful replacement
    Tool: Bash
    Steps: 1) 构造跨越 `hsoft` 的 compressible fixture; 2) 先验证 reminder 出现; 3) 写入成功 result group 后重放; 4) 运行 `node --import tsx --test tests/e2e/interfaces/reminder-artifact-behavior.test.ts`
    Expected: 被成功替换窗口内的旧 reminder 从 projection 中移除；host history 不被修改
    Evidence: .sisyphus/evidence/task-8-reminder-disappears.txt
  ```

  **Commit**: YES | Message: `feat(interfaces): add replay projection and visible id contracts` | Files: `src/projection/**`, `src/identity/**`, `tests/e2e/interfaces/**`

- [ ] 9. 收敛 compaction 输入、输出校验与 runner 接口

  **What to do**: 设计并实现 `CompactionInputBuilder`、`OutputValidator`、`CompactionRunner` 的详细接口：输入消息冻结、opaque placeholder 保留、delete/compact 模式切换、同模型重试与 `compactionModels` fallback 顺序、成功/失败后的 result-group 写入规则，以及 invalid output / malformed payload / timeout 时的状态保持策略。
  **Must NOT do**: 不得让 compaction runner 直接修改 host history；不得接受缺失 placeholder 的 compact 输出；不得在失败后留下部分 result-group 可见状态。

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: compaction 是 result-group、transport、projection 之间的关键协调点
  - Skills: `[]` - 无额外技能必需
  - Omitted: `["fast"]` - 需要精确覆盖 retry/fallback/validation 语义

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 11, 12 | Blocked By: 3, 4, 6, 7, 8

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/compaction/input-builder.ts` - compaction 输入边界
  - Pattern: `src/compaction/output-validation.ts` - 输出合法性校验点
  - Pattern: `src/compaction/runner.ts` - 执行/重试/fallback 协调点
  - Pattern: `prompts/compaction.md` - `executionMode` / `allowDelete` / placeholder contract
  - Pattern: `src/config/runtime-config.schema.json` - `compactionModels` 与相关配置来源
  - External: `DESIGN.md` sections `7`, `10.2`, `15.17`, `15.18`
  - Historical: `DESIGN-CHANGELOG2.zh.md` sections `5`, `6`, `8`，仅作变化背景

  **Acceptance Criteria** (agent-executable only):
  - [ ] `node --import tsx --test tests/e2e/compaction/input-builder-contract.test.ts` 通过，验证冻结输入与 placeholder 保留
  - [ ] `node --import tsx --test tests/e2e/compaction/output-validation.test.ts` 通过，验证 invalid output / malformed payload 被拒绝
  - [ ] `node --import tsx --test tests/e2e/compaction/model-fallback-order.test.ts` 通过，验证同模型重试与 fallback 顺序

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Placeholder omission is rejected
    Tool: Bash
    Steps: 1) 构造含 opaque placeholder 的 compaction input; 2) 注入漏掉 placeholder 的响应; 3) 运行 `node --import tsx --test tests/e2e/compaction/output-validation.test.ts`
    Expected: 输出被拒绝；不写入 result group；保留原 projection
    Evidence: .sisyphus/evidence/task-9-placeholder-rejected.txt

  Scenario: Model fallback after retry exhaustion
    Tool: Bash
    Steps: 1) 让主模型连续返回 invalid output; 2) 次模型返回合法 compact 输出; 3) 运行 `node --import tsx --test tests/e2e/compaction/model-fallback-order.test.ts`
    Expected: 先完成同模型重试，再按配置顺序 fallback；最终仅成功模型结果入库
    Evidence: .sisyphus/evidence/task-9-model-fallback.txt
  ```

  **Commit**: YES | Message: `feat(compaction): define input validation and runner contracts` | Files: `src/compaction/**`, `tests/e2e/compaction/**`

- [ ] 10. 实现 send-entry gate 与 chat.params 调度接口

  **What to do**: 详细设计并实现 `SendEntryGate` 与 `ChatParamsScheduler` 的责任分离：ordinary chat 在 active compaction lock 下的等待/超时/手动解锁退出；`chat.params` 仅做 narrow scheduling 与必要 runtime metadata 注入；非 DCP tool 不阻塞；active batch 冻结 mark 集，新增 mark 延迟到下一批。
  **Must NOT do**: 不得让 `chat.params` 负责 projection/rendering；不得让普通聊天永久阻塞；不得在非 DCP tool 路径上错误阻塞。

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: gate/scheduler 是 runtime 行为正确性的高风险边界
  - Skills: `[]` - 无额外技能必需
  - Omitted: `["fast"]` - 需要显式定义等待退出与冻结时机

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 12 | Blocked By: 1, 2, 6, 7, 8

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/runtime/send-entry-gate.ts` - ordinary-chat wait gate 入口
  - Pattern: `src/runtime/chat-params-scheduler.ts` - narrow scheduling seam
  - Pattern: `src/runtime/file-lock.ts` - 锁获取、观察、手动清除、超时行为基础
  - Pattern: `src/seams/noop-observation.ts` - `chat.params` 与 `tool.execute.before` 当前观察形状
  - External: `DESIGN.md` sections `8`, `12.4`, `14.18`
  - Historical: `NEW_PROJECT_CUTOVER.zh.md` - 仅帮助理解当前仓库为何缺少旧 send path/runtime 逻辑

  **Acceptance Criteria** (agent-executable only):
  - [ ] `node --import tsx --test tests/e2e/runtime/send-entry-gate.test.ts` 通过，验证 active lock 下普通聊天等待/退出语义
  - [ ] `node --import tsx --test tests/e2e/runtime/chat-params-scheduler.test.ts` 通过，验证 `chat.params` 只负责 narrow scheduling
  - [ ] `node --import tsx --test tests/e2e/runtime/non-dcp-tool-bypass.test.ts` 通过，验证非 DCP tool 不受 gate 阻塞

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Ordinary chat waits then resumes after compaction success
    Tool: Bash
    Steps: 1) 启动 active compaction lock; 2) 触发普通聊天 send path; 3) compaction 完成并释放锁; 4) 运行 `node --import tsx --test tests/e2e/runtime/send-entry-gate.test.ts`
    Expected: 普通聊天被等待而非拒绝；锁释放后继续；无重复发送
    Evidence: .sisyphus/evidence/task-10-send-gate-resume.txt

  Scenario: Non-DCP tool bypasses gate during active lock
    Tool: Bash
    Steps: 1) 保持 active lock; 2) 触发非 DCP tool path; 3) 运行 `node --import tsx --test tests/e2e/runtime/non-dcp-tool-bypass.test.ts`
    Expected: 非 DCP tool 正常执行；不等待 compaction；无误阻塞
    Evidence: .sisyphus/evidence/task-10-non-dcp-bypass.txt
  ```

  **Commit**: YES | Message: `feat(runtime): add send gate and narrow scheduler contracts` | Files: `src/runtime/**`, `tests/e2e/runtime/**`

- [ ] 11. 打通失败恢复、重启重放与删除准入 E2E

  **What to do**: 在 hermetic safe transport 下实现 failure-path E2E：transport timeout、malformed output、retry 后成功、restart during in-flight compaction、delete admission blocked/allowed、stale lock/manual unlock；确保失败不会前移错误 watermark、不会留下 partial result group、不会错误修改 projection。
  **Must NOT do**: 不得把失败恢复做成人工步骤；不得允许 stale lock 永远悬挂；不得在 delete blocked 时仍返回成功 result。

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: 该任务覆盖最复杂的 failure-path matrix
  - Skills: `[]` - 无额外技能必需
  - Omitted: `["playwright"]` - 当前仍非浏览器任务

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 12 | Blocked By: 3, 5, 6, 7, 9

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/runtime/file-lock.ts` - stale lock / manual clear / wait-settle 行为基础
  - Pattern: `src/compaction/runner.ts` - in-flight compaction 恢复与失败状态收敛点
  - Pattern: `src/compaction/output-validation.ts` - malformed/invalid output 失败语义
  - Pattern: `src/tools/compression-mark.ts` - delete admission contract
  - External: `DESIGN.md` sections on delete admission, lock release, restart/replay recovery
  - Historical: `DESIGN-CHANGELOG2.zh.md` - 仅帮助理解 delete admission 语义变化背景

  **Acceptance Criteria** (agent-executable only):
  - [ ] `node --import tsx --test tests/e2e/recovery/transport-timeout-recovery.test.ts` 通过，验证 timeout 不产生错误成功状态
  - [ ] `node --import tsx --test tests/e2e/recovery/restart-replay-consistency.test.ts` 通过，验证进程重启后 projection/result-group 一致
  - [ ] `node --import tsx --test tests/e2e/recovery/delete-admission-matrix.test.ts` 通过，验证 delete blocked/allowed 的全部矩阵

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Restart during in-flight compaction
    Tool: Bash
    Steps: 1) 启动 compaction 并在 result validation 前中断进程; 2) 重启 runtime; 3) 运行 `node --import tsx --test tests/e2e/recovery/restart-replay-consistency.test.ts`
    Expected: 重启后不会暴露 partial result group；可从完整 history + sidecar 一致恢复
    Evidence: .sisyphus/evidence/task-11-restart-replay.txt

  Scenario: Delete admission blocked matrix
    Tool: Bash
    Steps: 1) 分别以 `allowDelete=false/true` 运行 delete mark fixture; 2) 运行 `node --import tsx --test tests/e2e/recovery/delete-admission-matrix.test.ts`
    Expected: blocked 时稳定报 admission error；allowed 时正确进入 delete-style result path
    Evidence: .sisyphus/evidence/task-11-delete-admission-matrix.txt
  ```

  **Commit**: YES | Message: `test(e2e): add recovery and delete admission scenarios` | Files: `tests/e2e/recovery/**`, `src/runtime/**`, `src/compaction/**`, `src/tools/**`

- [ ] 12. 打通首条完整成功路径 E2E 与 seam probe 收口

  **What to do**: 基于前述数据库、接口、projection、compaction、runtime gate 任务，完成首条完整成功路径：`compression_mark` → history replay → compaction input → safe transport success → output validation → atomic result-group persist → projection update → seam probe 验证 plugin load / seam logging。将该路径作为“数据库 + 接口 + E2E”三大目标的最终收口。
  **Must NOT do**: 不得将 seam probe 视为唯一正确性证明；不得跳过前序 contract/E2E 测试直接只跑 happy path；不得启用 live network。

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: 最终收口任务跨越所有子系统
  - Skills: `[]` - 无额外技能必需
  - Omitted: `["fast"]` - 需要完整端到端一致性，而非快速局部闭环

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: F1-F4 | Blocked By: 2, 6, 8, 9, 10, 11

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/index.ts` - plugin entry 需要从 stub 收口为薄适配层
  - Pattern: `scripts/run-seam-probe.mjs` - plugin loading / seam logging 验证入口
  - Pattern: `src/seams/noop-observation.ts` - hook 执行期日志/观察字段参考
  - Pattern: `src/seams/file-journal.ts` - seam log JSONL 写入机制
  - Pattern: `src/projection/**`, `src/compaction/**`, `src/runtime/**`, `src/tools/**`, `src/state/**` - 所有前序接口任务输出
  - External: `docs/live-verification-with-mitmproxy-and-debug-log.zh.md` - seam probe 与 live verification 的正确边界

  **Acceptance Criteria** (agent-executable only):
  - [ ] `node --import tsx --test tests/e2e/compact-success/full-success-path.test.ts` 通过，验证 mark→compaction→persist→projection 全链路
  - [ ] `node scripts/run-seam-probe.mjs` 通过，验证 plugin load 与 seam logging 正常
  - [ ] `node --import tsx --test tests/e2e/**/*.test.ts` 全绿，且无 live network

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Full success path from mark to projection update
    Tool: Bash
    Steps: 1) 启动 safe transport fixture 返回合法 compact 结果; 2) 调用 `compression_mark`; 3) 运行 `node --import tsx --test tests/e2e/compact-success/full-success-path.test.ts`
    Expected: 生成完整 result group；projection 更新为替换后内容；visible id 与 reminder 行为符合合同
    Evidence: .sisyphus/evidence/task-12-full-success-path.txt

  Scenario: Seam probe confirms load/logging without claiming correctness alone
    Tool: Bash
    Steps: 1) 运行 `node scripts/run-seam-probe.mjs`; 2) 检查 seam log 输出与 plugin load 结果; 3) 将结果与 full-success-path 测试证据对照
    Expected: seam probe 成功仅证明 load/logging；完整正确性仍以 e2e 套件为准
    Evidence: .sisyphus/evidence/task-12-seam-probe.txt
  ```

  **Commit**: YES | Message: `feat(e2e): wire full success path and seam probe verification` | Files: `src/index.ts`, `src/**`, `tests/e2e/**`, `scripts/run-seam-probe.mjs if needed`

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [ ] F1. Plan Compliance Audit — oracle
- [ ] F2. Code Quality Review — unspecified-high
- [ ] F3. Real Manual QA — unspecified-high（本计划中以 agent-executed manual-style QA 方式执行；当前无 UI，不使用 Playwright）
- [ ] F4. Scope Fidelity Check — deep

## Commit Strategy
- 使用小步可中断提交；每个任务默认一提交，必要时 1-2 个相邻任务合并，但不得跨 wave 合并
- commit message 统一采用 `type(scope): desc`
- 推荐顺序：schema/contracts → interfaces → transport/harness → projection/compaction/gate → e2e scenarios → final verification fixes

## Success Criteria
- 计划执行后，仓库具备与 `DESIGN.md` 一致的数据库侧边车与接口边界，而不是继续停留在 cutover stub 状态
- 所有关键行为均可通过 `tests/e2e/**` 与 `run-seam-probe.mjs` 自动验证，无需人工操作
- safe transport 是唯一测试执行通道；任何 live network 访问都会被视为失败
- 插件外部合同与内部模块合同均被具体化到实现级别，执行代理无须再做体系结构判断
