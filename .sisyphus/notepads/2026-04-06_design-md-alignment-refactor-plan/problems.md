
## 2026-04-06 T1 配置 / Prompt / 资产契约对齐
- 待后续任务处理：仓库若需要满足“build path”这一验证项，需要在脚本层补充正式 build 命令；这不属于 T1 的配置/prompt 契约切换本身。

## 2026-04-06 T4 历史重放 / 覆盖树 / replacement 结果组主链路
- 当前 repo 没有统一、冻结的宿主 tool message 参数解析层；因此 T4 虽已把 projection 的主入口切到“历史顺序重放”，但 source range 的具体边界仍通过 mark/source snapshot 辅助承载回放，而不是完全只靠宿主消息文本反解析。这个剩余 seam 已记录，留待后续任务在不回退主真相源的前提下继续收敛。

## 2026-04-06 T5 Projection / Visible ID / Reminder / 清理规则重构
- reminder 的“最终可见 token 长什么样”在 `DESIGN.md` 中仍是约束多、示例少的区域；本次实现已经确保“不占永久序号 + 走 single-exit + 可被成功 replacement 窗口清理”，但如果后续希望把 reminder 的 bare id 文案冻结成更具体字符串，需要由后续文档/验收任务补正式例子，而不是在运行时代码里再猜一次。
- 当前仓库里已有部分外层测试/工具 helper 默认把 `buildProjectedMessages()` 结果直接当最终文本消费；T5 已把仓库内已知用例切到 materialized output，但这个边界仍需在后续 T6/T7/T8 工作中持续保持，避免新的代码再次绕过 single-exit renderer。

## 2026-04-06 T6 Compaction 输入 / Runner / Transport / 失败语义对齐
- 新增 e2e 一开始尝试通过公共 `compression_mark` 工具构造“outer compact 覆盖 inner compact referable block”场景，但当前公共工具契约只允许选择连续 `compressible` canonical span，不能直接选 referable compact block 本身；为避免把 T6 误扩成 T2/T7 工具契约重写，最终改为 sidecar 预置 inner committed result + outer active mark 的 integration-style e2e，直接验证 runner/input/placeholder/failure contract。
- 为了不偷裁决 `allowDelete` 的长期语义，runner 执行模式改为优先读取 mark metadata 里的 `mode`；这要求测试夹具显式给 mark metadata 补 mode，否则旧夹具会继续落回 `allowDelete -> executionMode` 的兼容回退路径。

## 2026-04-06 T7 Scheduler / Gate / Batch Freeze / 运行时门闩对齐
- T7 已把 send-entry wait / batch freeze / lock lifecycle 收到当前 DESIGN 语义，但“这些 runtime 细节如何在 README / 设计辅助文档里统一讲清楚”仍未在本任务内处理；尤其是“lock 终态短暂可见后再 clear”的 operator-facing 说明，明确留给 T8 文档统一收口。
- 当前 batch freeze 仍依赖持久 mark `createdAtMs` 作为 dispatch cut line，而不是完全从宿主历史 replay 时间戳直接导出；这满足 T7 的运行时门控行为，但若后续要把 mark membership 的时间边界也彻底统一到 replay 主链，需要在不回退当前行为的前提下另开后续任务处理。
