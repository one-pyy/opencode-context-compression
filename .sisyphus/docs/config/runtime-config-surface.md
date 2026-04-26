# 配置面（已实现）

## 文档定位

本文档描述当前 runtime config 的正式字段、env 覆盖、旧配置概念的命运，以及 metadata 的边界。

## Canonical 配置文件

- 默认 live 配置文件：`~/.config/opencode/opencode-context-compression.jsonc`
- 仓库内模板：`src/config/runtime-config.jsonc`

默认 live 配置放在 OpenCode config 目录；配置中的相对 prompt / log 路径仍按插件仓库根目录解析。

## 关键字段

- `version`
- `allowDelete`
- `promptPath`
- `compactionModels`
- `markedTokenAutoCompactionThreshold`
- `smallUserMessageThreshold`
- `reminder.hsoft`
- `reminder.hhard`
- `reminder.softRepeatEveryTokens`
- `reminder.hardRepeatEveryTokens`
- 四类 reminder `promptPaths`
- `logging.level`
- `compressing.timeoutSeconds`
- `compressing.firstTokenTimeoutSeconds`
- `compressing.streamIdleTimeoutSeconds`
- `toast.enabled`
- `toast.durations.*`
- `schedulerMarkThreshold`
- `runtimeLogPath`
- `seamLogPath`

## 流式 compaction transport timeout 契约

当 compaction transport 采用流式模型调用时，`compressing` 配置面应承载三类 timeout：

- `compressing.firstTokenTimeoutSeconds`
  - 首字 timeout
  - 若模型在该时限内未产生首个 token，则本次模型尝试按 timeout 失败处理

- `compressing.streamIdleTimeoutSeconds`
  - 流中断续 timeout
  - 若模型已经开始流式输出，但连续该时限未再产生新 token，则本次模型尝试按 timeout 失败处理

- `compressing.timeoutSeconds`
  - 总 timeout
  - 单次模型尝试从请求发出到流结束的总时长不得超过该上限

当前 docs 先定义配置契约与目标语义，不表示仓库运行时已经完成流式 transport 实现。

## Toast 配置

- `toast.enabled=false` 会关闭所有 UI toast。
- `toast.durations.*=0` 会只关闭对应类型的 toast，其他 toast 不受影响。
- 当前支持的 duration key：`startup`、`softReminder`、`hardReminder`、`compressionStart`、`compressionComplete`、`compressionFailed`。

例如要关闭欢迎 toast，只需要设置 `toast.durations.startup=0`。

## Token 计数服务

当前 token 估算优先调用本地 Python `tiktoken` 服务：`http://127.0.0.1:40311/count`。可用 `npm run token-counter` 启动该服务。

TypeScript 侧如果服务不可用、超时或返回异常，会自动回退到字符数 / 4 的估算口径，避免阻塞 projection / scheduler。服务地址可用 `OPENCODE_CONTEXT_COMPRESSION_TOKEN_COUNTER_URL` 覆盖；Python 服务端口可用 `OPENCODE_CONTEXT_COMPRESSION_TOKEN_COUNTER_PORT` 覆盖。

## Env 覆盖

环境变量优先级高于默认 live 配置文件，包括：

- `OPENCODE_CONTEXT_COMPRESSION_RUNTIME_CONFIG_PATH`
- `OPENCODE_CONTEXT_COMPRESSION_ALLOW_DELETE`
- `OPENCODE_CONTEXT_COMPRESSION_PROMPT_PATH`
- `OPENCODE_CONTEXT_COMPRESSION_MODELS`
- `OPENCODE_CONTEXT_COMPRESSION_RUNTIME_LOG_PATH`
- `OPENCODE_CONTEXT_COMPRESSION_SEAM_LOG`
- `OPENCODE_CONTEXT_COMPRESSION_LOG_LEVEL`
- `OPENCODE_CONTEXT_COMPRESSION_COMPRESSING_TIMEOUT_SECONDS`
- `OPENCODE_CONTEXT_COMPRESSION_DEBUG_SNAPSHOT_PATH`
- `OPENCODE_CONTEXT_COMPRESSION_TOKEN_COUNTER_URL`

空值或纯空白值在插件启动时应被拒绝。

## 两个阈值不要混淆

- `schedulerMarkThreshold`：内部 / test 兼容阈值，按 mark 数量工作
- `markedTokenAutoCompactionThreshold`：真正的 marked-token readiness 阈值，按 token 工作

marked-token 口径应来自共享 token estimator 或显式 token metadata；不要用 turn-level token delta 反推单条消息大小。

## Metadata 边界

metadata 可以存在，但不是跨轮真相源。跨轮真相在 SQLite sidecar。

## Cache 语义边界

稳定 session/cache identity 与保留 provider exact-prefix cache 是两件事。配置或插件可以稳定 `promptCacheKey`、session headers 或 conversation identity，但只要 compaction / projection 重写早期 prompt-visible 内容，exact-prefix cache 仍会从重写点失效。

## 旧配置概念的命运

### 保留或沿用语义

- `enabled`
- `hsoft`
- `hhard`
- `prompt source`
- `smallUserMessageThreshold`
- `markedTokenAutoCompactionThreshold`
- `logging.level`

### 删除或重做

- 旧 `route` 语义 → 收敛为 `allowDelete`
- `counter.source` / message-count cadence → 收敛为 token cadence 字段
- builtin prompt fallback → 删除，缺文件应 fail fast
- 多种 state.store 后端 → 删除

## 相关文档

- `prompt-assets.md`
- `../compaction/reminder-system.md`
- `../architecture/runtime-model.md`
