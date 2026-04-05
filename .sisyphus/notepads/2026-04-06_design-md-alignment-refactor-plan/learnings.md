
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
