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
```

要求：

- `time` 放在最前面，使用文件名安全的 UTC 时间戳；同一次请求的 `.in.yaml` 与 `.out.yaml` 使用同一个 time 前缀。
- `sessionID` 使用 OpenCode session id。
- `markStartSeq` / `markEndSeq` 使用本次 mark 对应的 source sequence 边界。
- `model` 与 `attempt{n}` 用来区分 fallback / retry 中的多次模型请求。
- `.in.yaml` 保存实际传给 transport 的压缩模型请求，使用 YAML 保留长文本中的真实换行。
- `.out.yaml` 只保存 transport 返回的原始模型 payload。
- 如果 transport 在拿到 payload 前抛错，可能只有 `.in.yaml`，不会为了表达失败而写入 `.out.yaml`。

## 记录边界

这些文件是排查用快照，不是 sidecar 真相源。是否完成、是否可投影、是否已经覆盖 mark，仍以 SQLite sidecar 的 result group 与 runtime log 尾部为准。

这些记录不表达校验结果、提交结果、成功或失败语义；validator error、commit error、result group 状态必须从 runtime log 与 sidecar 判断。

## 相关文档

- `live-artifact-investigation.md`
- `../compaction/compaction-lifecycle.md`
