# 发送前轻量诊断

## 进度

- M1 生产接线：已完成（默认 chat.params 使用静态元数据，不读取历史）
- M2 回归验证：已完成（新增用例先失败后通过；31 项相关测试通过，构建通过）
- M3 日志契约：已完成（operator 文档解释未评估标记及占位字段）

## 实现

默认生产服务停用 history-backed scheduler，保留现有调度接口和注入能力。日志 payload 的 `evaluationPerformed: false` 表示没有评估待压范围或锁；既有兼容字段不能解释为实时统计。压缩执行、投影和发送门槛仍由 messages.transform 负责。

直接修改：`src/runtime/default-plugin-services.ts`、`src/runtime/chat-params-scheduler.ts`、`tests/e2e/interfaces/plugin-hooks-contract.test.ts`、`.sisyphus/docs/operator/live-artifact-investigation.md`。

## 验证证据

新增生产接线测试连续调用两个会话，证明历史读取和 fetch 调用均为零，宿主状态目录为空，模型参数保持一致，三次事件均明确标记未评估。

`npm run build` 通过。三个修改的 TypeScript 文件 LSP error 诊断为空，任务差异检查通过。

相关测试命令：`node --import tsx --test --test-skip-pattern='plugin exposes only|default plugin emits runtime events' tests/e2e/interfaces/plugin-hooks-contract.test.ts tests/e2e/runtime/send-entry-gate.test.ts tests/e2e/runtime/shipped-runtime-regressions.test.ts tests/e2e/interfaces/projection-replay-contract.test.ts tests/architecture/compaction-runner-parallel-commit.test.ts`，31 项通过。

未筛选运行为 31 项通过、2 项失败。两项失败分别是入口源码少于 60 行的旧断言、transform gate 事件的旧断言；均在 HEAD 临时副本复现，未修改。全量 `npm run typecheck` 仍有既有 Bun 测试类型、旧 projection fixture 和 dist 声明问题，本次源码构建及修改文件诊断通过。

## 生效与恢复

已生成构建产物；正在运行的 OpenCode 会话未重启。实际长会话延迟收益尚未测量，两个钩子完成时间之间的间隔不能作为本插件独占耗时。

当前任务未提交。开始时的恢复引用为 `refs/checkpoints/lightweight-chat-params/2026-10-05_08-41-46_recovery_c8e9aadb874f`，保护此前已有的日志开关改动；恢复时仅处理本任务路径。
