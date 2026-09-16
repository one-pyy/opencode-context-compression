# 验证边界（已实现）

## 文档定位

本文档说明当前哪些能力由自动化测试正式证明，哪些能力不能由真实会话观察直接宣称已经完整证明。

## 自动化测试范围

- `tests/cutover/runtime-config-precedence.test.ts`
- `tests/cutover/legacy-independence.test.ts`
- `tests/cutover/docs-and-notepad-contract.test.ts`
- `tests/e2e/plugin-loading-and-compaction.test.ts`

旧 delete-route 这类命名应按当前 `allowDelete=true` / delete-style 语义理解，而不是继续沿用旧 route 叙事。

## 当前不声称的内容

- 宿主暴露的 legacy 工具已经能在真实会话里完整证明 keep 与 delete
- 仓库已经提供默认生产 compaction executor transport
- legacy `dcp_mark_for_compaction` / `dcp_execute_compaction` 工具可以证明当前新 sidecar pipeline 的 mark、batch、replacement 与 lock 路径

## Delete 目标验收

以下是 delete 的验收边界；实施状态见 [删除许可与有效信息提炼](../compaction/allow-delete.md#实施状态)。

- 允许合法范围包含用户消息；系统消息仍不能作为删除目标。
- 范围包含 compact 结果时，delete 输入消费结果组内容与未覆盖原文，不展开被结果接管的底层历史。
- compact → delete 的二次提炼不重复同一来源，不把 reminder、delete notice 或 visible-id 包装当成事实。
- 用户明确仍适用的要求、约束、决定和有范围的偏好在 delete 后可继续驱动后续判断；已替代的旧命令和过程细节不再常驻。
- 未决事项、验证限制和必要的原始历史 / 本地文档入口不会被伪造为已完成或无条件删除。
- delete 模型输入超限时按合法范围拆分或保留原表示；不得静默截断或回退到全量原文。
- 模型、校验、持久化任一步失败时，旧投影仍可用，不能出现半个结果组。

这些验收需要分别覆盖 delete prompt 行为、混合输入构造、result-group source range 与最终 projection；单看模型请求日志不构成证明。

确定性回归入口为 `tests/architecture/delete-effective-input.test.ts`、`delete-input-budget.test.ts` 与 `delete-prompt-config.test.ts`，分别检查选材和投影、预算边界、独立提示词加载。固定模型输出只能证明程序链路；真实模型还需评估用户授权与助手建议的区分、单次偏好的范围、被替代要求、未决事项、未核实文件及不完整证据的保留。

## 调试快照与常规日志分离

启用调试快照时，应写出：

- `session_id.in.json`
- `session_id.out.json`

这类 snapshot 用于理解 projection 前后是否稳定，应与常规 runtime JSONL 日志分离。

## Truth Boundary 的操作含义

真实会话里的 live verification 适合确认：

- 插件确实加载了
- seam 日志确实写出
- sidecar / lock / snapshot 等 repo-owned 路径确实在工作

但完整的 keep / delete 成功路径仍以仓库自动化测试为准，不能把“看见了模型流量”误写成“真实会话已完成 keep / delete 证明”。

如果真实会话只证明了 plugin load、seam logging、sidecar creation 与 host message sync，而 `marks` / `compaction_batches` / `replacements` 仍为空，应判定为入口集成缺口，不应报告为完整 live verification 成功。

## 相关文档

- `runtime-model.md`
- `../operator/compression-mark-usage.md`
