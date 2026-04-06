# 代码审计：当前实现与 `DESIGN.md` 的偏差清单（2026-04-06）

本文档汇总 2026-04-06 对当前仓库进行的全量代码审计结果。

目标不是列出所有风格意见，而是聚焦三类问题：

1. **不符合 `DESIGN.md` 的实现**
2. **工程上不合理、容易制造假信心的实现/契约面**
3. **照着当前实现写的伪测试 / harness 自证测试**

本文只记录已经过源码复读确认的问题，不记录纯猜测项。

---

## 审计结论总览

- 当前仓库**不是完全偏离设计**；例如 reminder prompt matrix、legacy reminder counter 字段 fail-fast、`messages.transform` 原地 materialize 等点与 `DESIGN.md` 对齐。
- 但当前 shipped path 仍存在数个**设计级偏差**，其中至少 4 个应视为 **blocker**：
  - replacement 渲染边界错误
  - 默认 runtime 未接入真正的 send-entry gate
  - scheduler readiness 仍按 mark 数量而不是 marked tokens
  - `allowDelete` 泄漏到了 replay / compaction execution 阶段
- 测试层面存在明显的 **fake confidence**：多处测试验证的是内部 helper 图、contract 常量、fixture 行为或当前实现细节，而不是 `DESIGN.md` 规定的真实外部契约。

---

## A. Blocker：已确认违反 `DESIGN.md` 的实现

### A1. replacement 渲染只抑制 mark source message，没有接管整个 source span

- **文件**：`src/projection/rendering.ts`
- **证据**：
  - `renderMarkNode()` 在存在 `resultGroup` 时，仍然通过 `renderOriginalRange()` 把 fragment 前后的原文 gap 继续渲染出来（`src/projection/rendering.ts:131-155`）
  - `collectSuppressedCanonicalIds()` 只加入 `node.sourceMessageId`，而不是被 replacement 接管的 canonical source messages（`src/projection/rendering.ts:217-225`）
- **问题说明**：
  当前代码抑制的是 mark tool 自身的 source message，而不是整个被 replacement 接管的 source span。这样会把“replacement 已生效”和“原始 source 仍部分可见”混在一起，边界错位。
- **为何不符合 design**：
  `DESIGN.md` 要求 replacement 结果组接管原始范围，接管后原始 source span 在 projection 中隐藏，随后再删除已消费的 mark tool 调用。当前实现把“删 mark tool 调用”和“隐藏被替换范围”混成了一件事。
- **对应 DESIGN 章节**：
  - §6.3 Mark 与 Replacement 的关系
  - §10.2 Replacement 渲染
  - §10.3 Mark Tool 调用删除
  - §15.10 渲染规则：有结果先吃自己，否则递归子节点，否则回原文
  - §15.26 替换与 tool 调用删除：以 mark id 为键

### A2. 默认 shipped runtime 没有真正接入 send-entry gate

- **文件**：
  - `src/runtime/default-plugin-services.ts`
  - `src/runtime/send-entry-gate.ts`
  - `src/runtime/plugin-hooks.ts`
- **证据**：
  - 默认 runtime wiring 里 `toolExecutionGate.beforeExecution()` 永远返回 `{ blocked: false }`（`src/runtime/default-plugin-services.ts:32-39`）
  - 真正的 file-lock-backed gate 实现在 `createFileLockBackedSendEntryGate()` 中存在，但默认 wiring 未使用（`src/runtime/send-entry-gate.ts:133-149`）
  - hooks 只把传入的 `toolExecutionGate` 包到 `tool.execute.before`，并没有额外接入 send-entry wait 逻辑（`src/runtime/plugin-hooks.ts:52-82`）
- **问题说明**：
  仓库里有 gate 实现，但默认 shipped path 没有把它接进真正的 runtime。结果就是“设计要求存在的行为”只存在于 helper/test 层，不存在于默认装配。
- **为何不符合 design**：
  `DESIGN.md` 明确要求普通对话等待发生在真正进入 send path 之前的 send-entry gate，而不是只保留一个 seam 名义上存在。
- **对应 DESIGN 章节**：
  - §8.2 阻塞范围
  - §8.4 普通对话等待入口
  - §12.4 模块职责边界
  - §12.7 参考模块职责（`send-entry-gate`）
  - §14.18 `chat.params` 只是窄调度缝

### A3. scheduler readiness 仍按 mark 数量，不按 marked-token readiness

