# 以 `DESIGN.md` 为唯一准绳的重构拆分任务稿（中文落盘）
> 本稿用于后续代码重构分派与执行。
>
> **执行原则**：所有实现、测试、命名、注释、验证口径都必须对齐到 `DESIGN.md`；`DESIGN-CHANGELOG.zh.md` 只作为“相对当前代码库的变更提示”和“补充核对项”，**不高于** `DESIGN.md`。
>
> **禁止做法**：
> - 不以当前代码行为为准反向解释设计
> - 不把旧测试断言当成新契约
> - 不在子 agent prompt 中用自己的话改写关键设计点；优先贴原文引用
> - 遇到 `DESIGN.md` 内部存在张力时，不自行拍板“取其一”，而是**直接并列引用原文**、提交冲突审计，然后再改代码
---
## 0. 使用说明与总优先级

### 0.0 测试治理原则（必须先读）

本仓库后续重构**不得**采用“实现 agent 顺手把测试改绿”或“单独让测试 agent 根据实现细节配套拟合”的做法。原因是当前测试中本就含有遗留语义，若继续由实现方或测试方按局部实现细节写测试，极易出现：

- 测试代码与实现代码共同漂移
- 形式化测试全绿，但真实运行路径未被覆盖
- 以 mock / 夹具 / 内部 helper 拟合当前实现，而非验证 `DESIGN.md` 规定的可观测行为

后续统一采用 **三段式测试治理流程**：

1. **主控先定义成功现象**
   - 先写“本任务的成功现象 / 外部可观测行为 / 禁止依赖的内部细节”
   - 这一步必须直接引用 `DESIGN.md` 原文
2. **实现 agent 先改接口与实现**
   - 只对齐设计，不负责把现有遗留测试顺手改绿
   - 允许补最低限度的自测夹具，但不得以“方便测试”为由回退设计
3. **独立验证 agent 再写/改测试**
   - 测试必须围绕成功现象、投影输出、外部 contract、sidecar 状态与运行时观测来写
   - 不得以当前内部 helper、私有函数、临时字段作为主要断言对象
4. **主控做反拟合审查**
   - 问三个问题：
     - 这些测试是否只是在复述实现细节？
     - 如果把内部实现换一种等价方式，测试是否仍应通过？
     - 是否存在“真实运行不通，但测试仍全绿”的盲区？

### 0.0.1 何时不应信任测试通过

出现以下任一信号时，不能把“测试全绿”当成完成：

- 主要断言集中在内部函数返回值，而非 `messages.transform` 输出、tool contract、SQLite sidecar 状态、lock/gate 行为
- 大量使用与生产运行不一致的 mock path，且没有对应 e2e / cutover 覆盖
- 旧测试名义仍在验证旧 route / 旧语义，但实现已经切到 `DESIGN.md`
- 修改实现后，只需要同步改测试文本/快照就能继续全绿

### 0.0.2 本仓库推荐的测试分层

后续任务默认按以下优先级写测试：

1. **cutover / contract 测试**
   - 验证配置面、文档契约、公共工具 contract
2. **projection / compaction 行为测试**
   - 验证 derived prompt view、replacement 渲染、reminder、错误 mark 语义
3. **runtime gate / batch / lock 测试**
   - 验证运行时门闩与冻结语义
4. **e2e 测试**
   - 验证插件加载、mark 流、scheduler seam、committed replacement 路径

不推荐新增大量只验证私有函数细枝末节的测试，除非这些私有函数承载了可独立定义的纯算法合同（例如覆盖树裁决规则）。

### 0.0.3 子 agent 分工规则（测试相关）

对任何会改动行为契约的任务，默认拆为以下三个子任务，而不是一个 agent 包办：

- **A. 现象定义 / 接口边界任务**（可由主控或 writing/deep agent 完成）
  - 产出：成功现象、失败现象、禁止拟合点
- **B. 实现任务**（deep agent）
  - 产出：实现代码、必要测试夹具、实现说明
- **C. 独立验证任务**（deep 或 writing+deep 组合，视任务而定）
  - 产出：测试修改、验证报告、拟合风险说明

如任务很小，也至少要在同一主控流程中显式分成“先实现、后独立验收”两步，不能把“实现与测试一起改绿”当作默认路径。

### 0.0.4 验证 agent 必须携带的上下文模板

后续凡是单独派测试/验证 agent，必须在 prompt 中包含以下信息：

1. **成功现象**：直接引用 `DESIGN.md` 原文
2. **失败现象**：哪些旧语义不应再被接受
3. **允许断言的对象**：
   - 公共工具输入输出
   - `messages.transform` 的可见输出
   - SQLite sidecar 中对外可解释的状态
   - lock / gate / runtime observation
