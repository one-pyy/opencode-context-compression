# 旧设计 / 兼容心智影响检查清单（2026-04-06）

本文档用于后续代码审查与重构时，专门识别那些会把实现拉回旧设计、兼容式思维或错误运行时模型的风险点。

它不是权威设计文档；权威设计以 `DESIGN.md` 为准。本文档的用途是：

1. 在审代码时快速识别“看似合理、实则在兼容旧设计”的实现
2. 在审测试时识别“用当前错误实现给自己背书”的伪证明
3. 在真实环境测试前，提醒哪些地方最容易出现 shipped-path 漂移

---

## 1. Truth boundary 风险

### 1.1 把 SQLite 当成第二套会话或 replay 真相源

**风险信号**：
- 新增或依赖独立的 `marks` 真值表、`source_snapshots` 真值表
- 通过 sidecar 恢复完整 transcript，而不是重放 host history
- 代码把 sidecar 中间状态当成比宿主历史更权威的来源

**当前正确口径**：
- 宿主历史是唯一真相源
- SQLite 只保存 replacement 结果组、visible-id 映射、schema 元信息等 sidecar 状态
- mark 的真值来自历史中的 tool 调用重放

**检查问题**：
- 这段代码是否绕过了 host history replay？
- 这段代码是否在试图持久化 mark/source 的独立真值？
- 这段代码是否会让 sidecar 在没有宿主历史的情况下独立解释会话？

---

## 2. Mark / replacement 模型风险

### 2.1 把 mark 当作立即持久化业务状态，而不是可重放意图记录

**风险信号**：
- `compression_mark` 调用时立即写 mark 真值表
- 后续逻辑优先查持久 mark 记录，而不是按历史重放构造覆盖树

**当前正确口径**：
- `compression_mark` 在宿主历史里留下输入与 `mark id`
- hook / projection 通过顺序重放历史恢复当前有效 mark 结构

### 2.2 replacement lookup 不以 `mark id` 为主键

**风险信号**：
- 主要命中逻辑依赖 source snapshot 比对或 canonical range 比对
- `mark id` 退化成可选辅助字段

**当前正确口径**：
- replacement 主 lookup 键是历史里真实出现的 `mark id`
- 先建覆盖树，再按 `mark id` 查完整结果组

### 2.3 把“压缩后不能再次压缩”误实现成“压缩块不能进入任何更大范围”

**风险信号**：
- 对 compact 结果做绝对排除，不允许它进入后续更大范围
- delete 无法覆盖 compact 结果块

**当前正确口径**：
- compact 结果不能被内部再次改写
- 但可以作为不可压缩原子块进入更大范围
- 也可以被 delete 整段覆盖

---

## 3. `allowDelete` 风险

### 3.1 把 `allowDelete` 当成长期持久语义位

**风险信号**：
- 在 mark / replacement / projection 数据结构里跨轮持久化 `allowDelete` 业务语义
- 通过当前 `allowDelete` 去改写已经接受过的历史 delete mark 的解释

**当前正确口径**：
- `allowDelete` 只定义当前 delete mark 的准入策略
- 一旦 tool 调用被接受，后续历史解释主要依赖 `mode` 与结果组

### 3.2 把 `allowDelete` 理解成 route 枚举或 keep/delete 二选一路由

**风险信号**：
- 代码把 runtime 分成 keep route / delete route 两套主流程
- delete 被实现成第二套平行子系统

**当前正确口径**：
- delete 与 compact 共用同一 replacement 机制
- 差异在 mode、prompt 与结果类型，不在替换主算法

### 3.3 reminder 文案没有按 `allowDelete` 分支

**风险信号**：
- reminder prompt 只有 severity，没有 `allowDelete` 维度
- `allowDelete=true` 与 `false` 复用同一提醒文案

**当前正确口径**：
- reminder prompt 按 severity × `allowDelete` 四路拆分
- reminder 文案应完全受当前 `allowDelete` 影响

---

## 4. Projection / hook 风险

### 4.1 replacement 只删 mark tool，不隐藏被接管的 source span

**风险信号**：
- 结果组生效后，原始 source messages 仍继续进入 prompt-visible view
- suppression 边界落在 mark tool source message，而不是 replacement 接管的原始跨度

**当前正确口径**：
- 先替换原 source span
- 再删除被 replacement 消费的 mark tool 调用

### 4.2 错误 mark 调用被静默丢弃

**风险信号**：
- 输入/输出 parse 失败后直接跳过，不保留可见错误消息
- 错误 mark 不再出现在最终 prompt-visible 世界中

**当前正确口径**：
- 错误 tool 调用不进入 mark 语义系统
- 但应作为普通错误消息保留在最终可见世界里

### 4.3 按投影后的块表面计算 mark 覆盖关系

**风险信号**：
- 覆盖 / 包含 / 相交关系基于 replacement 块外观而不是原始消息跨度

**当前正确口径**：
- 覆盖关系必须按原始消息范围计算

### 4.4 同一轮多个 mark 被实现成“前一个立即改写上下文，后一个基于新上下文再判断”

