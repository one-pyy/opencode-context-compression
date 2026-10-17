# 压缩工具公共契约（已实现）

## 文档定位

本文档描述 `compression_mark` 与 `compression_inspect` 的职责、输入输出与 replay 入口语义。

## 职责边界

`compression_mark` 只负责打 tag / mark：

- 不负责压缩执行
- 不负责调度
- 不负责 prompt projection

`compression_inspect` 只负责请求查看当前可见范围内尚未被压缩结果覆盖的 compressible 消息 token 情况：

- 不负责计算 token
- 不负责读取 sidecar
- 不负责压缩执行或调度

## 工具契约

### 内容保留与持久化

普通 `compact` 可由选区内明确结论与 `hint` 承接，不要求另写摘要文件。结论保留后续所需的结果、依据、约束、限制及资料入口；仍依赖原文判断的活跃内容不标记。`hint` 指定保留项，不能代替事实核对或完整原件。

需要摘要之外完整保存、跨会话交付或独立恢复的材料，优先维护已有 Docs、任务、运行记录、候选或证据载体；缺少落点才补按用途组织的短记录。临时工作材料同样就地维护当前有效结论、依据、未决项和下一步，替换失效状态；原始日志、快照和验证证据保留并引用，不把工作文档写成逐轮操作流水账。

