
## 2026-04-06 T1 配置 / Prompt / 资产契约对齐
- `src/config/runtime-config.jsonc` 继续作为 canonical runtime settings 文件；本次对齐把 schema/loader/comments 都收紧到 `DESIGN.md:650-703` 的字段面。
- reminder prompt 契约按 severity × `allowDelete` 固定为 4 份 repo-owned 纯文本文件；loader 会显式读取并在缺失、空文件或模板占位符残留时 fail fast。
- `schedulerMarkThreshold` 与 `markedTokenAutoCompactionThreshold` 的区分已在 config 注释与 schema 描述中同步强调，避免把内部 mark-count 兼容阈值误读成 marked-token readiness 阈值。

## 2026-04-06 T2 公共工具契约切换：compression_mark
- `compression_mark` 的公共输入已切到 `mode: "compact" | "delete"` + 单一区间 `target`；成功返回值改为立即返回生成的 mark id，不再返回 `Persisted compression_mark ...` 叙述文本。
- `target.startVisibleMessageID` / `target.endVisibleMessageID` 仍然按当前 projected visible view 解析，范围约束依旧保持“单一连续区间、仅可压 canonical 消息”。
- 公共测试已移除旧 `route: "keep"` 与公共 `allowDelete` 入参断言，改为围绕 `mode`、mark id 返回、delete admission 拒绝文本、以及锁期间 late mark 不进入已冻结 batch 的对外行为验证。

## 2026-04-06 T2 repair
- 第一次 T2 实现把内部持久 `allowDelete` 直接绑定到 `mode===delete`，这会在“compact + 当前策略允许 delete”时把兼容位硬降成 `false`，等于在 T2 内偷裁决了 T3/T4 的长期持久语义冲突。
- repair 后的最小安全做法是：公共契约仍由 `mode` 表达动作、delete 仍走 admission 拒绝；内部兼容 `allowDelete` 只跟当前 admission seam 走，不再由 `mode` 单独拍板。

## 2026-04-06 T3 Sidecar 数据模型与 Schema 重构
- `DESIGN.md:868-874` / `1122-1125` / `1266-1283` 在实现上可安全收敛成两类 SQLite 主职责：`mark id -> replacement result group`，以及 reminder / compressing / job / visible-id 之类 runtime state；当前仓库已新增 `replacement_result_groups`、`replacement_result_group_items`、`replacement_result_group_marks`、`mark_runtime_state`、`reminder_state` 来承接这条主模型。
- 依据 `conflict-audit.md` 的“冲突 2”，本次没有用“第 15 章覆盖旧章”去裁决，也没有一次性删除 `marks/source_snapshots/replacements`；旧表仍保留为 migration compatibility 与当前 runner/projection 兼容投影层，但新的 store 主查询入口已经面向 `getReplacementResultGroup(markID)` 与其 items/links，而不再把 `listMarks()` / persistent mark rows 当 replacement truth。
- 依据 `conflict-audit.md` 的“冲突 1”，`allowDelete` 仍留在旧兼容承载与 source snapshot 指纹里，避免直接拍死现有 compaction input / tests；但 T3 没有再把它扩成新的 result-group 真相字段，result-group lookup 的主键是 `mark id`，最终动作字段仍以 `executionMode` 为准。
- 结果组原子性当前通过 store 事务与 `replacement_result_groups.completeness` 显式表达：只有完整组才会被 projection 命中；legacy `replacement` invalidation 会同步把对应 result group 降为 `incomplete`。
- 明确保留给 T4 的边界：历史重放成为 projection 主入口、覆盖树按 mark tool 调用构建、fallback 到子节点结果、以及摆脱 `listMarks()` 作为活动 mark 来源的主链路改造，仍需在 T4 继续完成。

