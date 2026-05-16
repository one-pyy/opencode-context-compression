 # Live artifact 排查入口（已实现）

## 文档定位

本文档说明真实宿主里排查某个 OpenCode session 时，应该去哪里找会话、日志、debug snapshot、session database、sidecar 与 lock；以及如何避免被旧日志、巨大 JSON、无关 provider 噪声和非尾部记录误导。

## 先定位目标 session

真实会话的第一入口是 OpenCode session id，例如：

```text
ses_...
```

用这个 id 串起所有 artifacts。不要把当前可见消息 id、`msg_...`、压缩 mark id 当成 session id。

需要看宿主会话原文时，优先用：

```bash
opencode export <session-id>
```

如果要查本机历史 session 元数据，也可以用 session 工具读取目标 session。会话本体用于确认“用户和 assistant 说了什么”；runtime log / sidecar / lock 才用于确认插件实际做了什么。

## Runtime log 在哪里

插件运行日志优先看：

```text
opencode-context-compression/logs/runtime-events.jsonl
```

排查时必须按 `sessionID` 过滤，再看文件尾部。不要只看首次匹配，因为同一 session 的旧错误可能已经被后续修复覆盖。

常用判断字段：

- `createdAt`
- `scope`
- `stage`
- `severity`
- `message`
- `payload.markId`
- `payload.error`
- `payload.providerID`
- `payload.schedulerState`
- `payload.activeCompactionLock`
- `payload.pendingMarkCount`

常见有用 scope：

- `background-compaction`：后台压缩任务执行、成功、失败。
- `direct-llm`：压缩模型请求、provider 解析、fallback 失败。
- `chat.params`：当前轮是否调度压缩、是否因已有 lock 而排队。
- `seam` / hook 相关 scope：用于确认 hook 输入输出是否进入插件。

## 记得读尾巴

对 JSONL 日志，要围绕“最新记录”判断，而不是围绕“最早出现的错误”判断。

尤其要区分：

- 错误发生在修复前还是修复后。
- 最新尾部是否仍出现同一错误。
- 某个 mark 是否成功后又有另一个 mark 失败。
- 是否只看到“调度了”，但没有后续 success / failure / cleanup。

如果日志很大，本地命令应显式做尾部或反向读取，例如用 `tail`、`tac`、或脚本保留最后 N 条目标 session 记录。不要依赖普通内容搜索工具的输出顺序来判断“最新”。

## Debug snapshots 在哪里

大体积调试快照通常在仓库日志目录下，例如：

```text
opencode-context-compression/logs/debug-snapshots/
```

读取这类 JSON 时不要整文件塞进上下文。先用 `operator/json-snapshot-trimming.md` 里的脚本截断，再用 `jq` 只看相关字段。

debug snapshot 适合确认投影前后消息结构、模型可见 transcript、prompt 输入和局部 message shape；不适合单独证明后台任务是否完成。排查 token 估算时，可以用 debug snapshot 复算每条消息的 renderer 输出长度或 token，但最终调度判断仍以 runtime log 尾部的 `chat.params` 记录为准。

## 压缩未触发时先看什么

排查“会话很长但没有触发压缩”时，不要先看整体会话长度，也不要先看 sidecar 里有没有旧 result。按这个顺序看：

1. 在 `runtime-events.jsonl` 里按目标 `sessionID` 过滤，并只看尾部记录。
2. 找最新 `experimental.chat.messages.transform` completed 记录里的 `payload.projectionDebug`。
3. 找最新 `chat.params` completed 记录里的 scheduler payload。
4. 再查 sidecar 的 pending / result / toast，确认是否真的有后台压缩完成或卡住。

`messages.transform` 的 `payload.projectionDebug` 用来判断当前投影状态：

- `totalCompressibleTokenCount`：当前投影里所有 compressible 消息的总 token，不等于自动压缩触发量。
- `uncompressedMarkedTokenCount`：当前 mark tree 中尚未被 result group 覆盖的 marked range token。
- `compressionMarkToolCalls`：历史里 replay 出来的 mark tool 调用数量、成功/失败数量与最近错误。
- `activeMarkTree` / `conflicts`：哪些 mark 真正进入覆盖树，哪些因范围冲突或不可解析被排除。
- `resultGroups`：当前投影已消费的压缩结果。

`chat.params` 的 scheduler payload 用来判断这一轮为什么调度或不调度：

- `schedulerState` / `scheduled` / `reason`：最终调度决定。
- `activeCompactionLock`：是否已有后台批次正在运行。
- `pendingMarkCount`：通过 mark 数阈值后的待处理 mark 数。
- `diagnostics.queuedMarkIdsBeforeThreshold`：有结果组之前仍待压缩的 mark。
- `diagnostics.committedResultGroupMarkIds`：已经有 result group 的 mark。
- `diagnostics.uncompressedMarkedTokenCount`：与自动压缩 token 阈值比较的实际数值。
- `diagnostics.markedTokenAutoCompactionThreshold`：当前自动压缩 token 阈值。

