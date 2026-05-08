# Visible ID 系统（已实现）

## 文档定位

本文档描述 visible id 的稳定生成规则、落库映射与最终渲染方式。

## 基本规则

- 前六位：永久递增序号（`000001`, `000002`, ...）
- 后缀：基于 canonical host message identifier 的稳定短后缀
- 不使用随机数
- 不因中间消息删除而 renumber
- 删除/隐藏只产生序号空洞，不触发重新编号

## Canonical Message Identifier

当前默认使用 `messages.transform` 消息 envelope 上的 `info.id` 作为 canonical host message identifier。

`parts[*].messageID` 可以作为一致性旁证，但不是第一选择。

## Bare form 与 single-exit render

metadata / sidecar 中保存的是 bare canonical id，例如：

```text
000001_q7
000002_m2
000003_k9
```

最终渲染给模型时，才在单一出口拼出：

```text
[protected_000001_q7]
[compressible_000002_m2]
[referable_000003_w1]
```

## Compact 序号规则

compact 消息的 visible id 序号取被压缩消息的最小值。

## Reminder 序号规则

reminder 消息不把 visible id 序号写到消息层。如果数据库需要记录，可写在数据库里，但不进入消息文本层。

## Sidecar 映射要求

sidecar 应至少持久化：

- `canonical_id`
- `seq6`
- `base62`

并在 projection 最终出口按 `<visible-type>_<seq6>_<base62>` 拼出当前轮可见 id。

## Mark 端点匹配规则

`compression_mark` 的 `from` / `to` 可以使用完整渲染 id，例如 `protected_000001_q7` 或 `compressible_000001_q7`，但运行时定位端点时只使用 bare 部分：`seq6 + base62`。

因此，如果同一条消息在后续 projection 中因为分类变化从 `protected` 变为 `compressible`，或反向变化，只要 `000001_q7` 仍然对应同一条消息，mark replay 仍应命中。`visible-type` 是当前可见状态，不是长期稳定身份的一部分。

## Provider 形态边界

DCP 核心设计以 structured messages / Responses-style input 为主模型。Codex 风格的单字符串 prompt flattening 只是 provider-specific serializer edge case；不要把它反向提升为 visible-id 或 projection 的核心架构。

visible id 是 prompt-visible reference identity，不替代宿主 tool execution identity（如 `toolCallId` / `callID`）。

Cache 实验结论不支持“visible id 天然破坏缓存”的简单规则。更稳妥的判断是：保持早期 prefix 稳定、避免不必要的 prompt-visible 重写，并分别测试 assistant/tool id 插入方式与 tool output shape。Responses API 下 assistant/tool visible id 可以与 cache hit 共存，但输出结构差异会影响结果。

`metadata.dcp.visibleMessageId` 应保存 bare id；`protected` / `referable` / `compressible` 这类状态前缀只在最终 renderer 组合。把状态前缀提前写入 allocator 会导致 `protected_protected_*` 这类双前缀错误。

## 相关文档

- `message-classification-and-visible-state.md`
- `projection-rules.md`
- `../compaction/compaction-lifecycle.md`
