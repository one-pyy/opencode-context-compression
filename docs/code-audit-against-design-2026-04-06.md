# 代码审计：当前实现与 `DESIGN.md` 的偏差清单（2026-04-06，按最新讨论更新）

本文档汇总截至 2026-04-06 本轮讨论后，对当前仓库进行的代码审计结果。

本版已经吸收以下新确认口径：

1. **send-entry gate 应在 `experimental.chat.messages.transform` 的第一时间进行拦截**，即在开始解析 / replay / projection 当前轮内容前完成 gate 判定。
2. **`allowDelete` 只在 `compression_mark` tool 调用当下做 admission 检查**；若 disallow 且请求 delete，则直接返回错误结果，而不是生成可重放 mark。
3. **hook / replay 只消费成功返回 `mark id` 的 tool 结果**；错误结果应保留为普通错误消息，但不进入 mark 覆盖树或 replacement lookup。
4. `allowDelete` 作为 runtime config 公开存在是合理配置面；真正需要警惕的是旧设计迁移文字导致的误读，而不是这项配置本身。
5. reminder 文案**应完全受当前 `allowDelete` 影响**，这一点不是问题。

因此，本文只保留在上述口径下仍成立的问题，并明确区分：

- **Blocker：确认违反当前 DESIGN 的实现**
- **设计/文档漂移：当前代码未必错，但文档或命名仍有歧义**
- **测试偏移：测试在给偏离设计的实现背书，或应删除/降权**

---

## 一、结论总览

- 当前仓库**不是全面失真**；不少基础面已经和 `DESIGN.md` 对齐。
- 但当前 shipped path 仍有几处**实质性 blocker**：
  1. replacement 渲染边界错误
  2. 默认 runtime 未把 send-entry gate 接到真实入口
  3. scheduler readiness 仍按 mark 数量，而不是未压原始 token
  4. 错误 mark 调用在 replay 中被静默丢弃
- 另外还有两类需要单独看待的问题：
  - **旧设计文字/命名残留**：会持续拖偏实现和理解
  - **测试债务**：多处测试应删除，少数应保留但明确降权

---

## 二、Blocker：确认违反当前 `DESIGN.md` 的实现

### 2.1 replacement 只删 mark tool，不隐藏被接管的 source span

- **文件**：`src/projection/rendering.ts`
- **证据**：
  - `renderMarkNode()` 在存在 `resultGroup` 时仍继续 `renderOriginalRange()`（`src/projection/rendering.ts:131-155`）
  - `collectSuppressedCanonicalIds()` 只加入 `node.sourceMessageId`（`src/projection/rendering.ts:217-225`）
- **问题说明**：
  当前实现把 suppression 边界落在 mark tool 的 source message，而不是被 replacement 接管的原始跨度。这会导致 replacement 已出现，但原文 source 仍继续进入 prompt-visible view。
- **为何违反当前设计**：
  当前设计要求：先替换原 source span，再删除已被消费的 mark tool 调用。两者不是同一件事。
- **对应 DESIGN 章节**：
  - §6.3
  - §10.2
  - §10.3
  - §15.10
  - §15.26

### 2.2 默认 shipped runtime 没有在 `messages.transform` 第一时间执行 send-entry gate

- **文件**：
  - `src/runtime/default-plugin-services.ts`
  - `src/runtime/send-entry-gate.ts`
  - `src/runtime/plugin-hooks.ts`
- **证据**：
  - 默认 runtime `toolExecutionGate.beforeExecution()` 永远返回 `{ blocked: false }`（`src/runtime/default-plugin-services.ts:32-39`）
  - `createFileLockBackedSendEntryGate()` 存在，但默认 wiring 未接入（`src/runtime/send-entry-gate.ts:133-149`）
  - `plugin-hooks` 没有在 `experimental.chat.messages.transform` 入口前做 gate wait（`src/runtime/plugin-hooks.ts:52-82`）
- **问题说明**：
  按当前讨论后的正确口径，gate 必须在 `messages.transform` 的第一时间拦截；当前 shipped runtime 仍停留在“helper 已有，但真实入口未接”的状态。
- **对应 DESIGN 章节**：
  - §8.2
  - §8.4
  - §12.4
  - §12.7

