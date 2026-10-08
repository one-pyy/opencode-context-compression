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
- `deletePromptPath`
- `leadingUserPromptPath`
- `compactionModels`
- `markedTokenAutoCompactionThreshold`
- `idleThresholdMs`
- `smallUserMessageThreshold`
- `reminder.hsoft`
- `reminder.hhard`
- `reminder.hdelete`
- `reminder.cpmarkThreshold`
- `reminder.softRepeatEveryTokens`
- `reminder.hardRepeatEveryTokens`
- 四类 reminder `promptPaths`
- `reminder.promptPaths.retire`
- `logging.level`
- `compressing.timeoutSeconds`
- `compressing.firstTokenTimeoutSeconds`
- `compressing.streamIdleTimeoutSeconds`
- `compressing.maxFailureCount`
- `toast.enabled`
- `toast.durations.*`
- `schedulerMarkThreshold`
- `runtimeLogPath`
- `seamLogPath`
- `debugSnapshotPath`

## 日志与快照开关

`runtimeLogPath`、`seamLogPath`、`debugSnapshotPath` 都可关闭：

- 三者设为 `null` 即关闭对应写入；省略（不写该键）同样关闭。
- `runtimeLogPath` / `seamLogPath` 省略时也视为关闭，不再要求必填。
- `logging.level` 只控制诊断（`writeDiagnostic`），不控制上述三个写入方。

关闭 `seamLogPath` 会在三个 hook 的观测采集前跳过，不创建内存 journal，不扫描 shape / identity，也不写 seam 文件；projection、scheduler、tool gate 和 runtime 事件继续正常执行。启用 seam 文件观测时仍保留现有内存 journal，应按调试需要启用。

默认 live 配置与仓库模板保留 `runtimeLogPath` / `seamLogPath`；`debugSnapshotPath` 默认关闭（模板中注释掉），因为它在每次 `messages.transform` 写全量消息快照，超大会话单轮可达 GB 级。seam 观测日志在超大会话下每轮对每条消息每个 part 采集 identity 字段，是体量最大的一项，通常可优先关闭。

## 模式对应的提示词

`allowDelete` 控制运行时能力准入；内容判断与自主选区遵循 [退役执行准则](../compaction/allow-delete.md#退役执行准则)。现有四个基础 reminder 配置路径保持不变；追加退役正文由 `reminder.promptPaths.retire` 指定，默认 `prompts/reminder-retire.md`。

`reminder.hdelete` 是正整数，默认 `60000`，可独立于 soft/hard 设置。它在已有提醒产生时决定是否追加退役指令，不新增提醒触发条件。具体计数与严格大于判断见 [摘要退役追加指令](../compaction/reminder-system.md#摘要退役追加指令)。

`reminder.cpmarkThreshold` 控制无需回复的用户提醒，省略时使用默认值；触发、回落重新激活和消息保存契约见 [cpmark 用户提醒](../compaction/reminder-system.md#cpmark-用户提醒)。

`promptPath` 用于 compact；`deletePromptPath` 用于 delete，省略时加载仓库资产 `prompts/delete.md`。两者路径都相对插件仓库根目录解析，也接受绝对路径。delete 文件缺失、空白或包含未展开模板变量时加载失败，不使用 compact prompt 替代。新增字段不改变 `allowDelete` 的值。

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

每次发送只执行一轮完整模型链：按 `compactionModels` 顺序让每个模型尝试一次，任意模型成功即停止并清除失败计数；整链失败累计一次。`compressing.maxFailureCount` 控制停止自动调度的跨发送失败上限，默认值为 `99999`，因此临时 provider、网络或配置故障不会在少量发送后永久冻结 mark。

当前 docs 先定义配置契约与目标语义，不表示仓库运行时已经完成流式 transport 实现。

## Toast 配置

- `toast.enabled=false` 会关闭所有 UI toast。
- `toast.durations.*=0` 会只关闭对应类型的 toast，其他 toast 不受影响。
- 当前支持的 duration key：`startup`、`softReminder`、`hardReminder`、`compressionStart`、`compressionComplete`、`compressionFailed`。

例如要关闭欢迎 toast，只需要设置 `toast.durations.startup=0`。

## Token 计数服务

当前 token 估算优先调用本地 Python `tiktoken` 服务：`http://127.0.0.1:40311/count`。可用 `npm run token-counter` 启动该服务。

TypeScript 侧如果服务不可用、超时或返回异常，会自动回退到字符数 / 4 的估算口径，避免阻塞 projection / scheduler。服务地址可用 `OPENCODE_CONTEXT_COMPRESSION_TOKEN_COUNTER_URL` 覆盖；Python 服务端口可用 `OPENCODE_CONTEXT_COMPRESSION_TOKEN_COUNTER_PORT` 覆盖。

delete 的发送前预算检查见 [输入选择](../compaction/allow-delete.md#输入选择)。它在计数服务不可用时使用 UTF-8 字节数作保守估计，不使用调度器的字符数 / 4 回退。

计数入口的进程内共享、容量淘汰和算法变更重启要求见 [服务计数缓存](../compaction/model-visible-transcript.md#服务计数缓存)。缓存是内部优化，不新增 runtime config 字段；热命中复用此前成功的服务计数，未命中且服务失败时才执行上述回退。

## Env 覆盖

环境变量优先级高于默认 live 配置文件，包括：

- `OPENCODE_CONTEXT_COMPRESSION_RUNTIME_CONFIG_PATH`
- `OPENCODE_CONTEXT_COMPRESSION_ALLOW_DELETE`
- `OPENCODE_CONTEXT_COMPRESSION_PROMPT_PATH`
- `OPENCODE_CONTEXT_COMPRESSION_DELETE_PROMPT_PATH`
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