4. **禁止拟合的对象**：
   - 临时 helper 返回值
   - 仅为当前实现方便存在的内部字段
   - 未来可能被等价替换的私有调用顺序

### 0.0.5 总控验收附加问题（每个任务结束都要问）

主控在接收测试结果时，必须额外审查：

1. 如果把内部实现完全重写但仍满足 `DESIGN.md`，这些测试是否仍然合理？
2. 如果去掉某个当前 helper / 当前字段，测试会不会无意义地全挂？
3. 是否至少有一层测试在验证“用户/模型/运行时真正能观察到的现象”？
4. 是否补了真实运行入口相关的验证，而不是只有纯 mock？
### 0.1 设计原文中的总原则（必须原样带入后续任务）
引用：`DESIGN.md:24-32`
> | **Canonical History** | 只读真相源 | OpenCode host history | canonical message 列表 |
> | **Sidecar State** | 持久化插件派生结果与运行时状态 | canonical messages + 现有 SQLite | replacement 结果组、sequence、lock、job 与日志状态 |
> | **Policy** | 纯计算，deterministic | canonical history + sidecar state | compressible/protected/referable 分类、reminder anchor、是否满足压缩条件 |
> | **Projection** | 决定最终给模型看的消息 | policy 结果 + canonical history + sidecar replacement | derived prompt view（消息数组） |
> | **Execution/Scheduling** | 后台压缩调度 | 当前轮请求上下文 + policy 结果 + 冻结 batch snapshot | 后台 compaction job、lock 文件、普通对话等待/恢复信号 |
引用：`DESIGN.md:36-43`
> 1. 读取当前 host history，得到 canonical message 列表
> 2. 用 canonical message 列表同步 SQLite sidecar 的有效性
> 3. 从 canonical history + SQLite 计算 reminder、mark 命中、replacement 命中、visible id
> 4. 在 `experimental.chat.messages.transform` 中把计算结果投影成最终 prompt-visible 消息数组
> 5. 如果当前轮满足压缩条件，scheduler 冻结当前 batch snapshot 并触发后台 compaction job
> 6. compaction job 写 lock、按 `compactionModels` 数组顺序尝试模型、成功则提交 replacement，失败则只保留 mark
> 7. 普通对话在 lock 期间等待；当 compaction 成功、终态失败、超时或手工清 lock 后，再继续
> 8. 下一轮再进入 `messages.transform` 时，已提交的 replacement 才会真正替换 source span
### 0.2 文档与现状的关系（必须写进所有总控子任务上下文）
引用：`DESIGN-CHANGELOG.zh.md:15-18`
> 本轮设计文档不是简单整理旧文档，而是在旧文档基础上做了多项**目标设计收敛**。因此，文档中有些内容代表“未来实现必须遵守”，不应被误读成“当前代码已完全做到”。
引用：`DESIGN-CHANGELOG.zh.md:240-246`
> 当前 `DESIGN.md` 里相当一部分是目标设计
> 尤其是本轮临时拍板的内容，当前代码未必已经做到
> 实现前必须逐项核对，不应把文档直接当成“现状说明书”
### 0.3 建议重构顺序（总顺序）
本稿按下列顺序执行：
1. **T0 文档引用冻结与冲突审计**
2. **T1 配置 / Prompt / 资产契约对齐**
3. **T2 公共工具契约切换：`compression_mark`**
4. **T3 Sidecar 数据模型与 Schema 重构**
5. **T4 历史重放 / 覆盖树 / replacement 结果组主链路**
6. **T5 Projection / Visible ID / Reminder / 清理规则重构**
7. **T6 Compaction 输入、Runner、Transport、失败语义重构**
8. **T7 Scheduler / Gate / Batch Freeze / 运行时门闩对齐**
9. **T8 测试、文档、遗留资产统一收口**
依赖关系：
- `T0` 是所有任务前置
- `T1` 与 `T2` 可以并行准备，但 `T2` 合并前要读取 `T0`
- `T3` 先于 `T4`
- `T4` 先于 `T5` 和 `T6`
- `T5` 与 `T6` 可交错，但都依赖 `T4`
- `T7` 依赖 `T2/T3/T4/T6`
- `T8` 最后统一收口
---
## T0. 文档引用冻结与冲突审计
### 任务目的
为后续所有编码任务建立“原文引用基线”，避免子 agent 在转述过程中失真；同时把 `DESIGN.md` 内部可能存在的张力显式列出来，要求实现时引用原文并列，而不是擅自口头化简。
### 推荐子 agent
- **类型**：`writing`
- **load_skills**：`[]`
### 子 agent 必带上下文
- 工作目录：`/root/_/opencode/opencode-context-compression`
- 核心文件：
  - `DESIGN.md`
  - `DESIGN-CHANGELOG.zh.md`
  - `.sisyphus/notepads/decisions/2026-04-04_assistant-visible-id-prefix-when-body-exists.md`
  - `.sisyphus/notepads/decisions/2026-04-04_tool-only-assistant-shell-and-per-tool-msg-id-rendering.md`
  - `.sisyphus/notepads/decisions/2026-04-04_design-doc-reminder-cadence-and-allowdelete-contract.md`
