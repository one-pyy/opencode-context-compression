## 摘要端点与原文编号必须使用同一坐标
Date: 2026-10-11

### Pattern

清单里的摘要与原文区间出现数字回退或重叠时，先核对编号坐标：原文的持久可见序号与历史重放中的连续位置不能直接比较。按实际宿主消息身份换算后，才能判断摘要是否与原文重复覆盖。文档要求可见编号永久递增，隐藏或删除只产生空洞；摘要端点应与这一持久编号保持一致。

### Detail

当前 `opencode-context-compression/src/projection/projection-builder.ts` 的 `hydrateMessagePolicies` 从身份分配服务取得原文持久可见编号；`opencode-context-compression/src/runtime/session-history.ts` 的 `collectReplayableEntries` 则从 1 开始为当前历史重新分配重放序号。`opencode-context-compression/src/projection/rendering.ts` 和 `opencode-context-compression/src/projection/compression-inspect.ts` 调用 `buildReferableMarkerIds` 时，把摘要片段保存的 `sourceStartSeq/sourceEndSeq` 直接用于可见端点。这些字段属于历史重放坐标，不能保证等于持久可见编号。

状态库中保留了当前宿主历史已不存在的身份分配时，两套序号会出现差值。例如这次调查的重放区间 1352 到 1353，换算到持久编号后为 1360 到 1361。直接混合展示会制造原文落入摘要数字区间的现象。按数字重排无法修复坐标错位，也不能据此删除原文。

这类症状还应与旧摘要片段的来源范围失效区分：来源范围本身错误时，可能真正替换错消息；仅显示坐标混用时，投影来源仍可能互不重叠。相关旧范围修复入口见 `opencode-context-compression/.sisyphus/docs/operator/live-artifact-investigation.md` 的“Result fragment sequence repair”章节；该流程不是本次已执行的修复。

删除清单的零 token 条目也不能作为重复覆盖的证据。`renderOriginalRange` 对没有正文且没有工具调用的消息生成空文本；`estimateTextTokenCount` 对空文本计数为 0。删除清单仍接纳这些原文条目。这次 7 条零值行均只有推理等非正文部分，没有正文和工具调用。

### 验证依据与边界

Plexus trace `0768ef9a-dee1-4ded-8bb6-cd7405d7eb24`，会话 `ses_eeba2beddffeoosOFLMbGde4TW`。只读读取 `/root/_/opencode/config/plexus/data/plexus.db` 的 `debug_logs`，核对原始请求和转换后请求：删除清单 81 行、总计 59849，14 次相邻起点回退、11 对数字区间重叠、7 条零值行；压缩清单 65 行、总计 110382，8 次回退、7 对数字区间重叠。Plexus 转换未改变这些清单。

使用 `/root/.local/share/opencode/opencode.db` 的宿主消息身份与 `opencode-context-compression/state/ses_eeba2beddffeoosOFLMbGde4TW.db` 的 `visible_sequence_allocations` 换算摘要范围：两份清单的相邻范围回退或重叠均为 0。当前状态库有 16 个身份分配不在当前宿主消息集合中；样本所在区段的重放位置与持久编号相差 8 或 10。

这是 trace 清单与调查时数据库身份映射的交叉验证，不是 trace 时完整投影快照的重放。没有修改源码、数据库或运行配置；编号生成问题仍待修复，没有验证端点解析、重新标记或回查在该错位下的全部行为。

### 既有会话兼容性

统一显示编号不能只修改摘要端点生成。`opencode-context-compression/src/projection/policy-engine.ts` 的 `buildMarkTree` 每轮解析历史标记，摘要端点要求与当前结果片段生成的标识精确匹配；只换成永久编号而不保留旧端点解析时，引用旧摘要端点的历史标记可能被排除，影响覆盖树和原文隐藏。调查时只读统计上述宿主会话，195 次压缩标记调用中有 16 次使用摘要端点，且这 16 次的历史返回均为已接受；该会话没有回查工具调用。这是具体旧端点依赖，不是修复后重放验证。

`opencode-context-compression/src/projection/compression-recall.ts` 当前从端点提取数字，直接在按重放序号建立的消息映射中查找，并用同一数字检查删除范围。因此摘要显示改用永久编号后，回查也必须正确转换到来源坐标，否则可能回查错范围或错误判断删除覆盖。现有 `opencode-context-compression/.sisyphus/docs/compaction/recall-tool-contract.md` 的“定位逻辑”明确记载这一旧机制，修复时需同步有效契约。

兼容目标是复用已有摘要正文与来源记录，新显示采用永久编号，历史标记里的旧端点仍能定位原来的摘要片段。不能把存储的来源字段直接整体替换为永久编号，也不能仅凭新清单显示正确就宣称旧会话兼容。验收应包含编号已有空洞的旧会话、引用旧摘要端点的历史标记重放、新端点再次标记和回查删除边界。本次仅确认影响机制，尚未实现兼容层或运行这些修复验收。

### UPDATE 2026-10-12

用户明确允许旧会话的旧摘要端点失效，因此本次实现不提供旧端点兼容。`opencode-context-compression/src/projection/referable-markers.ts` 统一从来源消息取得永久端点，渲染、inspect 和标记匹配共用该转换；标记树仍使用内部重放坐标。回查按永久编号映射原文，删除范围与错误详情也转换到永久编号。摘要正文及数据库来源字段保持原样。

`opencode-context-compression/tests/architecture/persistent-referable-numbering.test.ts` 使用永久编号 1、3、4、7、8 验证摘要来源重放位置 3 到 4 显示为永久 4 到 7；覆盖清单无回退与重叠、新端点标记定位、旧错位端点拒绝、摘要及原文回查、编号空洞与删除边界。35 项直接相关测试、生产构建及修改源码诊断通过。尚未在真实宿主加载新版本进行验证；没有迁移或修改运行数据库。旧标记失效可能使原文或被接管的摘要再次显示，属于用户接受的破坏性边界。

### Applies To

摘要端点渲染、inspect 的顺序与范围过滤、摘要覆盖核查，以及持久可见编号与重放序号的跨层转换。正式编号契约见 `opencode-context-compression/.sisyphus/docs/projection/visible-id-system.md`。

Tags: #visible-id #projection #inspect #sequence #trap
