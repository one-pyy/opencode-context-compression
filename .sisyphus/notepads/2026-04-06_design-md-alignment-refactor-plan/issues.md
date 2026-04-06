
## 2026-04-06 T1 配置 / Prompt / 资产契约对齐
- 仓库当前没有 `build` script；`npm run build` 失败是脚本面缺失，不是本次 T1 改动引入的运行时错误。当前可执行验证路径为 `npm run typecheck` 与 `npm test`。

## 2026-04-06 T2 公共工具契约切换：compression_mark
- `DESIGN.md` 要求 `mode=delete` 受“当前策略” admission 控制，但仓库当前没有独立、已定版的 delete-policy 真相源或单独配置面；T2 仅在工具实现层保留最小 admission seam，并用 contract test 覆盖拒绝分支，不在本任务内额外创造新的全局 policy 系统。

## 2026-04-06 T2 repair
- README / `readme.zh.md` 的公共契约改写不属于这次 repair 必需范围；验证并不依赖文档更新，因此已回退，避免把 T2 repair 扩成 T8 文档收敛工作。

## 2026-04-06 T3 Sidecar 数据模型与 Schema 重构
- 由于当前 runner / scheduler / projection 主链路仍广泛依赖 `listMarks()`、`getSourceSnapshot()`、legacy `replacement` 读法，T3 不能直接删除旧表或让 store API 只剩 replay 版入口；否则会一次性把尚未实现的 T4/T5/T6/T7 工作硬并进本任务。
- `allowDelete` 的长期持久语义冲突在 T3 仍未被彻底裁决：当前实现只把它留在兼容 mark/source snapshot/replacement 承载层，避免破坏既有 compaction input 和兼容测试，但新的 result-group 主模型没有继续把它扩展成新的 lookup 真相字段。

## 2026-04-06 T3 repair
- result-group API 的“任意 linked mark 可回查”与 migration `link_kind` 修复都能在 schema/store 层内最小完成，不需要扩到 T4 replay；但这也意味着当前 primary 选择仍是 migration/backfill 的稳定兼容规则，不是历史重放树意义上的最终权威排序语义。

## 2026-04-06 T4 历史重放 / 覆盖树 / replacement 结果组主链路
- T4 已把 projection 主链路切到历史重放，但 scheduler marked-token 统计、batch freeze 入口、runner/gate 仍保留现有消费面；这些下游消费层是否统一改为直接吃 replay/coverage-tree 结果，明确留给 T5/T6/T7，避免把本任务扩成整条运行时链路重写。
- 当前仓库里 mark tool 的宿主消息形态在 live/e2e 与单测夹具之间并不完全一致，因此 T4 采用“历史顺序来自 host history，范围语义来自 mark/source snapshot，replacement 主键来自 mark id”的保守落地；若后续要彻底去除 mark/source snapshot 对 replay 的辅助承载，需要在更下游任务里先固定宿主 tool message 的可解析契约。

## 2026-04-06 T5 Projection / Visible ID / Reminder / 清理规则重构
- 把 single-exit 前缀渲染真正下沉到 `messages-transform` 后，少量 cutover 测试仍在直接把 `buildProjectedMessages()` 的中间结构当成最终可见文本使用；本次已把这些测试切到 materialized output，但这也说明后续若新增测试或 helper，必须明确区分“projection 中间结构”与“最终 prompt-visible 文本”。
- `DESIGN.md` 对 reminder 的“消息层不写永久序号”是明确的，但对最终可见 token 只给了约束没给唯一示例；本次实现选择了稳定的 projection-owned bare id（`reminder_<severity>_<anchor-checksum>`）再走 single-exit `protected_*` 渲染。若后续文档想冻结更具体 reminder 文案样式，应在 T8 文档/验收任务里显式补例子，而不是再让旧快照反向定义。

## 2026-04-06 T6 Compaction 输入 / Runner / Transport / 失败语义对齐
- 当前仓库的 projection 仍然一次只 materialize 每个 result group 的首个 item；T6 先把 opaque placeholder / hard-error / atomic commit 语义落到 input-builder、runner 和现有单-item result-group 提交上，没有在本任务内顺手把 projection 扩成完整多-item replacement materialization。这一层仍需在后续 T7/T8 或单独 result-group rendering 任务里继续收口。
- 运行时配置面当前只有“有序模型链 fallback”，没有独立冻结好的“每模型重试次数”字段；因此 T6 已经把 placeholder 缺失归类为硬输出错误并保证进入同一条失败链、永不提交半成品，但“同模型内部重试次数”的配置化仍留待后续任务明确，不在本次临时发明新 config 字段。