### 必须附带的原文引用
引用：`DESIGN.md:1074-1076`
> 本章是对当前运行时模型的详细展开：把前文已经给出的规则，用更完整的生命周期说明、形式化约束与大量例子重新讲透。它是当前自洽设计的详细解释部分，不应被理解成“前文可以保留冲突语义”的覆盖章。
引用：`DESIGN.md:989-995`
> `allowDelete` 决定当前运行时是否允许创建 delete 型 mark；它不是 keep/delete route 枚举，也不是 mark / replacement / canonical source 的长期局部语义位。
>
> - `allowDelete=false`：允许 `mode=compact`，拒绝 `mode=delete`
> - `allowDelete=true`：允许 `mode=compact`，也允许 `mode=delete`
引用：`DESIGN.md:1127-1146`
> - `mode`：本次 tool 调用明确请求的动作，取值为 `compact` 或 `delete`
> - `allowDelete`：当前运行时策略是否允许创建 `delete` 类 mark 的**准入条件**
>
> 3. `allowDelete` 不再作为 mark 长期记忆“未来能力”的业务字段
>    - 它只在 mark tool 调用的 admission 阶段起作用
>    - 一旦 tool 调用被接受，后续历史解释只依赖 `mode`
引用：`DESIGN.md:434-438`
> `allowDelete` 是与目标消息、mark、source snapshot、replacement 相关的局部语义位，不是全局 runtime config 根级开关。
>
> 当前设计中，`allowDelete` 应作为 mark / replacement / canonical source 的语义属性被保存和比较，而不是作为 repo 级统一 route 被广播。
### 产出物
- 一份 **“实现冲突审计表”**（中文）
- 每条冲突必须包含：
  - 原文 A 引用
  - 原文 B 引用
  - 不得擅自归纳的说明
  - “需要主实现任务并列满足”或“需要先停下提交冲突说明”的结论