### 2.3 scheduler 仍按 mark 数量，不按未压原始 token 调度

- **文件**：`src/runtime/chat-params-scheduler.ts`
- **证据**：
  - `collectEligibleMarkIds()` 直接 `flattenMarkIds(tree.marks)`（`src/runtime/chat-params-scheduler.ts:393`）
  - 用 `eligibleMarkIds.length >= threshold` 决定 readiness（`src/runtime/chat-params-scheduler.ts:394-398`）
- **问题说明**：
  仓库中已经有 per-message tokenCount 基础设施，但 scheduler 没把它提升成“当前有效覆盖树中的未压原始 token”数据结构，而是保留了早期 mark-count 兼容口径。
- **为何违反当前设计**：
  当前设计已明确：`schedulerMarkThreshold` 仅是内部/test compatibility 参数；真正 readiness 看未压原始 token。
- **对应 DESIGN 章节**：
  - §7.1
  - §9.2
  - §9.3
  - §14.24
  - §15.22
  - §15.23
  - §15.24

### 2.4 错误 mark 调用在 replay 中被静默丢弃，而不是保留为普通错误消息

- **文件**：
  - `src/history/history-replay-reader.ts`
  - `src/runtime/session-history.ts`
- **证据**：
  - `replayHistoryFromSources()` 对 `entry.result.ok !== true` 直接跳过（`src/history/history-replay-reader.ts:139-155`）
  - `session-history` 对 parse / deserialize 失败也直接 `continue`（`src/runtime/session-history.ts:120-144`）
- **问题说明**：
  当前实现把“错误调用不进入 mark 语义系统”错误地实现成了“错误调用从 replay 里消失”。
- **为何违反当前设计**：
  当前正确语义是：错误结果不生成 mark intent，但仍应作为普通错误消息留在可见世界里。
- **对应 DESIGN 章节**：
  - §6.2
  - §15.4
  - §15.5
  - §15.15
  - §15.16

---

## 三、设计/文档漂移：代码未必错，但当前文档或命名仍有拖偏风险

### 3.1 `hostMessageId` / `canonicalMessageId` 双字段并存，仍保留旧双身份心智影子

- **文件**：
  - `src/compaction/replay-run-input.ts`
  - `src/compaction/input-builder.ts`
  - `src/compaction/transport/request.ts`
  - `src/compaction/types.ts`
- **证据**：
  - replay-run-input 同时写 `hostMessageId` 与 `canonicalMessageId`，且当前两者实际填同一值（`src/compaction/replay-run-input.ts:86-93`）
- **问题说明**：
  按当前讨论，使用 `hostMessageId` 命名可以接受；但现在接口层同时保留两套字段，会持续制造“是否存在两套真实主键”的旧心智影子。
- **结论**：
  这更像**命名/接口收敛项**，不是当前 blocker。
- **对应 DESIGN / 检查清单**：
  - `DESIGN.md` §5.5
  - `old-design` §7.1

### 3.2 `buildCompactionRunInputForMark` 暴露了旧设计误区，但其根问题已被本轮口径修正

- **文件**：`src/compaction/replay-run-input.ts`
- **它是干什么的**：
  它负责从当前 `ProjectionState` 中找到某个 mark 节点，切出该 mark 覆盖的原始 transcript，组装成一次 runner 可执行的 `RunCompactionInput`。
- **暴露出的旧误区**：
  它过去通过
  `const allowDelete = options.allowDelete ?? markNode.mode === "delete"`
  把 `allowDelete` 一并带入 execution/build request 阶段。
- **本轮讨论后的正确结论**：
  这说明旧设计误区确实存在，但应由“tool 调用当下 admission + hook 只消费成功 mark 结果”来修正，而不是继续让 execution 阶段重新 gate delete。
- **对应 DESIGN 章节**：
  - §4.3
  - §6.2
  - §15.4
  - §15.5

---

## 四、应删除的测试

以下测试不应继续作为 design 正确性证明存在；其中多数应直接删除，而不是降权保留。

### 4.1 `tests/e2e/interfaces/internal-module-contracts.test.ts`