**风险信号**：
- 第二个 mark 自动追随第一个尚未落库的未来结果
- 同轮 mark 调用被串成即时状态机

**当前正确口径**：
- 同一轮多个 mark 是针对同一快照提出的多个提案
- 后续由 hook 统一裁决

---

## 5. Runtime seam 风险

### 5.1 `chat.params` 越权承担 projection / rendering / wait gate

**风险信号**：
- `chat.params` 里组装 transcript
- `chat.params` 里插 reminder / visible id / replacement
- `chat.params` 成为普通对话等待入口

**当前正确口径**：
- `chat.params` 只是窄调度缝
- 最多调度 compaction job 与写少量 runtime metadata

### 5.2 send-entry gate 没有在真正 send path 前生效

**风险信号**：
- 只有 helper 存在，但默认 runtime wiring 未接入
- 普通对话直到很晚阶段才看到错误，而不是在入口等待

**当前正确口径**：
- gate 必须在真正 send path 前生效
- 若存在活跃 compaction gate，应在 `experimental.chat.messages.transform` 开始解析/投影当前轮 prompt-visible 内容前阻塞，直到完成、失败、超时或手工恢复

### 5.3 `messages.transform` 不是唯一 projection seam

**风险信号**：
- 其他 hook 或工具执行路径也在直接改 prompt-visible 消息

**当前正确口径**：
- 所有模型可见改写只发生在 `experimental.chat.messages.transform`

---

## 6. Scheduler / token 风险

### 6.1 用 mark 数量代替 readiness token 统计

**风险信号**：
- `eligibleMarkIds.length`、树节点数、消息数直接作为 compaction readiness

**当前正确口径**：
- 自动压缩 readiness 取决于当前有效覆盖树中的**未压原始 token**
- 运行时应维护显式数据结构来表示每个节点的原始 token、已压 token、未压 token，并支持向上聚合

### 6.2 只统计最终 prompt token，不统计未压原始 token

**风险信号**：
- 调度逻辑直接拿最终 projection token 作为唯一指标

**当前正确口径**：
- 至少区分两类指标：
  - 调度指标：未压原始 token
  - 负载指标：最终实际 prompt token

---

## 7. Identity 风险

### 7.1 假定存在独立于 `info.id` 的第二 canonical message 标识体系

**风险信号**：
- 代码要求字面 `hostMessageId` 字段必须存在
- `hostMessageId` 与 `canonicalMessageId` 被当成两套真实业务主键

**当前正确口径**：
- canonical host message identifier 默认取 envelope `info.id`
- 局部变量名可以使用 `hostMessageId`，但它的语义仍应对应 `info.id`

### 7.2 visible ID 不是单出口渲染

**风险信号**：
- 各处散落着重复拼接 `protected_` / `compressible_` / `referable_` 前缀

**当前正确口径**：
- bare metadata + single-exit 渲染

---

## 8. Prompt / config 风险

### 8.1 reminder cadence 仍保留 counter 心智

**风险信号**：
- `counter.source`
- `counter.*.repeatEvery`
- 消息条数驱动的 cadence

**当前正确口径**：
- cadence 只由 `hsoft` / `hhard` / `softRepeatEveryTokens` / `hardRepeatEveryTokens` 定义

### 8.2 reminder prompt 不是 severity × allowDelete 四路矩阵

**风险信号**：
- reminder prompt 文件少于四个
- `allowDelete=true` / `false` 不分支

### 8.3 compaction prompt 退化成普通提示文本

**风险信号**：
- prompt 中不再明确 execution mode / delete permission 的模板契约

**当前正确口径**：
- `compaction.md` 是 system prompt 模板，运行时注入执行模式与删除许可指令

---

## 9. Test 风险

### 9.1 自证式内部契约测试

**风险信号**：
- 测试直接 import `*_INTERNAL_CONTRACT`
- 测试验证模块名、依赖方向、方法名、常量字符串

### 9.2 implementation-coupled 的 helper graph 回归测试被误当成 design proof

**风险信号**：
- 测试使用和生产同一套 builder / repository / helper 来生成期待结果
- 期待值由内部 helper 算出来，而不是由设计语义独立推出

### 9.3 harness 自证测试被误算进 correctness 证明

**风险信号**：
- network deny
- evidence layout
- scripted safe transport fixture

**当前正确口径**：
- 这些测试可以存在，但只能算 harness coverage，不能算设计正确性的核心证据

---

## 10. 代码审查时的使用方式

审每个可疑改动时，至少问下面四个问题：

1. 这段实现是在表达当前设计，还是在兼容一个已经被淘汰的旧心智？
2. 这段逻辑有没有绕过 host history replay、单出口 projection、或 mark-id keyed replacement 的主链路？
3. 它是在增加真实 contract coverage，还是只是在给当前实现写自证测试？
4. 如果把这段代码放进真实 shipped path，而不是 hermetic test harness，它还成立吗？

只要其中一个问题的答案是“它在兼容旧设计”，就应当继续追查，不要直接接受为合理实现。