### 禁止事项
- 禁止自己总结成一句话替换掉原文
- 禁止因为“看起来像新版”就忽略前文条目
### 完成判据
- 后续所有编码任务可以直接引用该审计表而不再二次口头改写关键条款
---
## T1. 配置 / Prompt / 资产契约对齐
### 任务目的
先把配置面、prompt 文件名、fallback 规则、旧资产处理方式固定下来，减少主运行时重构期间的变量。
### 推荐子 agent
- **类型**：`deep`
- **load_skills**：`[]`
### 当前代码锚点
- `src/config/runtime-config.ts`
- `src/config/runtime-config.jsonc`
- `src/config/runtime-config.schema.json`
- `prompts/compaction.md`
- `prompts/reminder-soft-compact-only.md`
- `prompts/reminder-soft-delete-allowed.md`
- `prompts/reminder-hard-compact-only.md`
- `prompts/reminder-hard-delete-allowed.md`
- `prompts/reminder-soft.md`
- `prompts/reminder-hard.md`
### 必须附带的原文引用
引用：`DESIGN.md:650-703`
> `src/config/runtime-config.jsonc` 是 canonical runtime settings 文件。
>
> `schedulerMarkThreshold` 与 `markedTokenAutoCompactionThreshold` 不是同一个概念：
>
> - `schedulerMarkThreshold` 是内部 / test 兼容性阈值，按 mark 数量工作
> - `markedTokenAutoCompactionThreshold` 是真正的 marked-token readiness 阈值，按被 mark 覆盖的 token 总数工作
>
> 旧的 `counter.source` / `counter.*.repeatEvery` 不属于当前权威配置面。新的重复提醒语义必须通过显式 token 字段表达，而不是通过消息数计数器表达。
引用：`DESIGN.md:805-827`
> Reminder prompt 是**纯文本**，不是模板。内容是给 AI 看的提醒消息。
>
> 当前已有的 prompt 文件：
> - `prompts/compaction.md` — 压缩模板，已到位
> - `prompts/reminder-soft.md` — 旧版 soft reminder，需要被 `reminder-soft-compact-only.md` 和 `reminder-soft-delete-allowed.md` 替代
> - `prompts/reminder-hard.md` — 旧版 hard reminder，需要被 `reminder-hard-compact-only.md` 和 `reminder-hard-delete-allowed.md` 替代
>
> - reminder prompt 是纯文本，不使用变量模板
> - compaction prompt 是 system prompt 模板，允许运行时注入删除许可与本次执行模式指令
> - 不允许 builtin prompt fallback；缺文件、空文件或格式错误时应 fail fast
引用：`DESIGN-CHANGELOG.zh.md:73-86`
> - 不是 2 份，而是 4 份
> - 维度：severity × `allowDelete`
> - reminder prompt 是纯文本，不是模板
> - `compaction.md` 才是模板
### 产出物
- 配置面与 schema 完全以 `DESIGN.md` 为准
- 旧 prompt 资产处理策略明确：删除、迁移或仅保留兼容测试夹具（需在 patch 中说明）
- tests/cutover 中配置优先级测试同步更新
### 禁止事项
- 禁止保留旧 `counter.source`
- 禁止保留 builtin prompt fallback
- 禁止继续把旧两份 reminder prompt 当权威资产
### 完成判据
- `runtime-config.ts/jsonc/schema.json` 与 `DESIGN.md` 字段名、默认值、注释语义一致
- prompt 加载路径与四文件契约一致
---
## T2. 公共工具契约切换：`compression_mark`
### 任务目的
把公共工具从旧的 `allowDelete`/route 语义切换到 `DESIGN.md` 的 `mode` 驱动契约，并显式实现 delete admission 规则。
### 推荐子 agent
- **类型**：`deep`
- **load_skills**：`[]`
### 当前代码锚点
- `src/tools/compression-mark.ts`
- `src/index.ts`
- `tests/cutover/compression-mark-contract.test.ts`（若存在）
- `tests/e2e/plugin-loading-and-compaction.test.ts`
- `tests/e2e/plugin-loading-and-projection.test.ts`
### 必须附带的原文引用
引用：`DESIGN.md:522-526`
> - `contractVersion` 是 `v1`
> - `mode` 是 `"compact" | "delete"`
> - `target.startVisibleMessageID` 和 `target.endVisibleMessageID` 来自当前 projected visible view
> - 工具调用成功时立即返回随机 mark id
> - 如果 `mode=delete` 且当前策略不允许 delete，该次 tool 调用返回错误信息
引用：`DESIGN.md:1111-1114`
> - 它接收一个**单一范围**（单条消息也视作范围）
> - 一次调用只允许一个范围，不允许在一次调用里枚举多个子目标
> - 如果需要多个 mark，模型必须在**同一轮回答中多次调用该工具**
> - 工具真正立即返回的，只是一个随机生成的 **mark id**
引用：`DESIGN.md:1140-1146`
> 2. `mode=delete`
>    - 只有在当前策略允许 delete 时才允许创建 mark
>    - 若当前策略不允许 delete，则 tool 调用应被视为失败
>
> 3. `allowDelete` 不再作为 mark 长期记忆“未来能力”的业务字段
>    - 它只在 mark tool 调用的 admission 阶段起作用
>    - 一旦 tool 调用被接受，后续历史解释只依赖 `mode`
### 产出物
- `compression_mark` 参数契约切换到 `mode`
- 旧 `route: "keep"` / `allowDelete` 作为公共输入的测试全部迁移或删除
- 工具返回值契约改成 mark id / 错误文本，而不是旧的持久化说明文本
### 禁止事项
- 禁止继续把 `allowDelete` 暴露成公共动作语义主字段
- 禁止一次调用多范围
- 禁止工具层做调度、压缩执行或 prompt 投影
### 完成判据
- 新工具契约的 e2e / cutover 测试通过
- 当前仓库不再有 `route: "keep"` 之类公开输入断言
---
## T3. Sidecar 数据模型与 Schema 重构
### 任务目的
让 SQLite 侧车的职责与 `DESIGN.md` 一致：存放结果组与运行时状态，而不是继续把旧 mark/source snapshot 业务模型当主真相。
### 推荐子 agent
- **类型**：`deep`
- **load_skills**：`[]`
### 当前代码锚点
- `src/state/schema.ts`
- `src/state/store.ts`
- `src/state/session-db.ts`
- `src/state/sqlite-runtime.ts`
- `src/marks/mark-service.ts`
### 必须附带的原文引用
引用：`DESIGN.md:868-874`
> SQLite 应保存：
>
> - 每条 host message 的 DCP meta
> - replacement 结果组及其与 mark id 的关联
> - reminder 的计算/消费状态
> - `compressing` 锁和后台 job 状态
> - 永久 visible-id 序号分配状态
引用：`DESIGN.md:876-879`
> SQLite 不应被设计成：
>
> - 另一份完整 transcript
> - 可独立于 host history 运作的平行会话
引用：`DESIGN.md:1122-1125`
> 当前目标模型下，mark tool 调用**不要求**在调用时立即写入 marks/source_snapshots 之类的持久业务状态。当前权威语义是：
>
> - 历史中的 tool 调用本身，才是 mark 意图的真相源
> - SQLite 只需存与该 mark id 关联的压缩结果组及必要运行时缓存/执行元数据
引用：`DESIGN.md:1266-1283`
> 一个 mark 可以产出多个 replacement，但语义上仍是一个整体结果
>
> - 这仍是**同一个 mark 的一次完整结果**
> - 该结果组必须**原子生效**
> - 要么整组都存在并可被渲染
> - 要么整组都不存在
> - 不允许半成品出现在最终视图里
### 产出物
- 新 schema / migration 方案
- `store.ts` 接口按“mark id -> 结果组”重构
- 明确哪些旧表/列保留做迁移，哪些彻底删除
### 禁止事项
- 禁止继续以“持久 mark 状态”作为 projection 的主真相入口
- 禁止把 SQLite 扩展成可脱离 host history 的第二 transcript
### 完成判据
- store API 能直接支撑 `T4` 的历史重放和 mark-id 结果组查询
- schema 测试与迁移测试更新完成
---
## T4. 历史重放 / 覆盖树 / replacement 结果组主链路
### 任务目的
实现 `DESIGN.md` 第 15 章的核心运行时模型：不是读旧 mark 状态，而是重放历史 tool 调用，构造覆盖树，再按 mark id 渲染结果组。
### 推荐子 agent
- **类型**：`deep`
- **load_skills**：`[]`
### 当前代码锚点
- `src/projection/projection-builder.ts`
- `src/projection/messages-transform.ts`
- `src/marks/mark-service.ts`
- `src/state/store.ts`
- 未来新增模块（如需要）：
  - `src/replay/mark-replay.ts`
  - `src/replay/coverage-tree.ts`
