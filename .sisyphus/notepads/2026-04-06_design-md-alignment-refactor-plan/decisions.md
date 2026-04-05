## 2026-04-06 T0 冲突审计索引

本计划目录新增：`conflict-audit.md`。

用途只有两个：

1. 冻结 `DESIGN.md` 关键原文引用，供后续子任务直接贴用。
2. 当 `DESIGN.md` 内部出现张力时，先查这里的并列引文和结论，再决定是“并列满足”还是“先停下提交冲突说明”。

使用边界：`DESIGN.md` 仍是真相源，`DESIGN-CHANGELOG.zh.md` 只做变更提示和补充核对，不能越权覆盖设计原文。

## 2026-04-06 T1 配置 / Prompt / 资产契约对齐
- 旧资产 `prompts/reminder-soft.md` 与 `prompts/reminder-hard.md` 已删除，不再保留为权威 reminder 资产；理由是 `DESIGN.md:805-827` 明确要求由四份 severity × `allowDelete` 纯文本文件替代。
- 对 `allowDelete` 的实现说明保持最小解释：本任务只对齐 config 字段名、prompt 文件名、loader 行为与 cutover 可观测契约，不在 T1 内裁决其长期持久语义，相关张力仍以 `conflict-audit.md` 为准并留给 T2/T3。
- runtime config loader 现在显式拒绝旧 `counter.source` / `counter.*.repeatEvery` 一类非权威字段，避免为兼容旧配置面而回退当前设计契约。

## 2026-04-06 T2 公共工具契约切换：compression_mark
- 依据 `conflict-audit.md` 的 T2 范围约束，本次只切换公共工具输入/输出契约与 delete admission 行为：公开动作字段从旧 `allowDelete` / `route` 语义收敛为 `mode`，成功返回只保留 mark id。
- 为避免在 T2 内误裁决 `allowDelete` 的长期持久语义，现有 sidecar / runner / projection 内部字段仍保持兼容承载；工具 metadata 已记录 `mode` 作为新的公共动作真相，长期持久字段去留与 replay 主入口解释继续留给 T3/T4。
- 任何需要新建“当前 delete policy”全局真相源、改写 replay 主链路、或改 sidecar schema 的动作，都不在本次决策范围内。

## 2026-04-06 T2 repair
- repair 明确撤销了“`allowDelete: args.mode === \"delete\"`”这种过度绑定；内部兼容持久位改为从当前 admission seam 派生，确保 T2 只做公共契约与 admission，不借机决定 compact mark 的长期 delete 能力。
- docs 变更未被证明为本次 repair 的必要条件，因此回退 `README.md` 与 `readme.zh.md`，把文档统一留回后续专门任务处理。

## 2026-04-06 T3 Sidecar 数据模型与 Schema 重构
- 本次 schema/store 的主模型裁决是：SQLite 的主真相入口收敛为“`mark id -> 完整 replacement result group` + runtime state”，直接对应 `DESIGN.md:868-874`、`1122-1125`、`1266-1283`；但考虑 `conflict-audit.md` 的冲突 1/2，旧 `marks/source_snapshots/replacements` 不做一次性清除，而是降级为兼容迁移层与当前消费层过渡承载。
- 新增 `replacement_result_groups` / `replacement_result_group_items` / `replacement_result_group_marks` 的原因不是扩 sidecar，而是把原本散落在 `replacements + replacement_mark_links` 里的“mark id 对应完整结果组”语义显式化；当前一条 legacy replacement 迁移成一组单 item，后续多 item 结果组仍可在不改 schema 的前提下落地。
- `mark_runtime_state` 保留 `active/consumed/invalid`、tool-call 关联与少量 metadata，目的是给 T4 的历史重放提供“必要运行时缓存/执行元数据”，而不是继续把 mark 当 sidecar 主业务真相。
- reminder / visible-id / compressing / job 的 sidecar 职责在 T3 只做 schema/store 承载补齐，不扩展到新的 projection 主链路；因此 `reminder_state` 只落 runtime state 存储接口，不在本任务内实现新的 reminder history replay 逻辑。

## 2026-04-06 T3 repair
- `mark id -> replacement result group` 的 store API 语义最终以 `replacement_result_group_marks` 为 lookup bridge，而不是 `primary_mark_id` 单字段。`primary_mark_id` 继续保留为组内 canonical mark / 排序字段，但不再是唯一有效查询入口。
- 对历史库的 migration 修复采用最小稳定规则：每个 legacy replacement 的最早 consumed link 记为 `primary`，其余 links 记为 `consumed`；这只是兼容层语义修复，不等同于 T4 中基于历史重放的最终树结构裁决。

## 2026-04-06 T4 历史重放 / 覆盖树 / replacement 结果组主链路
- 本次裁决：`src/projection/projection-builder.ts` 的 mark 发现逻辑不再从 `store.listMarks()` 扫描活动 mark，而是先按历史里的真实 tool-call 顺序重放，再基于 replay 产生的合法 coverage tree 去按 mark id 查询 result group。这样满足 `conflict-audit.md` 冲突 2 的“以历史重放为主，以数据库结果组 lookup 为辅”。
- 本次裁决：coverage 判断严格基于 mark 的原始 source span（即 replay 的原消息坐标），不按投影视图块表面重新做几何判断；因此 compact 结果块仍可被更大范围 mark 包含或被 delete 覆盖，避免把张力 3 错误实现成“压缩块以后完全不能进入更大范围”。
- 本次裁决：intersecting later mark 的最终视图语义按 `DESIGN.md:1316-1323` 执行——保留该 tool 调用为普通当前可见消息，改写其返回值为错误文本，同时把该 mark id 排除出 coverage tree、token 统计和 replacement lookup。它不是“合法但暂无结果”的树节点。
- 明确保留给 T5/T6/T7 的边界：single-exit/显示层统一格式化、scheduler marked-token 直接消费 replay tree、runner 对 replay 节点的更深输入构造、以及 gate/lock 与 replay 状态的统一收口，本次都没有重写。