`delete` 不可召回，仍有效信息先留存并核对，已有记录充分时直接复用；详细准入见[目标与保留标准](allow-delete.md#目标与保留标准)。

### 输入与标记

- `mode` 是 `"compact" | "delete"`
- `from` 与 `to` 来自当前 projected visible view
- `from` 与 `to` 是双闭区间端点，端点消息自身也包含在目标范围内
- `from` 与 `to` 解析到目标范围：宿主消息端点按 `seq6 + base62` 定位；`referable` 区间标记必须唯一匹配当前结果组的片段标记，再按 `seq6` 解析到它覆盖的来源消息，可直接用于跨已压缩范围选区。两种端点都必须完整覆盖范围内的摘要片段
- `from` 与 `to` 的书写形态是 `<visible-type>_<seq6>_<base62>`；replay 不把 `visible-type` 当作长期身份字段：宿主消息端点按稳定的 `seq6 + base62` 定位，`referable` 端点先按标记 id 匹配当前结果组、再按 `seq6` 定位。身份层规则见 [visible id 系统](../projection/visible-id-system.md#mark-端点匹配规则)
- 工具说明要求调用时带类型前缀，解析仍兼容带前缀与裸宿主端点。从 inspect 清单选区时，compact atom 与 `kind=compressible` 端点补 `compressible_`，`kind=user` 端点补 `protected_`，fragment 端点保留 `referable_`；序号与校验后缀原样复制。
- 端点无法解析到宿主消息、或 `referable` 端点匹配不到当前结果组片段（含过期与多义）时，该次调用不创建 mark，并按失败结果呈现
- 成功调用时立即返回随机 `mark id` 和范围词元估计 `tokenCount`，计数口径见下文
- `mode=delete` 且当前策略不允许 delete 时，返回错误结果
- 主 agent 使用 delete 须遵循 [退役执行准则](allow-delete.md#退役执行准则)，按后续是否有用自主选区；普通 reminder 和 cpmark 对未压缩原文使用 compact，附带退役指令时另行检查已应用摘要。
- `mode=delete` 的目标范围可包含用户消息；是否从投影移除用户原文由 [删除契约](allow-delete.md#目标与保留标准) 定义，不由 `smallUserMessageThreshold` 单独决定

## Inspect 工具契约

- `compression_inspect` 输入为 `{ to, mode?, mergeAdjacent? }`；`mode` 缺省为 `"compact"`，`mergeAdjacent` 缺省为 `true`
- 工具调用当下只返回 `inspectId` 占位结果
- 后续 `messages.transform` 使用当前 `ProjectionState.messagePolicies` 中已经计算出的 `tokenCount` 生成真实结果
- compact 模式下，以 `to` 为包含端点的上界，清单显示当前可见首个至最后一个 compressible 条目之间的原文与 referable 摘要；不显示 protected 消息。上界内没有 compressible 条目时显示空表
- delete 模式下，inspect 范围从当前投影中的首个非 system 可见条目开始，到 `to` 端点结束；这样开头就存在的摘要片段与短用户消息不会被漏掉。`mergeAdjacent` 在 delete 模式下不生效
- 成功清单使用 TSV，列依次为类型、起点、终点、token数。两种模式均隐藏 protected 行，类型使用 compressible、referable；端点保持原 inspect 规则，原文使用裸宿主编号，摘要使用完整 referable 标记对
- `mergeAdjacent=true` 时，连续 compressible 消息合为一行；protected 消息与 referable 摘要均隔开原文区间。默认模式隐藏 protected 行，但仍保留其分段作用
- 行始终按消息先后排列。compact 模式下 `tokens <= 0` 的原文条目不生成行
- `mergeAdjacent=false` 时，compact 模式逐消息展示原文，仍显示范围内摘要；delete 模式忽略该参数
- 表外给出模式和显示行的 token 合计；默认原文使用策略计数，摘要与 delete 条目使用当前可见文本计数。合计不等同于面板摘要 del，不将摘要与原文混作可压缩 token
- `compression_inspect` 的 `to` 端点按 `seq6` 定位，`referable` 区间 id 可以用于 inspect；mark 的端点规则见 [工具契约](#工具契约)
- 清单只提供确定性的范围与计数，不判断内容是否已完成，也不构成自动 mark 建议；语义选择由调用模型完成

压缩以完整任务、完整事件或多个已完成任务为单位。先确定任务或事件的语义边界，再整体标记其中符合条件的连续范围；不要逐条挑选消息，也不要把同一任务拆成多次小范围标记。跨 inspect 分段选区，统计分段不决定 mark 边界；仅为绕开仍需完整保留的 skill 正文或活跃上下文，或满足区间合法性与模型输入预算时，才拆成必要的少数几段。检查此前部分压缩任务的未处理残余，一并处理符合条件的内容。成功但尚未应用的标记视为已处理，避免重复覆盖；已应用 compact 可以完整纳入更大选区。涉及摘要时须完整覆盖片段，delete 还须满足下方的标记包含规则。hint 指定范围内的关键保留项，不替代选区准入和信息留存检查。

当前任务仍需直接使用的完整 skill 正文、协议或其他参考内容，可以通过缩短选区或拆成前后两个合法范围绕开，保留在上下文中，不必为了合并标记而纳入压缩。调整的是消息范围，不截断消息正文；已有 compact 标记及摘要片段仍须遵守相应的完整覆盖和区间冲突规则，不能任意切割。

`mode="delete"` 时，同一 TSV 清单显示上界内全部 compressible 与 referable 区间，包括边缘摘要。protected 用户消息不显示，但仍划分连续原文区间；有效用户要求须从上下文核对。以下是内部条目与展示类型的映射；内部 JSON 占位、错误结果和旧成功记录仍供历史重放解析，模型可见成功清单单独渲染为 TSV。

- `kind=fragment` 展示为 referable：当前投影中已应用的 compact 摘要片段，`from` 与 `to` 是该片段的 `referable` 区间标记，可直接作为 `compression_mark` 端点。这是唯一保留 `referable_` 前缀的条目类型，因为只有该类型会走片段标记解析路径
- `kind=user` 是内部的 protected 用户消息条目，不展示也不计入表格总计；其存在仍划分连续原文区间。compressible 的用户消息已进入 `kind=compressible` 条目
- `kind=compressible`：范围内连续的 compressible 消息段，`from` 与 `to` 为宿主消息 id，省略 `compressible_` 前缀
- system 消息不进入清单；已被 delete 结果接管的来源不再出现在投影中，因此也不会成为条目
- delete 条目 token 估算基础投影中的完整可见正文：`fragment` 报当前摘要，`user` 报用户正文，`compressible` 报当前未压缩的正文及工具输入、输出和错误正文；`totalTokens` 是清单条目合计。投影预计算每条可见文本并复用共享渲染器与同一估算器，缺少预计算值时按相同完整文本做字符近似；短用户消息不因 protected 分类而记为零。compact 模式继续使用 `messagePolicies` 的原始消息策略计数。投影前缀与原始消息不同，因此两种模式的逐条计数不要求完全相等。
- delete mode 只展示当前可选的条目，不做 `allowDelete` 准入判断；实际 delete 仍由 `compression_mark` 的 [Admission 规则](allow-delete.md#admission-规则) 拒绝
- reminder 可附带 delete 模式清单供 compact 与摘要退役两项动作使用；调用输入明确携带相同 `mode` 与 `to`。满足所需跨度时直接复用清单，模式与范围不足时再请求 inspect。

compact 模式的 token 数据来自消息级策略；delete 模式复用当前投影文本计数，都不从 mark tree 反推大小：

1. `messagePolicies` 持有 canonical 消息的 `tokenCount`。
2. 最终 projected messages 提供当前可见的 protected / compressible / referable 顺序，已被 replacement 接管的 source 不再作为 compressible 返回。
3. `compression_inspect` 按输入 visible-id 上界读取当前可见结构，再按 `mode` 与 `mergeAdjacent` 确定 TSV 行的范围和合并方式。
4. scheduler 则用同一批 message token，按 mark tree range 汇总为 `uncompressedMarkedTokenCount` 后再和自动压缩阈值比较。

因此只有 compact 清单的 compressible 行计数之和、且范围与当前待压 mark range 完全一致时，才应等于 scheduler 的 `uncompressedMarkedTokenCount`；包含摘要的表格总计不用于此比较。

### 分组设计备忘

预留思路：以 referable 摘要为边界，将其间的原文区域编号。同一组可包含多个被 protected 消息隔开的可压缩区间；protected 只切分区间，不改变组号，摘要行本身不属于原文组。这样能表达摘要之间的统计结构，辅助理解已有覆盖。

该分组不是任务或事件分组，也不定义 mark 边界。当前四列 TSV 不展示分组，展示层不计算组号；保留此思路供后续有明确使用需求时评估。

## 成功结果与错误结果的区别

- 成功结果：返回合法 `mark id` 和 `tokenCount`，表示创建了可重放的 mark intent
- 错误结果：本次调用没有成功创建 mark；它仍留在历史与最终可见世界里，但不进入 mark 覆盖树
- 确定性失败结果在最终投影中会被改写为 `{"ok":false,"errorCode":"...","message":"...","details":{...}}` 格式的结构化 tool result，保留原始错误码、具体失败原因与可定位的失败详情
- 已 accepted 但暂无 pending / result 的 mark 仍是正常悬挂状态，不属于失败结果

### 标记范围词元数

成功结果中的 `tokenCount` 表示本次范围内可处理内容的词元估计，不表示后台已经完成压缩，也不表示实际净节省量：

- `compact` 使用范围内当前可见 compressible 原文的策略计数；protected 原文与保持原样的已有摘要不计入。
- `delete` 汇总范围内当前可见正文的预计算词元数，包括摘要和用户原文，system 始终不计入。
- 两个端点均包含在范围内；已有摘要必须完整覆盖。隐藏原文不因其宿主编号仍存在而重复计数。
- 计数读取模型最近看到的投影快照，按会话隔离；每次投影更新对应会话的轻量计数快照，不额外读取历史或调用计数服务。
- 缺少会话快照、范围内所需计数缺失、端点无法解析或范围截断摘要时返回 `null`，不以零冒充未知数量；原有标记准入与重放规则继续适用。空处理范围可以返回 `0`。
- 历史中未带此字段的成功结果继续可重放。提醒建议按本轮成功标记的非重叠覆盖量核对，嵌套或重复范围不重复累计。

### 标记包含冲突

mark 按调用先后重放。compact 可以被 compact 或 delete 完整包含；delete 不能被任何 mark 包含，即 delete 只能作为覆盖树根节点。相同范围按包含处理，由后来的 mark 作为候选父节点。部分交叉继续按重叠冲突拒绝。

后来的 mark 若包住已有 delete，或后来的 delete 严格落在已有 mark 内部，该后来标记被作为 `OVERLAP_CONFLICT` 排除出覆盖树，工具调用的投影返回改写为结构化错误。先有 compact、后有包含它的 delete 仍允许，前提是范围内没有其他 delete。拒绝发生在修改覆盖树之前，不影响已有合法标记及后续选区的判定。

该规则不依赖压缩结果是否存在或替换是否生效，既有历史标记也按同一规则重放。后台只执行合法覆盖树中的标记，因此被拒绝的标记不再调度；原始宿主历史及已存储结果不被改写，替换只消费合法覆盖树上的结果。

## Mark 与 replacement 的关系

mark 是 lookup hint，不是 source of truth：

1. 重放历史中的合法 mark tool 调用
2. 构造当前有效覆盖树
3. 对树上的当前节点按 mark id 去 SQLite 查询结果组
4. 只有存在完整结果组时才替换该范围

## 最小 lookup 结构

当前最小 replacement lookup 结构是：

- mark id
- 原始消息跨度
- 结果组是否完整

命中条件：

1. 节点在覆盖树中仍合法有效
2. 数据库存在该 mark id 对应结果组
3. 结果组完整

## 相关文档

- `allow-delete.md`
- `compaction-lifecycle.md`
- `../operator/compression-mark-usage.md`
