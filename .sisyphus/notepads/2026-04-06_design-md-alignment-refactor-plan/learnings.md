
## 2026-04-06 T1 配置 / Prompt / 资产契约对齐
- `src/config/runtime-config.jsonc` 继续作为 canonical runtime settings 文件；本次对齐把 schema/loader/comments 都收紧到 `DESIGN.md:650-703` 的字段面。
- reminder prompt 契约按 severity × `allowDelete` 固定为 4 份 repo-owned 纯文本文件；loader 会显式读取并在缺失、空文件或模板占位符残留时 fail fast。
- `schedulerMarkThreshold` 与 `markedTokenAutoCompactionThreshold` 的区分已在 config 注释与 schema 描述中同步强调，避免把内部 mark-count 兼容阈值误读成 marked-token readiness 阈值。
