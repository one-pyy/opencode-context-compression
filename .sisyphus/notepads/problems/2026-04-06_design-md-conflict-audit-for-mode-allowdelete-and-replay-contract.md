## design-md-conflict-audit-for-mode-allowdelete-and-replay-contract
Date: 2026-04-06
Task: current-session

### Symptom
`DESIGN.md` currently contains multiple internal tensions across the mark/replacement/runtime model. These tensions matter because the later sections redefine the tool contract and source-of-truth model, but earlier sections still describe older persistence semantics. A design-driven refactor cannot silently collapse these into a paraphrase without recording the original text side by side.

### Trigger Conditions
This appears when implementing the 2026-04-06 design-alignment refactor against these `DESIGN.md` areas at the same time:

- `DESIGN.md:434-438`
- `DESIGN.md:522-526`
- `DESIGN.md:989-995`
- `DESIGN.md:1095-1105`
- `DESIGN.md:1111-1146`
- `DESIGN.md:1150-1162`

### Implementation Conflict Audit Table
1. **`allowDelete` 的持久语义 vs delete admission gate**

   原文 A — `DESIGN.md:434-438`

   > `allowDelete` 是与目标消息、mark、source snapshot、replacement 相关的局部语义位，不是全局 runtime config 根级开关。
   >
   > 当前设计中，`allowDelete` 应作为 mark / replacement / canonical source 的语义属性被保存和比较，而不是作为 repo 级统一 route 被广播。

   原文 B — `DESIGN.md:989-995`

   > `allowDelete` 决定当前运行时是否允许创建 delete 型 mark；它不是 keep/delete route 枚举，也不是 mark / replacement / canonical source 的长期局部语义位。
   >
   > - `allowDelete=false`：允许 `mode=compact`，拒绝 `mode=delete`
   > - `allowDelete=true`：允许 `mode=compact`，也允许 `mode=delete`

   原文 C — `DESIGN.md:1127-1146`

   > - `mode`：本次 tool 调用明确请求的动作，取值为 `compact` 或 `delete`
   > - `allowDelete`：当前运行时策略是否允许创建 `delete` 类 mark 的**准入条件**
   >
   > 3. `allowDelete` 不再作为 mark 长期记忆“未来能力”的业务字段
   >    - 它只在 mark tool 调用的 admission 阶段起作用
   >    - 一旦 tool 调用被接受，后续历史解释只依赖 `mode`

   不得擅自归纳的说明：前文仍把 `allowDelete` 写成 mark / replacement / canonical source 的持久语义位，后文则明确改成 admission-only gate。实现时不能只保留其中一个表述而假装另一段不存在。

   结论：**需要主实现任务并列满足**；在代码层面按后文 `mode` + admission gate 重构时，必须显式说明这是在处理文档内部张力，而不是“当前文档始终一致”。

2. **`compression_mark` 立即返回 mark id vs 当前工具仍带持久化描述文本**

   原文 A — `DESIGN.md:522-526`

   > - `contractVersion` 是 `v1`
   > - `mode` 是 `"compact" | "delete"`
   > - `target.startVisibleMessageID` 和 `target.endVisibleMessageID` 来自当前 projected visible view
   > - 工具调用成功时立即返回随机 mark id
   > - 如果 `mode=delete` 且当前策略不允许 delete，该次 tool 调用返回错误信息

   原文 B — `DESIGN.md:1111-1115`

   > - 它接收一个**单一范围**（单条消息也视作范围）
   > - 一次调用只允许一个范围，不允许在一次调用里枚举多个子目标
   > - 如果需要多个 mark，模型必须在**同一轮回答中多次调用该工具**
   > - 工具真正立即返回的，只是一个随机生成的 **mark id**

   不得擅自归纳的说明：这里要求的是公共工具契约本身收敛为 `mode` + mark-id return；不能把当前实现里“Persisted compression_mark ... allowDelete: ...”这种描述性返回值继续视为等价实现。

   结论：**需要主实现任务并列满足**；工具输入/输出契约、测试断言、以及依赖该返回文本的运行时假设都要一起迁移。

3. **Projection / scheduler 主真相源：SQLite 持久 mark vs 历史重放**

   原文 A — `DESIGN.md:1095-1105`

   > 1. **旧理解**：mark tool 调用后，立即把 mark/source snapshot 等状态写入 SQLite，之后 projection 主要依赖数据库里的 mark 记录做 lookup。
   >    - **新理解**：mark tool 调用只向宿主历史留下一个 tool 结果；projection 的主入口是**顺序重放历史里的 mark tool 调用**。
   >
   > 4. **旧理解**：替换命中主要通过持久 mark / canonical source 结构比对。
   >    - **新理解**：替换命中的主键是历史里真实出现的 mark id；hook 通过重放 mark tool 调用、构造覆盖树、再按 mark id 去数据库取结果。

   原文 B — `DESIGN.md:1122-1125`

   > 当前目标模型下，mark tool 调用**不要求**在调用时立即写入 marks/source_snapshots 之类的持久业务状态。当前权威语义是：
   >
   > - 历史中的 tool 调用本身，才是 mark 意图的真相源
   > - SQLite 只需存与该 mark id 关联的压缩结果组及必要运行时缓存/执行元数据

   原文 C — `DESIGN.md:1150-1162`

   > 1. 从头到尾遍历当前历史中的 mark tool 调用
   > 2. 按顺序**模拟执行**这些 mark tool 调用
   > 3. 根据覆盖规则构造当前有效的 mark 结构
   > 4. 按 mark id 去数据库查找已有压缩结果
   > 5. 用“有结果优先，否则回退”的方式渲染当前最终视图

   不得擅自归纳的说明：这些段落明确把“数据库里的持久 mark 状态”降级成旧理解；因此任何仍以 `store.listMarks()` 为 projection 或 scheduler 主入口的实现，都不能再被说成“符合 DESIGN.md”。

   结论：**需要主实现任务并列满足**；projection、scheduler、batch freeze、测试夹具都需要一起迁移到 replay-first 语义。

### Resolution
UNRESOLVED

后续实现必须在提交说明中直接引用上面的原文对，而不是把冲突压缩成一句“现在以新版为准”。如果某个子任务只能局部过渡，就必须明确写出它仍保留了哪一侧旧语义，以及该残留会影响哪条设计规则。

### Side Effects
这不是单点文案问题。它直接影响：

1. `compression_mark` 的公共输入输出契约
2. `marks` / `source_snapshots` / `replacements` 的 sidecar 角色
3. `messages.transform` 与 `chat.params` 的主数据来源
4. e2e / cutover / projection 测试是否仍在替旧契约背书
