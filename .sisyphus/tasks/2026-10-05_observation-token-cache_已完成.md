# 观测关闭与 token 缓存

## 进度
- M1 契约与恢复点：已完成（65536 条、进程模块实例共享、无时间过期；复用现有恢复链）
- M2 回归测试：已完成（旧实现重复请求与三入口观测失败；当前新增 14 项全部通过）
- M3 实现：已完成（观测守卫与成功计数 LRU；合成 1000 条热轮新增 0 次请求，改一条新增 1 次）
- M4 文档与验收：已完成（构建通过；相关新增/回归 39/40 通过，唯一失败为未修改的既有 src/index.ts 行数断言；任务实现与新增测试 LSP 通过；Oracle 无保留问题）

## 契约与边界

用户已授权实施，缓存容量 65536 条，取消时间过期；进程内模块实例共享主会话和 task 子会话的计数。键覆盖完整计数文本、有效 endpoint、model 与内部键版本；仅保存指纹与成功数值。失败仍返回 undefined，各消费者沿用原 fallback；保持 replay、delete、锁、门槛与分桶语义。

原计划：`.sisyphus/tmp/plans/2026-10-05_observation-token-cache.md`，容量与时间过期规则以本任务最新约定为准，计划同步修订。正式契约更新位置：`.sisyphus/docs/config/runtime-config-surface.md` 的日志开关与 Token 计数服务；`.sisyphus/docs/compaction/model-visible-transcript.md` 的计数复用章节。

恢复 ref：`refs/checkpoints/lightweight-chat-params/2026-10-05_08-41-46_recovery_c8e9aadb874f`。保留既有日志开关、轻量 chat.params、其测试及其他工作；本任务不自动提交、不重启用户会话。该恢复链包含早前改动，不能把与 ref 的全部差异归于本任务。

## 工作与验证

完整 `npm run typecheck` 未通过：既有 bun:test 声明缺失、旧 fixture 类型错误与 dist 声明缺失。构建及本次修改文件的 LSP 检查通过。真实长会话端到端延迟、实际堆占用未测量；现有运行进程需重启加载新实现。本次没有提交或重启用户进程。

1. 补观测关闭、缓存冷热及失败恢复测试 → verify: 新行为在旧实现失败，新增夹具类型正确。
2. 在 plugin-hooks 三入口跳过禁用观测，在文本服务入口增加有界成功值缓存 → verify: 新用例通过，UTF-16 指纹区分孤立代理项，容量淘汰正确。
3. 检查主分类、侧栏统计与预算调用 → verify: 合成千条消息热轮无新增计数请求，新增正文只增相应请求；分桶与 budget fallback 不变。
4. 同步受影响 Docs 并审查实际任务 diff → verify: 修改文件 LSP、build、typecheck、相关回归通过；Oracle 复用 `ses_ef58c83f9ffeHItKXNMvp9gaYH` 检查当前实现候选。

本任务新建文件：本任务文件、`tests/architecture/token-service-cache.test.ts`，以及拟新增的 `src/token-estimation-cache.ts`、`tests/architecture/token-estimation-cache.test.ts`。日志、快照和其他既有文件不清理。