- **文件**：`src/runtime/chat-params-scheduler.ts`
- **证据**：
  - `collectEligibleMarkIds()` 先 `flattenMarkIds(tree.marks)`，然后用 `eligibleMarkIds.length >= threshold` 决定是否 eligible（`src/runtime/chat-params-scheduler.ts:393-398`）
  - 这里的 threshold 来自 `schedulerMarkThreshold`，没有按 unresolved marked token 总量计算 readiness（`src/runtime/chat-params-scheduler.ts:394-397`）
- **问题说明**：
  当前实现把“有多少个 mark”当成 readiness 口径，而不是“这些有效 mark 范围里还有多少未压原始 token”。这会让调度语义和 DESIGN 明确分离后的阈值模型不一致。
- **为何不符合 design**：
  `DESIGN.md` 已经把 `schedulerMarkThreshold` 明确降级为 internal/test compatibility 参数，真正 readiness 必须由 `markedTokenAutoCompactionThreshold` 决定。
- **对应 DESIGN 章节**：
  - §1.5 端到端示例
  - §7.1 触发条件
  - §9.2 字段清单
  - §9.3 Env 覆盖（阈值区分）
  - §14.24 `schedulerMarkThreshold` 与 Marked-Token 阈值分离
  - §15.22 token 统计口径之一：当前有效 mark 的“未压原始 token”
  - §15.23 树上的 token 向上传播规则
  - §15.24 token 统计口径之二：最终实际 prompt 负载

### A4. `allowDelete` 泄漏到 replay / compaction execution 阶段

- **文件**：`src/compaction/replay-run-input.ts`
- **证据**：
  - `const allowDelete = options.allowDelete ?? markNode.mode === "delete";`（`src/compaction/replay-run-input.ts:32-42`）
- **问题说明**：
  这让一个历史上已经合法创建并留下 `mode="delete"` 的 mark，在后续 replay/build compaction input 时仍然受当前 runtime `allowDelete` 影响。也就是说，admission 期的 gate 被带到了执行期。
- **为何不符合 design**：
  `DESIGN.md` 明确要求 `allowDelete` 只在 mark tool 调用被接受时作为 admission gate 生效；一旦调用已经被接受，后续历史解释依赖 `mode`，而不是继续读当前 gate 位。
- **对应 DESIGN 章节**：
  - §4.3 控制来源
  - §14.5 `allowDelete` 是 delete admission gate，不是 route 枚举
  - §15.4 `mode` 与 `allowDelete` 的职责分离
  - §15.21 不允许“delete 预订未来 compact 结果”

---

## B. Should-fix：高疑似不合理或 operator-facing contract drift

### B1. 顶层 runtime config 仍公开 `allowDelete`

- **文件**：
  - `src/config/runtime-config.ts`
  - `src/config/runtime-config.jsonc`
  - `src/config/runtime-config.schema.json`
- **证据**：
  - `LoadedRuntimeConfig`、默认值、root key 白名单都包含 `allowDelete`（`src/config/runtime-config.ts:87-120, 135-178, 323-329`）
  - canonical JSONC 直接写了 `"allowDelete": false`（`src/config/runtime-config.jsonc:7-9`）
  - schema 把 `allowDelete` 描述为 runtime delete-admission gate（`src/config/runtime-config.schema.json:23-26`）
- **问题说明**：
  即使从实现角度 `allowDelete` 现在被用作 admission gate，它仍以 operator-facing 顶层配置项公开存在，会持续诱导人把它当“稳定根级路由开关”理解。
- **为何不符合 design**：
  `DESIGN.md` 已经把旧 route/config 思维收窄，尤其强调它不应再作为根级 runtime route 概念存在。
- **对应 DESIGN 章节**：
  - §4.3 控制来源
  - §9.4 与旧配置面的映射（`allowDelete` / route 重构）
  - §14.5 `allowDelete` 是 delete admission gate，不是 route 枚举

### B2. compaction prompt 被称作模板，但 loader 不验证模板契约

- **文件**：
  - `prompts/compaction.md`
  - `src/config/runtime-config.ts`
- **证据**：
  - 文案称 runtime 会注入 `executionMode` 和 `allowDelete` 指令（`prompts/compaction.md:16-23`）
  - loader 对 `templateMode: "template"` 只检查“文件存在且非空”，没有做任何 placeholder / structure contract 校验（`src/config/runtime-config.ts:243-246, 424-457`）
- **问题说明**：
  现在“模板”在实现上更像“普通文本说明文件”。只要文件存在且非空，loader 就认定健康，无法 fail fast 地发现模板契约已损坏。
- **为何不符合 design**：
  DESIGN 把 `compaction.md` 定义成 system prompt 模板，运行时要向其注入删除许可与执行模式指令。当前 loader 没有把“模板”当模板校验。
