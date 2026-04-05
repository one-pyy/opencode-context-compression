# T0 文档引用冻结与实现冲突审计表

## 1. 引用基线与使用顺序

### 1.1 真相源与补充源

引用：`DESIGN.md:1074-1076`

> 本章是对当前运行时模型的详细展开：把前文已经给出的规则，用更完整的生命周期说明、形式化约束与大量例子重新讲透。它是当前自洽设计的详细解释部分，不应被理解成“前文可以保留冲突语义”的覆盖章。

引用：`DESIGN-CHANGELOG.zh.md:15-18`

> 本轮设计文档不是简单整理旧文档，而是在旧文档基础上做了多项**目标设计收敛**。因此，文档中有些内容代表“未来实现必须遵守”，不应被误读成“当前代码已完全做到”。

引用：`DESIGN-CHANGELOG.zh.md:240-246`

> 当前 `DESIGN.md` 里相当一部分是目标设计
> 尤其是本轮临时拍板的内容，当前代码未必已经做到
> 实现前必须逐项核对，不应把文档直接当成“现状说明书”

本表的使用规则只有三条：

1. `DESIGN.md` 是唯一真相源。`DESIGN-CHANGELOG.zh.md` 只用于提示“相对当前代码库的变更点”和补充核对项，不能越权覆盖 `DESIGN.md`。
2. 后续实现任务引用关键设计点时，优先直接贴本表中的原文引文，不要把下面的结论再口号化简。
3. 既有 notepad 决策记录只作为核对提醒，不作为裁决 `DESIGN.md` 内部张力的更高权威。

## 2. 既有决策记录的定位

以下记录已核对，用作后续任务的辅助索引，不用来替代 `DESIGN.md`：

- `.sisyphus/notepads/decisions/2026-04-04_assistant-visible-id-prefix-when-body-exists.md`
  - 与 `DESIGN.md:168-185` 的 assistant 正文前置 id 规则一致。
- `.sisyphus/notepads/decisions/2026-04-04_tool-only-assistant-shell-and-per-tool-msg-id-rendering.md`
  - 与 `DESIGN.md:168-214` 的 tool-only assistant 壳和 per-tool msg id 规则一致。
- `.sisyphus/notepads/decisions/2026-04-04_design-doc-reminder-cadence-and-allowdelete-contract.md`
  - 与 `DESIGN.md` 中“reminder 仍按 token cadence 重复”和“delete 路径属于正式能力”方向一致，但不能拿它去裁决 `DESIGN.md` 内部的 `allowDelete` 持久语义张力。

## 3. 实现冲突审计表

### 冲突 1：`allowDelete` 到底是不是需要随 mark / replacement / canonical source 长期保存的语义位

| 字段 | 内容 |
|---|---|
| 原文 A 引用 | `DESIGN.md:434-438`<br><br>> `allowDelete` 是与目标消息、mark、source snapshot、replacement 相关的局部语义位，不是全局 runtime config 根级开关。<br>> 当前设计中，`allowDelete` 应作为 mark / replacement / canonical source 的语义属性被保存和比较，而不是作为 repo 级统一 route 被广播。 |
| 原文 B 引用 | `DESIGN.md:989-995`<br><br>> `allowDelete` 决定当前运行时是否允许创建 delete 型 mark；它不是 keep/delete route 枚举，也不是 mark / replacement / canonical source 的长期局部语义位。<br>> - `allowDelete=false`：允许 `mode=compact`，拒绝 `mode=delete`<br>> - `allowDelete=true`：允许 `mode=compact`，也允许 `mode=delete` |
| 原文补充引用 | `DESIGN.md:1127-1146`<br><br>> - `mode`：本次 tool 调用明确请求的动作，取值为 `compact` 或 `delete`<br>> - `allowDelete`：当前运行时策略是否允许创建 `delete` 类 mark 的**准入条件**<br>> 3. `allowDelete` 不再作为 mark 长期记忆“未来能力”的业务字段<br>>    - 它只在 mark tool 调用的 admission 阶段起作用<br>>    - 一旦 tool 调用被接受，后续历史解释只依赖 `mode` |
| 不得擅自归纳说明 | 不得口头化简成“第 15 章已经把第 4 章覆盖掉了”。`DESIGN.md:1074-1076` 已明示第 15 章是详细展开，不是允许前文保留冲突语义的覆盖章。也不得擅自简化成“allowDelete 只是运行时开关”或“allowDelete 必须永久入库”二选一口号。 |
| 结论 | **先停下提交冲突说明。** 任何后续任务只要要决定 `allowDelete` 是否写入 mark、replacement、canonical source 或其校验结构，就不能自行裁决，必须把这组原文并列带回主实现任务。 |

### 冲突 2：projection 与 sidecar 的主真相，到底以持久 mark/source snapshot lookup 为主，还是以历史重放为主

