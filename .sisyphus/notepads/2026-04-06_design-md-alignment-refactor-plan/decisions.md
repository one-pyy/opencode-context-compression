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