## 2026-04-06 T6 repair：same-model retry before fallback
- repair 采用的最小策略是：仅对当前已验证的 hard output validation failure（`missing-required-placeholders`）启用一次同模型重试，然后才允许 fallback 到下一个模型。其他 transport / source / stale 类失败仍保持现有终止或直接 fallback 行为，避免让 repair 越界扩散到整条失败分类系统。

## 2026-04-06 T7 Scheduler / Gate / Batch Freeze / 运行时门闩对齐
- T7 对齐后，等待中的普通对话既可能在“lock 文件仍处于 `succeeded` / `failed` 终态时”解除等待，也可能在“lock 文件已清、send-entry gate 回看 persisted batch 状态时”解除等待；这是 runner 先 settle 再 clear 带来的合法 race，不应再让测试把来源硬编码成唯一的 `compaction-batch` 分支。
- 当前仓库依然没有 build script；T7 的验证已按现状使用 `lsp_diagnostics`、相关 runtime/e2e tests、`npm run typecheck` 和 `npm test`，没有把“补 build 命令”顺手并进本任务。

## 2026-04-06 T8 测试 / 文档 / 遗留资产统一收口
- `DESIGN.md:939-943` 仍用 `tests/e2e/delete-route.test.ts` 作为说明锚点，因此仓库虽然已经把测试入口重命名为 `tests/e2e/allow-delete-delete-style.test.ts`，文档中仍必须明确说明“这是设计里提到的旧文件名”，否则容易让读者误以为仓库偏离了设计锚点。

## 2026-04-06 T9 replay-first integration/e2e cleanup
- 最后一次 failure-fixing里最容易漂移的风险点是“让当前实现重新定义测试”。本轮已明确避免这一点：剩余 compact-path failure 不是通过放松设计断言解决，而是通过修正 replay-first test setup（统一 clock domain、让 nested opaque scenario 先提出 outer/inner mark proposal 再注入 inner result）解决。
- repo-wide verification 期间暴露的 `tests/marks/batch-freeze.test.ts` 不仅仍处于 unit-heavy marks boundary，而且还保留了已不值得维护的 low-level helper drift（例如 orphaned `hostMessage` reference）。按用户最新边界，该文件被删除而不是继续修补；真正需要的 batch-freeze / late-mark proof 已由 surviving cutover/runtime/e2e tests 覆盖。

## 2026-04-06 T10 surviving-test design audit follow-up
- audit 里最重要的“测试不只要绿，还要能指导未来按 DESIGN 重写代码”风险已经实锤过一次：`tests/e2e/plugin-loading-and-projection.test.ts` 原本把短 user 断言成 `compressible`，而当前 runtime helper 默认值也恰好让这个错误断言通过。最终处理不是把测试改回现状，而是让测试显式走 repo runtime threshold seam，并用它暴露/验证 design-required short-user protection。
- `tests/cutover/cutover-test-helpers.ts` 仍保留一个已知折中：`appendReplayFirstCompressionMark()` 回写 transcript 时，历史里仍只追加当前 runtime 实际消费的 tool-call host message id 文本，而没有引入仓库尚未冻结的更丰富 tool-result envelope 语义。鉴于 `src/replay/mark-replay.ts` 当前明确以 `toolCallMessageID` 查 mark，这个 helper 仍是“最小不撒谎”的 shared basis；若后续 runtime 固定了更完整的宿主 tool message contract，再统一升级 helper，而不是在测试层先发明一个 runtime 不认识的新 transcript shape。

## 2026-04-06 QA hands-on verification
- 本轮 QA 未观察到新的 P0/P1 行为阻断；repo-wide 与 targeted 行为验证均为通过状态。
- 一个非阻断记录项：计划/需求要求覆盖“replay/coverage tree behavior”，但仓库当前并没有单独命名为 `tests/replay/coverage-tree.test.ts` 的测试文件；对应可观察证明目前体现在 `tests/projection/projection-builder.test.ts` 的覆盖树/重放场景，以及相关 e2e/cutover 路径中。

