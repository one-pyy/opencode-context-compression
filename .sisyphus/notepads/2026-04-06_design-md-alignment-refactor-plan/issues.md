
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