- **对应 DESIGN 章节**：
  - §11.1 压缩 Prompt（System Prompt 模板）
  - §11.4 Prompt 文件的硬约束
  - §14.12 压缩 Prompt 是模板

### B3. replay helper 以“删库重建 sidecar”的 API 形状出现，容易越过 truth boundary

- **文件**：`src/state/sidecar-store/replay.ts`
- **证据**：
  - `replaceReplayDerivedData()` 在事务里先 `DELETE FROM result_fragments/result_groups/visible_sequence_allocations`，再重新插入 replayState（`src/state/sidecar-store/replay.ts:23-38`）
- **问题说明**：
  这大概率是 test/replay helper，但 API 形状是在“从 replay state 重建 sidecar durable data”。这很容易让 sidecar 被误用成 replay-derived cache，而不是 durable sidecar truth。
- **为何可疑**：
  DESIGN 强调 SQLite 是 sidecar state，不是可随 replay 整体抹掉再重建的平行 transcript。即便这是测试 helper，它的 API 语义仍然不健康。
- **对应 DESIGN 章节**：
  - §1.2 SQLite 是侧车，不是第二套会话
  - §12.1 四个操作员可见规则
  - §12.3 侧车存储原则
  - §15.5A 为什么当前实现倾向于每轮全量 replay

### B4. 错误 mark 调用在 replay 模型中被直接丢弃，而不是作为普通可见错误消息保留

- **文件**：
  - `src/history/history-replay-reader.ts`
  - `src/runtime/session-history.ts`
- **证据**：
  - `replayHistoryFromSources()` 对 `entry.result.ok !== true` 直接 `return []`（`src/history/history-replay-reader.ts:139-155`）
  - session-history 在 input parse 失败、result deserialize 失败时也直接跳过（`src/runtime/session-history.ts:120-144`）
- **问题说明**：
  这会把错误 mark 调用直接从 replay 结构里抹掉，而不是保留为“已退出 mark 语义系统、但仍是普通可见错误消息”的对象。
- **为何不符合 design**：
  DESIGN 区分“合法但尚无结果的 mark”和“错误 tool 调用”。后者应作为普通错误消息留在最终可见世界里，而不是在 replay 期默默消失。
- **对应 DESIGN 章节**：
  - §15.15 错误 tool 调用的最终视图语义
  - §15.16 错误消息仍是普通可见消息
  - §15.38 旧章节中需要按本章重解释的条目（第 4 点）

### B5. transport transcript 仍保留 `hostMessageId` / `canonicalMessageId` 双字段旧影子

- **文件**：`src/compaction/replay-run-input.ts`
- **证据**：
  - transcript entry 同时写 `hostMessageId` 与 `canonicalMessageId`，且两者都取 `message.canonicalId`（`src/compaction/replay-run-input.ts:86-93`）
- **问题说明**：
  这不是立刻的功能错误，但会制造“是否存在两套身份”的误导，尤其在 DESIGN 已经收敛 canonical identity 口径之后。
- **对应 DESIGN 章节**：
  - §5.5 Canonical Message Identifier 的选择规则
  - §15.38 旧章节中需要按本章重解释的条目（identity / lookup 心智收敛）

### B6. reminder 文案选择完全依赖当前 runtime `allowDelete`，会让 replay 视图受当前配置影响

- **文件**：
  - `src/projection/reminder-service.ts`
  - `src/runtime/default-messages-transform.ts`
- **证据**：
  - reminder kind 在 compute 时只看 `options.allowDelete`（`src/projection/reminder-service.ts:86-89, 117-126`）
  - default projector 把 `runtimeConfig.allowDelete` 直接注入 configured reminder service（`src/runtime/default-messages-transform.ts:60-77`）
- **问题说明**：
  如果 `allowDelete` 被视为“当前全局运行策略”，这在实现上说得通；但它也意味着相同 canonical history + 相同 sidecar 状态，只因当前 runtime config 改变，就可能生成不同 reminder wording。
- **为何可疑**：
  DESIGN 一方面要求 severity × `allowDelete` 提示矩阵，另一方面又强调 projection 的确定性。当前实现至少需要更明确地承认这是“当前策略驱动”，否则会削弱 deterministic projection 的心智模型。
- **对应 DESIGN 章节**：
  - §1.2 投影是确定性的
  - §3.8 Reminder Prompt 文件
  - §3.9 allowDelete 对 Reminder 的影响
  - §12.1 投影是确定性的

---

## C. Test debt：照着实现写的伪测试 / harness 自证测试

### C1. `internal-module-contracts.test.ts` 基本是在验证仓库自述而不是设计契约

