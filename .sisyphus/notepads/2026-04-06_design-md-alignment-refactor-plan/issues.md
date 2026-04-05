
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
