# 上下文阈值用户提醒

## 进度
- M1 配置：已完成（默认值、自定义值与非法输入测试通过）
- M2 提醒接入：已完成（阈值、回落、失败重试、持久化与会话隔离测试通过）
- M3 验证与文档：已完成（相关 12 项及默认测试 142 项通过，构建和修改源码诊断通过；任务差异与文档已核查，全仓库限制见下文）

## 契约与范围

配置入口为 src/config/runtime-config.ts、runtime-config.schema.json 与 runtime-config.jsonc。提醒语义维护于 .sisyphus/docs/compaction/reminder-system.md，配置说明维护于 .sisyphus/docs/config/runtime-config-surface.md。

使用当前异步统计的 del、comp、fixed：del + comp > x + fixed 时提醒一次，del + comp <= x + fixed - 30000 时重新激活。提醒正文为“别忘了cpmark，这次不用调用inspect，用之前的就好。cpmark完继续之前的任务。如果之前的任务已结束，同样结束。”，通过普通 session.prompt 接口设置 noReply=true 写入历史，不启动回复。按会话串行处理并持久化激活状态。

## 实施与验证

1. 配置类型、加载校验、规范与模板 → 验证默认值、自定义值及非法输入。
2. 异步统计发布回调与持久化提醒状态 → 验证等于上限不触发、越界只发送一次、下限重新激活、会话隔离、重启恢复、发送失败可重试、旧统计不触发。
3. 文档与运行入口 → 验证类型检查、相关测试、构建和恢复点到任务差异。

## 验证证据与限制

相关验证：`node --import tsx --test tests/architecture/cpmark-reminder.test.ts tests/architecture/compression-stats-scheduler.test.ts tests/architecture/compression-stats.test.ts tests/cutover/runtime-config-precedence.test.ts`，12 项通过。`npm run build` 通过；修改的运行时与配置源码及新增测试的语言服务诊断无错误。

仓库默认测试命令覆盖 142 项且全部通过。启用 Bash globstar 后递归运行 `tests/**/*.test.ts`，共 213 项，205 通过、8 失败：数据库读模型的两项存在重复或残留损坏记录；压缩工具错误文案断言过时；安全传输的两项仍使用旧响应格式；恢复测试仍断言旧摘要标识格式；历史重放序号与旧断言不同；运行日志测试仍要求已移除的 gate 事件。日志保存在 `/tmp/opencode/cpmark-full-tests.log`。这些失败不位于新增提醒行为链路；未修改这些测试或其既有实现。

全仓库 `npm run typecheck` 仍有 6 条已有测试错误：两项 `bun:test` 声明缺失、消息投影测试夹具缺少会话字段及可选 hook 调用、inspect 测试输入缺少 mode、构建入口测试缺少 dist 的类型声明。新增 cpmarkThreshold 导致的测试配置缺项已补齐；不将全仓库检查声明为通过。

提醒接口由模拟客户端验证请求字段，未在真实宿主会话中实际触发提醒。异常退出或响应丢失时两个独立存储之间不能保证严格一次发送，正常串行运行与数据库重开后的去重已测试。

## 提交范围

用户授权提交并推送本仓库所有源码、测试与文档改动，包括本任务之前已有的变更。本机会话运行记录 `.omo/run-continuation/` 留在本机。

## 恢复记录

开始时恢复点：refs/checkpoints/cpmark-reminder/2026-10-08_21-52-36_recovery_1a6b97fb5c10。正式提交后此恢复链结束，恢复依据为提交历史。