- **文件**：`tests/e2e/interfaces/internal-module-contracts.test.ts`
- **问题说明**：
  该测试直接 import `*_INTERNAL_CONTRACT` 常量，断言模块名、依赖方向、导出方法名、静态 gate/scheduler 响应，以及由同一套内部 services 拼出的 projection 文本。代码和这些 contract 常量一起改，测试仍可保持绿色。
- **为何是伪测试**：
  它主要证明“仓库自己描述自己时前后一致”，而不是证明 `DESIGN.md` 的外部行为契约真的成立。
- **对应 DESIGN 章节**：
  - §1.2 宿主历史是唯一真相源 / 投影是确定性的
  - §12.4 模块职责边界
  - §12.7 参考模块职责
  - §13.4 Truth Boundary 的操作含义

### C2. `full-success-path.test.ts` 复用内部 builder 图构造预期，难以充当独立 oracle

- **文件**：`tests/e2e/compact-success/full-success-path.test.ts`
- **问题说明**：
  该测试把 projection builder、identity service、repository、runner、transport、mark tool 全部自己拼起来，再断言 exact transcript、exact stored rows、exact referable visible-id regex。它对当前内部图的回归值很高，但对 design drift 的独立约束较弱。
- **更严重的点**：
  它断言 after-commit projection 只剩三条消息（`tests/e2e/compact-success/full-success-path.test.ts:235-247`），这正好顺着当前 rendering 边界的实现走，而没有独立地约束“replacement 接管整个 source span”的 design 语义。
- **为何是伪测试**：
  它在很大程度上是“用实现自己的 helper 计算期待，再让实现通过自己的期待”。
- **对应 DESIGN 章节**：
  - §6.3 Mark 与 Replacement 的关系
  - §10.2 Replacement 渲染
  - §10.3 Mark Tool 调用删除
  - §13.4 Truth Boundary 的操作含义

### C3. `transport-call-recording.test.ts` 主要证明 scripted transport fixture 会记录调用

- **文件**：`tests/e2e/runtime/transport-call-recording.test.ts`
- **问题说明**：
  该测试大量断言 exact request object、sequenceNumber、signalState、opaquePlaceholderSlot 等 recorder 细节，核心上是在验证 scripted transport / request builder / recorder 的当前形状。
- **为何是伪测试**：
  它不能证明 compaction 在真实 seam 上对 projection / sidecar / replay 的 design 语义是正确的，只能证明 harness 记录下了当前实现发出的请求。
- **对应 DESIGN 章节**：
  - §7.4 Compaction Input Builder 与 Projection Builder 的分离
  - §12.6 Compaction Transport 的边界
  - §13.4 Truth Boundary 的操作含义

### C4. `chat-params-narrowing.test.ts` 直接验证 exported contract 文案与 JSON 字符串表面

- **文件**：`tests/e2e/interfaces/chat-params-narrowing.test.ts`
- **问题说明**：
  它直接断言 `CHAT_PARAMS_EXTERNAL_CONTRACT.visibleSideEffects[1]` 的字符串内容，并通过 `JSON.stringify(output.options)` 来找 forbidden keys。
- **为何是伪测试**：
  这更像“contract 常量长这样”与“当前对象里没出现某些字符串”，不是在真实 seam 上证明 `chat.params` 没有越权参与 projection / prompt authoring。
- **对应 DESIGN 章节**：
  - §8.4 普通对话等待入口
  - §12.4 模块职责边界
  - §14.18 `chat.params` 只是窄调度缝

### C5. `chat-params-scheduler.test.ts` 主要在验证当前 mark-count scheduler，而不是 DESIGN readiness

- **文件**：`tests/e2e/runtime/chat-params-scheduler.test.ts`
- **问题说明**：
  该测试喂入合成历史，断言 exact metadata、exact dispatched batches、exact lock 状态文案。问题在于它验证的是当前实现：按 mark ids 冻结 batch，而不是按 marked-token readiness 判定调度。
- **为何是伪测试**：
  当被测实现本身已经偏离 DESIGN 时，这个测试就成了“给错误实现背书”的测试。
- **对应 DESIGN 章节**：
  - §7.1 触发条件
  - §8.3 Batch Snapshot 冻结规则
  - §9.2 字段清单
  - §14.24 `schedulerMarkThreshold` 与 Marked-Token 阈值分离

### C6. `projection-replay-contract.test.ts` 用内部 visible-id helper 计算 expected output

- **文件**：`tests/e2e/interfaces/projection-replay-contract.test.ts`
- **问题说明**：
  测试通过 `buildStableVisibleId()` 和同一套 identity/repository/projection builder 构造期待输出（`tests/e2e/interfaces/projection-replay-contract.test.ts:143-150`）。