| 字段 | 内容 |
|---|---|
| 原文 A 引用 | `DESIGN.md:430-430`、`DESIGN.md:436-438`、`DESIGN.md:920-926`<br><br>> 删除不是独立的第二套子系统；它仍属于同一条 mark → source snapshot → replacement / delete → projection 语义链<br>> `allowDelete` 是与目标消息、mark、source snapshot、replacement 相关的局部语义位，不是全局 runtime config 根级开关。<br>> 当前设计中，`allowDelete` 应作为 mark / replacement / canonical source 的语义属性被保存和比较，而不是作为 repo 级统一 route 被广播。<br>> - `mark-service` — 记录 mark、查找 mark 对应 canonical source、标记已消费关系<br>> - `replacement-service` — 按 canonical source 匹配 replacement，并校验其在当前 history 下是否仍有效<br>> - `compaction-input-builder` — 从 canonical source snapshot 构造压缩专用输入；不要复用 projected prompt view |
| 原文 B 引用 | `DESIGN.md:1095-1105`、`DESIGN.md:1122-1125`<br><br>> 1. **旧理解**：mark tool 调用后，立即把 mark/source snapshot 等状态写入 SQLite，之后 projection 主要依赖数据库里的 mark 记录做 lookup。<br>>    - **新理解**：mark tool 调用只向宿主历史留下一个 tool 结果；projection 的主入口是**顺序重放历史里的 mark tool 调用**。<br>> 4. **旧理解**：替换命中主要通过持久 mark / canonical source 结构比对。<br>>    - **新理解**：替换命中的主键是历史里真实出现的 mark id；hook 通过重放 mark tool 调用、构造覆盖树、再按 mark id 去数据库取结果。<br>> 当前目标模型下，mark tool 调用**不要求**在调用时立即写入 marks/source_snapshots 之类的持久业务状态。当前权威语义是：<br>> - 历史中的 tool 调用本身，才是 mark 意图的真相源<br>> - SQLite 只需存与该 mark id 关联的压缩结果组及必要运行时缓存/执行元数据 |
| 原文补充引用 | `DESIGN.md:1926-1934`<br><br>> 为避免误读，下列旧条目在实现时必须按本章重解释：<br>> 1. 前文所有把 `allowDelete` 解释成 mark / replacement 长期持久语义位的段落<br>>    - 现在应理解为：delete admission 的当前策略门槛，而不是 mark 真相源<br>> 2. 前文所有把 projection 主要建立在“持久 marks/source snapshot lookup”上的段落<br>>    - 现在应理解为：以历史重放为主，以数据库结果组 lookup 为辅 |
| 不得擅自归纳说明 | 不得口头化简成“老章节已经作废，所以 schema 直接按重放版重写”或“既然有 mark-service/replacement-service，就继续把 marks/source_snapshots 当主真相”。这里牵涉 sidecar 数据模型、store API、projection 主入口、compaction input builder 的职责边界，不能凭局部条目拍板。 |
| 结论 | **先停下提交冲突说明。** 凡是涉及 SQLite schema、store API、mark/source snapshot 是否持久落库、projection 主 lookup 路径的任务，都必须先并列引用这组原文。 |

### 张力 3：`已压缩内容不再参与下一轮压缩` 应如何与“可被更大范围包含或被 delete 覆盖”同时成立

| 字段 | 内容 |
|---|---|
| 原文 A 引用 | `DESIGN.md:756-759`<br><br>> - `allowDelete=false`：replacement 作为可引用块留在 projection 中，原始源跨度被隐藏；该压缩块之后不得被删除<br>> - `allowDelete=true` 且执行普通压缩：replacement 作为可引用块留在 projection 中，原始源跨度被隐藏；该压缩块之后仍可进入删除路径<br>> - `allowDelete=true` 且执行直接删除：projection 渲染为极简 delete notice，原始源跨度被移除<br>> - 无论哪种情况，已压缩的内容都不再参与下一轮压缩 |
| 原文 B 引用 | `DESIGN.md:586-595`、`DESIGN.md:1098-1103`、`DESIGN.md:1936-1937`<br><br>> 当前模型下，compact 结果不能再次被当成自由文本进行内部改写。<br>> 更精确地说：<br>> - compact 结果可以作为不可压缩原子块进入更大范围<br>> - delete 可以整段删除它<br>> - 但不能把这个 compact 结果再次展开成原始文本并改写其内部内容<br>> 3. **旧理解**：压缩后的内容完全不能再进入任何后续压缩处理。<br>>    - **新理解**：压缩结果的**内部内容不能被再次改写**，但该结果块可以作为不可压缩原子片段，被包含进更大的后续压缩范围中；delete 也可以整段删除它。<br>> 3. 前文所有把“压缩后内容不能再次压缩”理解成“压缩块不能进入任何更大后续范围”的段落<br>>    - 现在应理解为：不能再次内部改写，但可以作为原子占位块被更大范围包含，或被 delete 整段覆盖 |
| 不得擅自归纳说明 | 不得把它口头化简成“压缩块以后完全不能再碰”，也不得反过来化简成“既然能进更大范围，那就等于可再次压缩”。这里区分的是“内部再次改写”与“作为原子块被包含/覆盖”两层语义。 |
| 结论 | **需要主实现任务并列满足。** 后续 projection、coverage tree、compaction input builder、delete 分支实现都要同时满足这两组原文，不能只保留其中一句。 |

## 4. 后续任务的直接引用规则

1. 只要任务碰到 `allowDelete` 字段去留、sidecar schema、mark/source snapshot 持久化、replacement lookup 主路径，必须直接引用“冲突 1”或“冲突 2”。
2. 只要任务碰到 compact 结果是否还能进入更大范围、delete 是否能覆盖 compact 块，必须直接引用“张力 3”。
3. 若任务 prompt 需要精简上下文，允许只保留“文件路径 + 行号 + 原文块 + 本表结论”，不允许只保留一句自写总结。

## 5. 当前无法在 T0 裁决、必须留给后续实现并列满足或升级说明的点

- `allowDelete` 是否属于 mark / replacement / canonical source 的长期持久语义位。
- projection 与 replacement lookup 是否仍允许以持久 mark/source snapshot 为主入口。
- compact 结果的“禁止再次压缩”是否被错误实现成“禁止进入更大范围或 delete 覆盖”。

这三点里，前两点属于**需要先停下提交冲突说明**，第三点属于**需要后续实现并列满足**。
