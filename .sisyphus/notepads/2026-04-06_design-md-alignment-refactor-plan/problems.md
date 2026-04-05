
## 2026-04-06 T1 配置 / Prompt / 资产契约对齐
- 待后续任务处理：仓库若需要满足“build path”这一验证项，需要在脚本层补充正式 build 命令；这不属于 T1 的配置/prompt 契约切换本身。

## 2026-04-06 T4 历史重放 / 覆盖树 / replacement 结果组主链路
- 当前 repo 没有统一、冻结的宿主 tool message 参数解析层；因此 T4 虽已把 projection 的主入口切到“历史顺序重放”，但 source range 的具体边界仍通过 mark/source snapshot 辅助承载回放，而不是完全只靠宿主消息文本反解析。这个剩余 seam 已记录，留待后续任务在不回退主真相源的前提下继续收敛。

## 2026-04-06 T5 Projection / Visible ID / Reminder / 清理规则重构
- reminder 的“最终可见 token 长什么样”在 `DESIGN.md` 中仍是约束多、示例少的区域；本次实现已经确保“不占永久序号 + 走 single-exit + 可被成功 replacement 窗口清理”，但如果后续希望把 reminder 的 bare id 文案冻结成更具体字符串，需要由后续文档/验收任务补正式例子，而不是在运行时代码里再猜一次。
- 当前仓库里已有部分外层测试/工具 helper 默认把 `buildProjectedMessages()` 结果直接当最终文本消费；T5 已把仓库内已知用例切到 materialized output，但这个边界仍需在后续 T6/T7/T8 工作中持续保持，避免新的代码再次绕过 single-exit renderer。
