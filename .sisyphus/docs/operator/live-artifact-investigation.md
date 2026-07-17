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
- `payload.eligibleMarkCount`
- `payload.projectionMarkCount`

常见有用 scope：

- `background-compaction`：后台压缩任务执行、成功、失败。
- `direct-llm`：压缩模型请求、provider 解析、fallback 失败。
- `experimental.chat.messages.transform`：projection、eligible mark 评估与后台压缩直启。
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

debug snapshot 适合确认投影前后消息结构、模型可见 transcript、prompt 输入和局部 message shape；不适合单独证明后台任务是否完成。排查 token 估算时，可以用 debug snapshot 复算每条消息的 renderer 输出长度或 token，但最终执行状态仍以 runtime log 尾部的 `messages.transform` 与 `background-compaction` 记录为准。

## 压缩未触发时先看什么

排查“会话很长但没有触发压缩”时，不要先看整体会话长度，也不要先看 sidecar 里有没有旧 result。按这个顺序看：

1. 在 `runtime-events.jsonl` 里按目标 `sessionID` 过滤，并只看尾部记录。
2. 找最新 `experimental.chat.messages.transform` completed 记录里的 `payload.projectionDebug`。
3. 找随后出现的 `background-compaction` 记录，确认 eligible mark 是否开始、完成或失败。
4. 再查 sidecar 的 result / visible id / toast，确认是否真的有后台压缩完成或卡住。

`messages.transform` 的 `payload.projectionDebug` 用来判断当前投影状态：

- `totalCompressibleTokenCount`：当前投影里所有 compressible 消息的总 token，不等于自动压缩触发量。
- `uncompressedMarkedTokenCount`：当前 mark tree 中尚未被 result group 覆盖的 marked range token。
- `compressionMarkToolCalls`：历史里 replay 出来的 mark tool 调用数量、成功/失败数量与最近错误。
- `activeMarkTree` / `conflicts`：哪些 mark 真正进入覆盖树，哪些因范围冲突或不可解析被排除。
- `resultGroups`：当前投影已消费的压缩结果。

`messages.transform` 完成后，`background-compaction` 记录用于确认本轮执行边界：

- `eligibleMarkCount`：本轮准备计算的 mark 数量。
- `projectionMarkCount`：projection state 中 replay 出来的 mark 总数。
- 每个 mark 的 executing / completed / exhausted / operational failure 记录。
- live lock：是否已有后台批次正在运行；lock 路径和状态按本 runbook 的 lock 章节检查。

“整体会话很长”但不触发，常见原因是 `totalCompressibleTokenCount` 很高，但 `uncompressedMarkedTokenCount` 低；调度器只看后者。也就是说，只有已 mark 且未被 result group 覆盖的范围会推动自动压缩。

## Session database / sidecar 在哪里

sidecar database 是插件的持久状态来源，用于查 result group、visible id 映射、toast event、失败状态等。

位置取决于目标项目的 runtime 配置与工作目录。排查时先从 runtime log、debug snapshot 或 lock 文件推回目标项目目录，再在该项目的插件状态目录中找 session 对应的 SQLite sidecar。

读取 sidecar 时，重点查：

- result group 是否已经提交，以及 mark 当前的 `failure_count`；达到 3 才属于 terminal。
- visible id / canonical id 映射是否存在。
- toast 或 failure 记录是否已经持久化。

sidecar 当前常见表包括：

- `result_groups`
- `result_fragments`
- `toast_events`
- `visible_sequence_allocations`
- `compaction_failures`

旧 DB 中可能残留 `pending_compactions`。它是已废弃的调度队列表，不保存 replacement 正文或 fragment range；当前 schema bootstrap 只应清理这张 legacy 表，不应把它当成当前运行状态。

sidecar 不保存 scheduler 的最新 token 统计快照；不要假设存在 scheduler state 表。token 统计与 eligible mark 判断以 `messages.transform` 的 projection debug 为准，执行结果以其后的 `background-compaction` 记录为准。

不要只凭 assistant prose 或 toast 文案判断 sidecar 已经更新；必须查数据库记录或 runtime event。一个旧 `result_group` 只能证明某个 mark 曾经压缩完成，不代表后续所有 mark 都已处理，也不代表当前没有新的未压范围。

## Result fragment sequence repair（已实现）

当 `result_groups` 与 `result_fragments.replacement_text` 仍存在，但投影后 token 明显偏高、已压缩范围原文泄漏时，优先检查 result fragment sequence 是否沿用旧 replay 口径。修复流程：

1. 先备份目标 `state/{sessionID}.db`。
2. 确认 `logs/compaction-records/` 中该 session 的 `.in.yaml` 覆盖 DB 中全部 `result_groups.mark_id`。
3. 用当前 projection 输入运行 dry-run：

```bash
node --import tsx scripts/repair-result-group-sequences.ts \
  --session {sessionID} \
  --hook-in logs/debug-snapshots/{sessionID}.projection-in.json
```

4. 只有 dry-run 显示 `skippedCount=0` 时才加 `--apply` 写回。
5. 写回后用 `scripts/run-projection.ts` 和 `scripts/measure-tokens.ts` 验证 token 回落，并确认 `Uncompressed marked tokens=0`。

该流程使用 compaction request transcript 中的 `hostMessageID` 重新映射 fragment 范围；不要直接相信旧 `result_fragments.source_start_seq/source_end_seq`。

如果 `.in.yaml` 缺失但旧 DB 仍有 `result_groups` / `result_fragments`，先做只读 dry-run：从当前 OpenCode message/part 数据重建旧 replay 口径，将 `compression_mark`、`compression_inspect`、`compression_recall` 的 completed tool part 作为旧 synthetic sequence slot，再把旧 `source_start_seq` / `source_end_seq` 映射到 canonical message id 与当前 sequence。该降级路径必须先在有 `.in.yaml` 的 session 上与 transcript 精确算法对齐后再用于缺 records 的 DB。

批量修复使用 `scripts/batch-repair-result-sequences-from-opencode.ts`。默认 dry-run；`--apply` 时只写 `legacy-seq-repairable` 项，并先把将写的 `state/{sessionID}.db` 复制到 `--backup-dir`。脚本按 `compression_mark.from/to`、`visible_sequence_allocations` 与 OpenCode message/part history 复核真实 mark 范围；`current-correct` 不写，`unsafe` 与 `missing-message-source` 只进入 `.sisyphus/tmp/work/seq-repair-batch-*.md` 报告。

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
- 待处理 mark / 成功 mark / 失败 mark 是否交错。
- sidecar 中是否已有失败计数，以及该计数是否已达到 terminal 阈值 3。
- 下一步该查配置来源链、worker 中断、lock cleanup、还是 sidecar 状态。

## 相关文档

- `compression-mark-usage.md`
- `json-snapshot-trimming.md`
- `runtime-config-live-validation-runbook.md`
- `../architecture/verification-boundary.md`
- `../architecture/runtime-model.md`