“整体会话很长”但不触发，常见原因是 `totalCompressibleTokenCount` 很高，但 `uncompressedMarkedTokenCount` 低；调度器只看后者。也就是说，只有已 mark 且未被 result group 覆盖的范围会推动自动压缩。

## Session database / sidecar 在哪里

sidecar database 是插件的持久状态来源，用于查 pending compaction、result group、visible id 映射、toast event、失败状态等。

位置取决于目标项目的 runtime 配置与工作目录。排查时先从 runtime log、debug snapshot 或 lock 文件推回目标项目目录，再在该项目的插件状态目录中找 session 对应的 SQLite sidecar。

读取 sidecar 时，重点查：

- pending compaction 是否还存在。
- result group 是否已经写入 terminal 状态。
- visible id / canonical id 映射是否存在。
- toast 或 failure 记录是否已经持久化。

sidecar 当前常见表包括：

- `pending_compactions`
- `result_groups`
- `result_fragments`
- `toast_events`
- `visible_sequence_allocations`

sidecar 不保存 scheduler 的最新 token 统计快照；不要假设存在 scheduler state 表。token 统计、调度原因和阈值判断以 `runtime-events.jsonl` 尾部的 `chat.params` / `messages.transform` 记录为准。

不要只凭 assistant prose 或 toast 文案判断 sidecar 已经更新；必须查数据库记录或 runtime event。一个旧 `result_group` 只能证明某个 mark 曾经压缩完成，不代表后续所有 mark 都已处理，也不代表当前没有新的未压范围。

## Lock 文件在哪里

lock 文件在目标项目的 lock 目录下，文件名通常带 session id，例如：

```text
<target-project>/locks/<session-id>.lock
```

判断点：

- `status = running`：仍被认为有批次在执行。
- `note = background compaction batch (...)`：这是后台压缩批次锁。
- `startedAtMs` / `updatedAtMs`：要和 runtime log 尾部时间对齐。

如果 runtime log 尾部没有对应 batch 的后续 success / failure / cleanup，而 lock 仍停在 `running`，应优先怀疑 worker 中断、异常未清锁或 lock cleanup 缺口。

## 常见垃圾信息与误导源

排查时主动避开这些噪声：

- 旧错误：同一个 session 早期可能已经报过错，必须确认尾部是否仍复现。
- 非目标 session：日志中混有其他会话记录，必须按 `sessionID` 过滤。
- 主 OpenCode 日志：可辅助看宿主状态，但插件内部执行以 repo-owned runtime event 为准。
- 单次成功提示：一个 mark 成功不代表整个 session 队列清空。
- 旧 result group：只能证明对应 mark 已完成，不能证明当前未压 token 为 0。
- 总可压 token：`totalCompressibleTokenCount` 高不代表会触发；触发看 `uncompressedMarkedTokenCount`。
- 模型 prose：assistant 说“已完成”不等于工具、sidecar 或 lock 完成。
- 巨大 JSON 快照：直接整读会污染上下文，应先裁剪。
- provider 枚举噪声：`Loaded config`、`Parsed config` 只说明读取成功，不说明请求的 `providerID` 存在。

## Provider / model 配置错误怎么判

如果 runtime event 中出现：

```text
Requested provider is missing from config.
Provider <provider-id> not found in config
```

以 `payload.providerID` 为运行时实际请求的 provider。

如果配置文件已经改成正确拼写，但日志尾部仍请求旧 provider，说明运行路径仍从别处拿到了旧值，常见来源包括：

- 运行进程没有重新加载配置。
- env override 仍提供旧 provider。
- runtime metadata 或项目级配置仍提供旧 provider。
- fallback model 配置仍引用旧 provider。

此时继续查配置来源链，不要把“某个文件已改正确”当成完成。

## 最小排查结论模板

每次排查结束至少写清楚：

- 目标 session id。
- 最新 runtime log 尾部时间。
- 最新错误是否仍存在，发生在修复前还是修复后。
- 当前 lock 是否存在，是否仍是 `running`。
- pending mark / 成功 mark / 失败 mark 是否交错。
- sidecar 中是否已有 terminal 状态或失败状态。
- 下一步该查配置来源链、worker 中断、lock cleanup、还是 sidecar 状态。

## 相关文档

- `compression-mark-usage.md`
- `json-snapshot-trimming.md`
- `runtime-config-live-validation-runbook.md`
- `../architecture/verification-boundary.md`
- `../architecture/runtime-model.md`
