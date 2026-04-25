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