## 2026-04-06 runtime correctness repair: canonical sync / replay order / reminder permission seam
- `chat-params-scheduler` 不再对 `client.session.messages()` 的前 500 条结果做破坏性 canonical resync：现在会继续按 cursor 拉取完整历史；若响应声明仍有更多历史但不给可推进的 pagination cursor，则直接 fail closed，避免把未取回的旧消息误标成 `canonical_present=0`。
- `replayMarkHistory` 的 precedence 已收口到当前 canonical transcript 顺序（`ProjectionPolicy.messages`）本身，不再从 sidecar `listHostMessages()` 的时间戳 / id 排序去推断“更早/更晚”的 mark tool 调用次序；对应 projection/e2e 测试也改成用真实 transcript 输入证明这一点。
- reminder delete-allowed prompt 选择已改为显式 current-runtime seam：projection/messages-transform 现在接收当前 delete permission 信号并据此选 `reminder.prompts.deleteAllowed` 或 `compactOnly`，不再从历史 mark 持久 `allowDelete` 位回推当前权限。当前 repo 入口仍只提供最小 seam（默认 `false`）；若后续有已定版的 live delete-policy source，应把它接到这个 seam，而不是再读旧 mark 持久位。

## 2026-04-06 T9 inventory：剩余测试设计错位边界
- 依据 `DESIGN.md` 第 15 章，真正的剩余设计错位是“旧场景入口 seam”而不是“所有内部观察都不允许”：`persistMark(...)`、`seedKeepMark(...)`、`seedDeleteMark(...)` 仍把 durable mark/source snapshot 行当作测试起点，这与“历史里的 mark tool 调用 + replay-first 解释”主语义冲突。
- `querySqlite(...)`、`getReplacementResultGroup(...)`、`findLatestCommittedReplacementForMark(...)` 在当前盘点里多数只是对 repo-owned 派生结果的内部观测；若测试入口已经改成 `compression_mark` / transcript-first，这类观测本身不应单独算 violation。
- 目前最需要整段重写的是直接用 `persistMark` / `seed*Mark` 伪造运行时场景的 projection / scheduler / runner / freeze / e2e 测试；已经通过公共 `compression_mark` 驱动场景的 cutover/e2e 测试，多数只需把残余持久 seam 夹具替换掉，或保留内部结果观察断言。

## 2026-04-06 T10 surviving-test design audit gaps
- 共享 helper `tests/cutover/cutover-test-helpers.ts:167-245` 仍是 surviving tests 的最大设计缺口：`appendReplayFirstCompressionMark()` 通过真实 public tool 建 mark，但回写 transcript 时只追加 assistant 文本形式的 mark id，没有把 tool 调用参数与返回值按更完整的历史语义写回。这会让测试继续依赖“tool-call message id + sidecar source span”这条当前实现折中，而不是纯粹的 transcript replay truth。
- `tests/cutover/legacy-independence.test.ts:117-136` / `212-266` 的 `canonical execution does not require old provider DCP fields` 明确不是 fully design-faithful：`sessionHistory` 里先写入占位 `m_history_seed_1`，后续真实 `compression_mark` 返回值没有回填进 transcript，但 scheduler / projection 仍然被断言为成功。这说明该测试容忍“历史结果不是真实 mark id”，仍在吃当前 sidecar anchoring 假设。
- `tests/e2e/plugin-loading-and-projection.test.ts:238-242` 有明确设计冲突：它把短 user `hello` 断言成 `[compressible_*]`，与 `DESIGN.md:144-145` / `749-750` 的 `smallUserMessageThreshold` 保护规则相反。这是本轮最直接的 design mismatch。
- `tests/cutover/compression-mark-contract.test.ts:399-487` 的 lock 场景，以及 `tests/e2e/allow-delete-delete-style.test.ts:29-133` 的 delete-style 场景，都没有显式建立“当前 runtime delete admission seam”；它们直接期待 `mode=delete` 成功，因此仍带有“当前 fixture / 默认实现允许 delete”的实现假设，不足以独立证明 `DESIGN.md:1140-1146` 的 seam 语义。
- `tests/cutover/compression-mark-contract.test.ts:125-141` 对 `host_messages` 行的逐字段断言、`tests/cutover/scheduler-live-path.test.ts:271-407` 与 `tests/e2e/plugin-loading-and-compaction.test.ts:241-286,506-542` 对 prompt body 具体标题/字段文案的断言，属于过度冻结当前 serializer / store shape。设计确实要求 compaction input 边界清晰、mode 与 allowDelete 被传达，但没有冻结这些精确字符串与表级实现细节。
- `tests/e2e/plugin-loading-and-compaction.test.ts:214-234,470-490` / `tests/e2e/plugin-loading-and-projection.test.ts:243-263` / `tests/e2e/allow-delete-delete-style.test.ts:112-132` 对 SQLite 行与 result-group link 的观测大多仍可接受，因为它们是在 public-entry setup 之后观测派生结果；真正的问题不是“看数据库”，而是当这些断言与上游简化 transcript fixture 组合在一起时，会掩盖 replay 是否真的只靠历史语义成立。