## 2026-04-06 T3 repair
- 第一版 T3 虽然已经引入 result-group 表，但 `store.getReplacementResultGroup(markID)` 仍然按 `primary_mark_id` 查询，导致“非 primary linked mark 无法回查结果组”，这与 `mark id -> replacement result group` 的对外契约不一致；repair 后查询改为经 `replacement_result_group_marks` 反查 group，因此任一 linked mark 都可命中。
- 第一版 v3 migration 把历史 `replacement_mark_links` 先全部写成 `primary`，再试图补 `consumed`，语义上会污染 link_kind；repair 后对历史 links 使用稳定规则派生一个 primary（最早 link，按时间/mark id 打破平局），其余保留为 consumed，并新增 backfill migration 补齐已迁数据库里缺失的 items/marks。

## 2026-04-06 T4 历史重放 / 覆盖树 / replacement 结果组主链路
- projection 主入口现在按历史里的真实 mark tool 调用顺序重放，而不是把 `store.listMarks()` 当语义真相源；实现上优先读取 sidecar 已同步的 host history 顺序（`hostCreatedAtMs/firstSeenAtMs`），再按 tool-call message id 反查 mark 与 source span。
- 覆盖树语义已经按 `DESIGN.md:1176-1254` 落地：后盖前、大盖小、等于范围同样按覆盖处理；父节点无结果时递归展开子节点并保留原文 gap；父节点一旦有完整结果组，整棵子树立即由祖先接管。
- intersecting later mark 已实现为显式错误分支，而不是“普通无结果 mark”：该调用继续作为当前可见消息存在，但 tool 返回会被改写为 replay error 文本，且对应 mark id 被排除出覆盖树、replacement lookup 与后续 token 统计候选集合。
- 为兼容当前仓库的 live/e2e 路径，T4 没有假设 mark tool 返回参数一定能从宿主消息体完整反解析；当前 replay 以“历史里真实出现的 tool call message id + 持久 source snapshot 范围”组合重建覆盖语义，真相入口已切到历史调用顺序，SQLite 只承担结果组与运行时状态承载。

## 2026-04-06 T5 Projection / Visible ID / Reminder / 清理规则重构
- single-exit 可见前缀现在收口到 `src/projection/messages-transform.ts` 的 materialize 阶段：`projection-builder` 只产出结构化 projection，并在 message `info` 上写 bare `visibleMessageID + visibleState` metadata；最终 `[protected|compressible|referable_*]` 文本只在 transform 出口写一次，符合 `DESIGN.md:479-500` / `900-931`。
- assistant/tool 的最终可见语义已按 `DESIGN.md:170-185` / `211-214` 对齐：assistant 有正文（包括 `input_text` 正文）时直接把 visible id 放到正文最前；assistant 只有 tool 调用、没有正文时才补一条只含 id 的 assistant shell；tool 字符串输出把各自 msg id 前置到字符串最前，Responses content array 则把各自 msg id 插到最前面的 `input_text` 位置。
- reminder artifact 不再占用永久 visible sequence：`src/projection/reminder-service.ts` 现在生成 projection-owned reminder id（`reminder_<severity>_<anchor-checksum>`），只保留稳定锚点 checksum，不再复用消息层 `00000x_xx` 序号；最终渲染仍走 single-exit `protected_*` 前缀，但消息层不携带永久序号，符合 `DESIGN.md:356-369` / `498-500`。
- replacement / delete notice / mark cleanup / reminder cleanup 已按窗口语义实现：成功命中的 replacement 继续以 referable block 或极简 delete notice 存活；对应 source span 被隐藏；已被 replacement 覆盖的 mark tool 调用继续从 prompt-visible view 移除；anchor 落在成功 replacement 窗口内的 reminder 不再插回 projection，避免在被 replacement 接管后残留过期 reminder，符合 `DESIGN.md:407-411` / `754-778`。
- 张力 3 没有被误伤：本次只清理“被当前成功窗口直接接管的旧 artifact”，没有把 compact 结果扩写成“以后完全不可再被更大范围包含或 delete 覆盖”；更大范围包含/覆盖的语义仍保持给后续 replay/tree/runner 路径继续消费。