- 直接验证 `*_INTERNAL_CONTRACT` 常量、模块名、依赖方向、方法名与静态 helper 行为。
- 属于仓库自证，不是 design proof。

### 4.2 `tests/e2e/compact-success/full-success-path.test.ts`

- 复用内部 builder graph 拼出预期，并顺着当前实现断言 after-commit 只剩三条消息。
- 在 replacement 边界已偏移的情况下，这个测试实际是在给偏移实现背书。

### 4.3 `tests/e2e/runtime/transport-call-recording.test.ts`

- 主要证明 scripted transport 记录了当前 request 形状。
- 这是 harness / implementation regression，不是 design correctness。

### 4.4 `tests/e2e/interfaces/chat-params-narrowing.test.ts`

- 直接验证 exported contract 文案与 JSON string surface。
- 没有约束真实 seam 行为。

### 4.5 `tests/e2e/runtime/chat-params-scheduler.test.ts`

- 当前主要在给 mark-count scheduler 背书。
- 当 scheduler 本身偏离 design 时，这个测试就成了错误回归的保护网。

### 4.6 `tests/e2e/interfaces/runtime-config-contract.test.ts`

- 过度绑定当前 repo 默认值与路径布局。
- 它会把“当前仓库长这样”误升格成契约，同时掩盖真正 config 语义问题。

---

## 五、应保留但降权的测试

### 5.1 `tests/e2e/interfaces/projection-replay-contract.test.ts`

- 保留。
- 原因：尽管它仍使用内部 helper 计算 expected output，但它约束了一个真实语义——父节点无结果时，子结果与原文 gap 的 fallback 行为。
- 处理建议：保留，但不要把它当独立外部 oracle。

### 5.2 harness 自证测试

- 文件：
  - `tests/e2e/harness/safe-transport-fixture.test.ts`
  - `tests/e2e/harness/evidence-layout.test.ts`
  - `tests/e2e/harness/network-deny.test.ts`
- 保留。
- 但它们只算 harness coverage，不能再计入 design correctness 证明。

---

## 六、与旧设计兼容心智直接相关的残留

按 `docs/old-design-compatibility-risk-checklist-2026-04-06.md` 复查后，当前最明显的旧设计残留有五类：

1. **mark-count scheduler**：保留了旧的 count-based readiness 心智。
2. **helper-only send-entry gate**：停留在过渡态 wiring，而非真实入口。
3. **replacement suppression 边界错位**：像是“删掉 mark tool 就算替换完成”的旧思路。
4. **错误 mark 调用静默丢弃**：像是只保留“成功进入语义系统的干净 mark 记录”。
5. **execution 阶段继续 gate delete**：把 `allowDelete` 从 admission gate 拖回 execution-time 权限位。

这些都不是孤立 bug，而是明显受旧设计 / 过渡期兼容心智影响的实现偏移。

---

## 七、建议的处理顺序

### 优先级 0：先修 blocker

1. 修正 replacement 接管边界
2. 把 send-entry gate 接入 `messages.transform` 第一时间
3. 建立未压原始 token 的调度数据结构，替换 mark-count scheduler
4. 把错误 mark 调用从“静默跳过”改为“普通错误消息保留，但不进入 mark 语义系统”

### 优先级 1：收敛文档与接口口径

5. 澄清 `DESIGN.md` 中旧配置迁移对 `allowDelete` 的表述
6. 收敛 `hostMessageId` / `canonicalMessageId` 双字段心智
7. 让 `buildCompactionRunInputForMark` 所在链路严格服从 admission-only `allowDelete`

### 优先级 2：清理测试偏移

8. 删除第四节列出的测试
9. 保留第五节测试，但明确降权
10. 后续所有新测试都要区分：
   - design-contract proof
   - implementation regression
   - harness coverage

---

## 八、总结

当前仓库的主要风险，不是“完全没有设计实现”，而是：

- 一部分核心设计已经落地；
- 但仍有几处关键路径被旧设计文字或过渡期兼容心智拖偏；
- 同时测试层又在给这些偏移实现提供不恰当的稳定性背书。

因此，下一步最重要的不是继续堆测试，而是：

1. 先修正 blocker；
2. 同步清理文档口径；
3. 最后再重建真正可信的 contract-level proof。