### 必须附带的原文引用
引用：`DESIGN.md:1095-1105`
> 1. **旧理解**：mark tool 调用后，立即把 mark/source snapshot 等状态写入 SQLite，之后 projection 主要依赖数据库里的 mark 记录做 lookup。
>    - **新理解**：mark tool 调用只向宿主历史留下一个 tool 结果；projection 的主入口是**顺序重放历史里的 mark tool 调用**。
>
> 4. **旧理解**：替换命中主要通过持久 mark / canonical source 结构比对。
>    - **新理解**：替换命中的主键是历史里真实出现的 mark id；hook 通过重放 mark tool 调用、构造覆盖树、再按 mark id 去数据库取结果。
引用：`DESIGN.md:1150-1162`
> 1. 从头到尾遍历当前历史中的 mark tool 调用
> 2. 按顺序**模拟执行**这些 mark tool 调用
> 3. 根据覆盖规则构造当前有效的 mark 结构
> 4. 按 mark id 去数据库查找已有压缩结果
> 5. 用“有结果优先，否则回退”的方式渲染当前最终视图
引用：`DESIGN.md:1176-1189`
> 1. **后出现的 mark 如果范围包含或等于前面的 mark**
>    - 后 mark 覆盖前 mark
>    - 前 mark 不再是顶层有效 mark
>    - 但前 mark 仍保留为后 mark 的子节点，用于结果回退
>
> 2. **如果两个 mark 只有交集，没有包含关系**
>    - 当前这条后出现的 tool 调用视为错误调用
>    - 最终视图中应把该 tool 返回改写为报错信息
>    - 该 mark id 不进入任何后续运算
引用：`DESIGN.md:1237-1254`
> 1. 如果该节点自己有**完整结果组**
>    - 直接使用该节点的结果组
>    - 其整个子树不再展开
>
> 2. 如果该节点自己没有结果组
>    - 递归检查子节点
>    - 在子节点之间保留原文 gap
>
> 3. 如果该节点自己没有结果，子节点也都没有结果
>    - 当前节点本轮**不产生替换**
>    - 保持该节点所代表原位置内容不变
引用：`DESIGN.md:1316-1323`
> 1. 保留这条 tool 调用作为一条普通当前可见消息
> 2. 但把 tool 的返回值改写为报错信息
> 3. 该 mark id 不进入覆盖树
> 4. 该 mark id 不参与 token 统计
> 5. 该 mark id 不参与任何 replacement lookup
### 产出物
- 新的 mark replay / coverage tree / result-group application 代码
- `messages-transform` 接入新 replay 主链路
- 对错误 mark 的最终可见语义实现
### 禁止事项
- 禁止继续以 `store.listMarks()` 作为 projection 的主语义来源
- 禁止按投影块表面做包含/相交判断
- 禁止把错误调用当成“普通无结果 mark”
### 完成判据
- 能按 `DESIGN.md` 覆盖树规则处理：不相交、包含、相交报错、子结果回退、祖先结果接管
- 新测试覆盖第 15.7~15.16 的关键例子
---
## T5. Projection / Visible ID / Reminder / 清理规则重构
### 任务目的
让最终 prompt-visible 输出严格对齐 `DESIGN.md`：包括 single-exit 三态渲染、assistant/tool id 规则、reminder artifact、replacement 渲染、mark/reminder 清理。
### 推荐子 agent
- **类型**：`deep`
- **load_skills**：`[]`
### 当前代码锚点
- `src/projection/projection-builder.ts`
- `src/projection/messages-transform.ts`
- `src/projection/policy-engine.ts`
- `src/projection/reminder-service.ts`
- `src/identity/visible-sequence.ts`
- `src/identity/canonical-identity.ts`
### 必须附带的原文引用
引用：`DESIGN.md:170-185`
> 当 assistant 已经有正文时，把 assistant 的 visible id **直接放到正文最前面**。只有在模型只发出 tool 调用、完全没有 assistant 文本时，才补一条**合成 assistant 消息**来承载 assistant 侧的 visible ID。
>
> - 这条 assistant 壳文本只写 **visible id 本身**，不要再写 “Calling <tool>” 之类额外说明
> - 如果 assistant 已经有正文，不额外补壳，直接把 id 放到正文最前面
> - 如果 assistant 没有正文，补一条只含 id 的壳
引用：`DESIGN.md:211-214`
> 每个工具返回都必须有**各自独立的 msg id**，直接插到最前面。
>
> - 如果工具输出是普通字符串：把该工具自己的 msg id 直接放在文本最前面
> - 如果工具输出是 Responses API content array：把该工具自己的 msg id 插到数组最前面的 `input_text` 位置
引用：`DESIGN.md:479-500`
> 最终渲染到模型可见文本时（single-exit）：
> [protected_000001_q7] ...
> [compressible_000002_m2] ...
> [compressible_000003_k9] ...
> [referable_000003_w1] ...
>
> Reminder 消息**不写入 visible id 序号**到消息层。如果数据库需要记录 reminder 的序号，写在数据库里，永久保留。
引用：`DESIGN.md:754-778`
> - `allowDelete=false`：replacement 作为可引用块留在 projection 中，原始源跨度被隐藏；该压缩块之后不得被删除
> - `allowDelete=true` 且执行普通压缩：replacement 作为可引用块留在 projection 中，原始源跨度被隐藏；该压缩块之后仍可进入删除路径
> - `allowDelete=true` 且执行直接删除：projection 渲染为极简 delete notice，原始源跨度被移除
> - 无论哪种情况，已压缩的内容都不再参与下一轮压缩
>
> 一旦某个窗口压缩成功，projection view 中与该窗口职责直接相关、已过期的 artifact 可以统一移除，包括：
> - 已被 replacement 覆盖的 mark tool 调用
> - 窗口内部已失效的 reminder
引用：`DESIGN.md:407-411`
> 当某个压缩窗口成功提交 replacement 后，该窗口内**已过期的 reminder**应从 prompt-visible view 中一并消失。
### 产出物
- 新的 single-exit 渲染实现
- reminder 不写消息层序号
- replacement / delete notice / mark 清理 / reminder 清理全部对齐
### 禁止事项
- 禁止 reminder 继续占用永久 visible seq
- 禁止 assistant shell 出现额外说明文字
- 禁止 tool msg id 放在文本尾部
### 完成判据
- projection 测试全面按 `DESIGN.md` 文案与结构重写
- 实际输出可以直接与原文示例逐项比对
---
## T6. Compaction 输入、Runner、Transport、失败语义重构
### 任务目的
确保压缩输入边界、模型调用、失败重试、delete/compact 两分支、占位符约束与结果组提交都符合 `DESIGN.md`。
### 推荐子 agent
- **类型**：`deep`
- **load_skills**：`[]`
### 当前代码锚点
- `src/compaction/input-builder.ts`
- `src/compaction/output-validation.ts`
- `src/compaction/runner.ts`
- `src/runtime/default-compaction-transport.ts`
- `src/transport/contract.ts`
### 必须附带的原文引用
引用：`DESIGN.md:603-610`
> - `projection-builder` 负责生成当前轮给模型看的 derived prompt view
> - `compaction-input-builder` 负责基于当前有效 mark 节点所覆盖的原始范围构造压缩专用输入
> - 不要复用 projected prompt view 再去“清洗”出 compaction 输入；正确行为应来自清晰输入边界，而不是靠后续补救。
引用：`DESIGN.md:903-910`
> compaction transport 的硬目标是：
> - 独立于普通 `session.prompt` / `prompt_async` 路径
> - 不污染普通会话历史
引用：`DESIGN.md:596-601`
> - 压缩失败不写 replacement 结果组
> - 合法 mark 仍保留在覆盖树语义中，等待后续重试或 fallback 模型成功
> - 当前 compaction 尝试可以停
> - 若普通对话正在等待，则等待应在"终态失败"这里结束，而不是机械地再等到 timeout
引用：`DESIGN.md:1341-1357`
> - `delete` 不是第二套独立子系统
> - 它和 `compact` 共用同一套“范围 → 小模型 → replacement 结果组 → hook 替换”的机制
>
> 在 projection 端：
> - 二者都表现为“这段原范围被某组 replacement 接管了”
> - 最终的替换逻辑是相同的
引用：`DESIGN.md:1376-1389`
> 1. 用 XML 明确包裹不可压缩片段
> 2. 为每个不可压缩片段提供唯一占位符
> 3. 提示模型输出中必须保留这些占位符，并据此组织压缩结果
>
> 如果模型输出**没有出现应当保留的占位符**，则应视为压缩错误，而不是部分成功。当前推荐的运行时流程为：
> => 判定为输出错误
> => 先在当前模型上按配置的重试次数继续重试
> => 重试耗尽仍失败，则 fallback 到下一个模型
### 产出物
- 新 compaction input builder
- runner / output validation / transport 边界对齐
- 对“不可压缩片段占位符”的验证逻辑
- delete / compact 共用结果组机制
### 禁止事项
- 禁止复用 projected prompt view 反推 compaction input
- 禁止把 delete 实现成第二套平行机制
- 禁止在失败时提交半成品结果组
### 完成判据
- compaction 相关测试可证明：失败不提交、结果组原子生效、占位符缺失即错误、模型链 fallback 合法
---
## T7. Scheduler / Gate / Batch Freeze / 运行时门闩对齐
### 任务目的
让普通对话等待入口、batch 冻结、lock 生命周期、chat.params 职责与 `DESIGN.md` 的运行时门控模型保持一致。
### 推荐子 agent
- **类型**：`deep`
- **load_skills**：`[]`
### 当前代码锚点
- `src/runtime/chat-params-scheduler.ts`
- `src/runtime/send-entry-gate.ts`
- `src/runtime/file-lock.ts`
- `src/runtime/lock-gate.ts`
- `src/runtime/frozen-batch.ts`
- `src/marks/batch-freeze.ts`
### 必须附带的原文引用
引用：`DESIGN.md:618-642`
> - 后台压缩任务**真正开始时**写入 lock 文件
> - 所有 retry/fallback 尝试全部完成后清除（成功或失败都清）
> - 超过 `compressing.timeoutSeconds` 后，后续请求自动忽视该 lock
> - 手动删除 `locks/<session-id>.lock` 可恢复
>
> - **普通对话继续发送时等待**：等待到 lock 解除/终态失败/超时/手工恢复后再继续
> - **DCP mark 工具不进入当前运行 batch**：当前 batch 在 dispatch 时已经冻结，后续写入自然不属于当前 batch
> - **非 DCP 工具调用不阻塞**
>
> 普通对话的等待应发生在**真正进入 send path 之前的 send-entry gate**，而不是依赖 `chat.params` 晚期返回错误。
引用：`DESIGN.md:885-897`
> `chat.params` 如果保留，只承担：
> - 读取当前 session 是否处于 `compressing`
> - 当满足条件时调度后台 compaction job
> - 写入或读取少量 runtime 级 metadata
>
> `chat.params` 不应承担：
> - 组装完整 transcript
> - 决定 reminder 放在哪条消息后
> - 渲染 visible id
> - 删除或插入 mark / replacement 消息
> - 普通对话等待入口
引用：`DESIGN.md:1036-1038`
> 当前 compaction batch 的 mark 集合在 dispatch 时冻结；lock 期间新写入的 mark 自然进入下一轮，不需要 special-case branching。
### 产出物
- gate / scheduler / lock 行为与 `DESIGN.md` 精确对齐
- send-entry wait 行为稳定
- batch freeze 语义适配新 replay 模型
### 禁止事项
- 禁止把普通对话等待入口重新塞回 `chat.params`
- 禁止让 lock 期间新增 mark 混入当前 batch
### 完成判据
- 运行时门闩相关测试按设计语义通过
---
## T8. 测试、文档、遗留资产统一收口
### 任务目的
在主实现完成后，统一测试命名、断言、文档、旧 route 话语、旧 prompt 资产，彻底消除“代码按新设计、验证按旧口径”的错位。
### 推荐子 agent
- **类型**：`writing`
- **load_skills**：`[]`
### 当前代码锚点
- `tests/cutover/*.test.ts`
- `tests/e2e/*.test.ts`
- `README.md`
- `DESIGN-CHANGELOG.zh.md`
- `prompts/reminder-soft.md`
- `prompts/reminder-hard.md`
### 必须附带的原文引用
引用：`DESIGN.md:939-943`
> - `tests/cutover/runtime-config-precedence.test.ts` — 配置、prompt、日志、env 优先级
> - `tests/cutover/legacy-independence.test.ts` — 无旧 runtime/tool/provider 所有权下的规范执行
> - `tests/cutover/docs-and-notepad-contract.test.ts` — 操作员文档和持久记忆契约审计
> - `tests/e2e/plugin-loading-and-compaction.test.ts` — 插件加载、mark 流、scheduler seam、committed replacement 路径
> - `tests/e2e/delete-route.test.ts` — 旧文件名；当前应理解为 `allowDelete=true` / delete-style 行为覆盖
引用：`DESIGN.md:947-967`
> - 宿主暴露的 legacy 工具已能在真实会话里提供 keep 与 delete 的端到端证明
> - 仓库已提供默认生产 compaction executor transport
>
> 但完整的 keep / delete 成功路径仍以仓库自动化测试为准，不能把“看见了模型流量”误写成“真实会话已完成 keep / delete 证明”。
引用：`DESIGN.md:819-821`
> - `prompts/reminder-soft.md` — 旧版 soft reminder，需要被 `reminder-soft-compact-only.md` 和 `reminder-soft-delete-allowed.md` 替代
> - `prompts/reminder-hard.md` — 旧版 hard reminder，需要被 `reminder-hard-compact-only.md` 和 `reminder-hard-delete-allowed.md` 替代
### 产出物
- 所有测试断言与命名统一到 `DESIGN.md`
- 删除或重命名旧 route 话语
- 文档统一强调：`DESIGN.md` 为准，changelog 为变更提示
### 禁止事项
- 禁止继续保留把旧契约包装成“当前行为”的 README / e2e 用语
- 禁止删除测试来规避未实现行为；测试应改为验证 `DESIGN.md`
### 完成判据
- 仓库内核心文档、e2e、cutover、prompt 资产口径统一
- 对新工程师来说，不再存在“文档、测试、代码各说各话”的入口体验
---
## 总控子 agent 通用 Prompt 骨架（必须复制使用）
以下骨架供后续真正分派任务时直接使用。所有关键设计点请直接嵌入原文引用，不要自己转述：
```text
1. TASK: <只写一个原子目标>
2. EXPECTED OUTCOME: <必须包含具体交付物、改哪些文件、哪些行为会变化>
3. REQUIRED TOOLS: <仅列本任务允许的工具>
4. MUST DO:
   - 严格以 DESIGN.md 为准
   - 直接引用以下原文，不要自己改写：
     - <粘贴 DESIGN.md 行号 + 原文>
     - <粘贴 DESIGN-CHANGELOG.zh.md 行号 + 原文（若需要）>
   - 同步更新相关测试
   - 实现完成后给出“改动点 / 未决点 / 验证结果”
5. MUST NOT DO:
   - 不得以当前代码行为反推设计
   - 不得保留旧 route 语义作为公共契约
   - 不得用自己的话替代关键设计原文
6. CONTEXT:
   - Repo root: /root/_/opencode/opencode-context-compression
   - Current anchor files: <列出现有文件>
   - Truth source: DESIGN.md
   - Change hints only: DESIGN-CHANGELOG.zh.md
```
---
## 实施前自检（总控必做）
在真正开始任何编码任务前，总控必须逐条确认：
1. 子任务 prompt 是否贴了关键原文，而不是口头描述？
2. 是否明确了当前代码锚点文件？
3. 是否写清楚了“禁止保留旧契约”的范围？
4. 是否给了测试更新要求？
5. 是否给了完成判据？
6. 遇到 `DESIGN.md` 内部张力时，是否要求子 agent 并列引用原文、而不是自行裁决？
如果以上任一项缺失，不应开始实现。