## 2026-04-06 T6 Compaction 输入 / Runner / Transport / 失败语义对齐
- `src/compaction/input-builder.ts` 现在显式接受 `opaqueReferences`，并基于 source snapshot 顺序把已存在 compact 结果块渲染为 `<opaque slot="Sx" placeholder="...">...</opaque>`；compaction 输入边界仍来自 mark/source snapshot/canonical history，不再从 projected prompt view 倒推。
- `src/compaction/runner.ts` 不再把 `allowDelete` 直接等同于本次执行模式，而是优先读取 mark metadata 里的 `mode` 继续传递 delete/compact 意图；这保证了“compact + 当前策略允许 delete”不会被 runner 偷偷改写成 delete，同时仍保留现有兼容 `allowDelete` 承载。
- runner 在 `compact` 模式下会基于当前 mark 的 source boundary 和已完成 result group，挑出被包含的 compact 子块作为 opaque placeholder 输入；占位符合法后再把输出 materialize 回原子块文本并统一走同一条 `commitReplacement -> result group` 提交路径，delete/compact 没有再分叉出第二套 persistence / projection 机制。
- `src/compaction/output-validation.ts` 现在把缺失 required placeholder 判定为硬输出错误（`missing-required-placeholders`），其行为进入同一条 attempt 失败 → fallback 模型链；失败时不会提交 replacement/result group，合法 mark 继续保留给后续 retry/fallback 或下一轮运行。
- `src/runtime/default-compaction-transport.ts` 继续保持独立于普通 `session.prompt` / `prompt_async` 的 transport 边界，并把 required placeholders / XML opaque 约束显式写进 compaction-only prompt context，避免让普通会话 prompt 路径反向定义 compaction contract。

## 2026-04-06 T6 repair：same-model retry before fallback
- verified gap: hard output errors（尤其是 `missing-required-placeholders`）虽然已经被正确归类，但 runner 仍然是“一次失败就切下一模型”；repair 后 `src/compaction/runner.ts` 会先在当前模型上做一次最小同模型重试，再进入 ordered fallback chain。
- 这次 repair 没有引入新的 runtime config 字段；当前仓库尚无冻结好的 per-model retry surface，因此只在 runner 内部使用局部默认值，并且只对 hard output validation failure 打开同模型重试，避免把修补扩成配置系统重写。

## 2026-04-06 T7 Scheduler / Gate / Batch Freeze / 运行时门闩对齐
- `chat.params` 现在继续保留为窄调度缝：它只读取当前 session 的 live file-lock、同步 canonical history 供 marked-token readiness 评估、并在 readiness 满足时触发后台 runner；普通对话等待没有回流到 `chat.params`，仍然只发生在 `src/runtime/send-entry-gate.ts`。
- lock 生命周期已经按 `DESIGN.md:618-642` 落到运行时顺序：后台 batch 真正 dispatch 时建 lock；runner 结束时先把 lock 写成 `succeeded` / `failed` 终态，再清掉 lock 文件；后续普通请求因此可以因为“终态 lock 仍短暂可见”或“文件已清理并从 persisted batch 读出终态”两种路径继续，但两者的外部语义都一致地表示“已经不再被 live lock 阻塞”。
- batch freeze 的关键不是 runtime 里给 late mark 写 special-case，而是把 dispatch 时间钉死到 `frozenAtMs`：`freezeCurrentCompactionBatch()` 先建立 dispatch/lock，再按 `createdAtMs <= frozenAtMs` 过滤持久 active mark 集持久化当前 batch；lock 期间新写入的 mark 自然留在下一轮，不会混入当前 batch 成员表。
- 针对 T7，测试断言也从“必须经某条内部来源命中”收敛为“等待直到终态/超时/手工恢复后放行”的外部行为证明，避免让旧测试反向把 runtime 语义钉死成某个内部 race 顺序。