- **为何是伪测试**：
  它在验证“内部 helper 组合后给出这个结果”，而不是用独立语义 oracle 验证“父节点无结果时展示子结果 + 原文 gap”这一 contract。
- **对应 DESIGN 章节**：
  - §15.10 渲染规则
  - §15.13 被覆盖的旧结果如何回退显示
  - §15.14 子结果的显示边界

### C7. `runtime-config-contract.test.ts` 部分断言过度绑定当前 repo 默认值与路径布局

- **文件**：`tests/e2e/interfaces/runtime-config-contract.test.ts`
- **问题说明**：
  该测试不仅测 invariant，还断言 exact model list、exact repo path、exact prompt file path、exact timeout 默认值等。
- **为何是伪测试**：
  其中一部分是合理的 loader regression coverage；但把“当前仓库默认值和路径布局”升格成契约，会掩盖真正 operator-facing contract drift，同时让非本质重构也变成测试失败。
- **对应 DESIGN 章节**：
  - §9.1 配置文件
  - §9.2 字段清单
  - §9.3 Env 覆盖
  - §11.4 Prompt 文件的硬约束

### C8. harness 自证测试不应计入 design 正确性证明

- **文件**：
  - `tests/e2e/harness/safe-transport-fixture.test.ts`
  - `tests/e2e/harness/evidence-layout.test.ts`
  - `tests/e2e/harness/network-deny.test.ts`
- **问题说明**：
  这些测试分别证明 fixture transport 可 scripted、evidence layout 长这样、network deny 生效。它们可以保留，但不应被视为 context-compression design 的正确性证据。
- **为何是伪测试**：
  它们证明的是 test harness 的自我稳定性，不是插件在 canonical history / sidecar / projection / compaction lifecycle 上符合 `DESIGN.md`。
- **对应 DESIGN 章节**：
  - §13.1 自动化测试范围
  - §13.2 不声称的内容
  - §13.4 Truth Boundary 的操作含义

---

## D. 较健康但仍应谨慎解读的测试

以下测试比上面几类更接近真正 contract-level proof，但仍不应被过度解读为“真实环境 correctness 已被完全证明”：

- `tests/e2e/recovery/restart-replay-consistency.test.ts`
  - 优点：确实围绕“host history + sidecar 重建相同 projection”“父结果未完成时不暴露 partial parent result”“stale lock timeout / manual unlock”这些 DESIGN 语义。
  - 风险：仍明显依赖内部 builder graph、deep-equality of helper-produced snapshots。
  - 对应 DESIGN：§8.1、§8.2、§8.4、§15.13、§15.25。

- `tests/e2e/recovery/transport-timeout-recovery.test.ts`
  - 优点：覆盖失败不落 result group、成功后再出现 replacement、projection 在失败后保持稳定等重要恢复语义。
  - 风险：仍 heavily 使用 internal builders / repositories / scripted transports，当作 contract proof 时应降权。
  - 对应 DESIGN：§7.3、§12.6、§15.12A、§15.25、§15.26。

---

## E. 建议的处理顺序

### 优先级 0：先修设计级 blocker

1. 修正 replacement 的 suppression / source-span 接管边界（A1）
2. 把真正的 send-entry gate 接入默认 shipped runtime（A2）
3. 让 scheduler readiness 回到 marked-token 口径（A3）
4. 把 `allowDelete` 从 replay / execution 期剥离回 admission-only（A4）

### 优先级 1：修正 operator-facing drift

5. 收敛 `allowDelete` 的配置面对外表达（B1）
6. 强化 compaction prompt template contract 的 fail-fast 校验（B2）
7. 明确 replay helper 的边界，避免被误当 sidecar truth rebuild（B3）
8. 明确错误 mark 调用在 replay / projection 中的保留语义（B4）

### 优先级 2：清理伪测试与假信心

9. 给测试重新分层：
   - harness coverage
   - implementation regression coverage
   - design-contract proof
10. 降权或重写 C1-C8 中的测试，不再把它们作为“DESIGN 已证明”的证据。

---

## F. 总结

本次审计的关键结论不是“仓库一团糟”，而是：

- 当前实现里**混杂了真实 contract coverage 与大量 implementation-coupled coverage**。
- 这会产生一种危险局面：
  - 仓库内测试很多
  - 看起来覆盖面很广
  - 但一部分测试其实在给偏离 `DESIGN.md` 的实现背书

因此，下一阶段若继续做真实环境测试或修复，不应把当前测试全绿当成高置信证明，而应先把上面的 blocker 与 test-debt 切开处理。
