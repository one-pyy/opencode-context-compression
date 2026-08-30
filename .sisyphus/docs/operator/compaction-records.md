# Compaction records（已实现）

## 文档定位

本文档固定每个 mark 压缩模型请求的可观测记录契约。该记录用于事后排查“某次 mark 压缩发给模型的输入是什么、模型返回的原始输出是什么”。

## 目录

记录写入插件仓库 artifact 根目录下：

```text
opencode-context-compression/logs/compaction-records/
```

该目录与现有 `logs/runtime-events.jsonl`、`logs/debug-snapshots/` 同属 repo-owned runtime artifacts。

## 文件命名

每次发给压缩模型的请求最多产生一组输入 / 输出文件：

```text
{time}-{sessionID}-{markStartSeq}-{markEndSeq}-{model}-attempt{n}.in.yaml
{time}-{sessionID}-{markStartSeq}-{markEndSeq}-{model}-attempt{n}.out.yaml
{time}-{sessionID}-{markStartSeq}-{markEndSeq}-{model}-attempt{n}.err.yaml
```

要求：

- `time` 放在最前面，使用文件名安全的 UTC 时间戳；同一次请求的 `.in.yaml` 与 `.out.yaml` 使用同一个 time 前缀。
- `sessionID` 使用 OpenCode session id。
- `markStartSeq` / `markEndSeq` 使用本次 mark 对应的 source sequence 边界。
- `model` 与 `attempt{n}` 用来区分 fallback / retry 中的多次模型请求。
- `.in.yaml` 保存实际传给 transport 的压缩模型请求，使用 YAML 保留长文本中的真实换行。
- `.out.yaml` 保存 transport 归一化后的 `plan`、`compression_output`、可选 `explanation`，并保留 `rawContentText` 原始 JSON 字符串。
- `.err.yaml` 保存本次 attempt 在 transport、validator 或 commit 前置计算阶段抛出的错误摘要。若 transport 已返回 payload 但后续阶段失败，`.err.yaml` 同时保存 `response`（包含字段化响应和可用的 `rawContentText`）及 `error` 信息；空 SSE / 无正文失败还会包含 sampled SSE frame 摘要，用于区分上游真空、字段未解析或兼容层格式差异。
- 如果 transport 在拿到 payload 前抛错，会保留 `.in.yaml` 和 `.err.yaml`，不会为了表达失败而写入 `.out.yaml`。

## 记录边界

这些文件是排查用快照，不是 sidecar 真相源。是否完成、是否可投影、是否已经覆盖 mark，仍以 SQLite sidecar 的 result group 与 runtime log 尾部为准。

`.err.yaml` 只表达单次 attempt 抛出的错误快照，不代表整个 mark 的最终状态；fallback 后续 attempt 可能成功。validator error、commit error、result group 状态必须从 runtime log 与 sidecar 判断。

## 相关文档

- `live-artifact-investigation.md`
- `../compaction/compaction-lifecycle.md`
