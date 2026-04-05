
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
