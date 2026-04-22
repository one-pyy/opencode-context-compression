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

## 相关文档

- `message-classification-and-visible-state.md`
- `projection-rules.md`
- `../compaction/compaction-lifecycle.md`
