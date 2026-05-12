## tool-object-transcript-rendering-bloats-and-omits-compaction-input
Date: 2026-05-12

### Symptom

压缩请求出现两种相反异常：

- 上游主请求减少约 100k token，但后台压缩模型调用输入只有约 15k token，说明压缩模型没有看到全部被替换内容。
- 某次压缩请求触发模型上下文上限错误：`This model's maximum context length is 1048576 tokens. However, you requested 2060648 tokens (2052456 in the messages, 8192 in the completion).`

在 session `ses_1e52b3ec9ffesOUeZC6xxLqlpE` 中，失败的 pending compaction 是 `mark_fef325316963`。用户提供的外部请求记录显示同一时间段出现 1.98M token 级请求，随后多次 504 和 2.06M token 上限错误。

审计确认：`compressible_000291_c1 -> compressible_000319_8Y` 映射到 replay sequence `452 -> 508`，区间内 7 条大型 `apply_patch` tool-only assistant entry 被完整 tool object fallback 放大。7 条完整 JSON 合计约 938.9 万字符 / 234.7 万粗略 token；其中 `state.metadata.diagnostics` 约 315.1 万字符 / 78.8 万粗略 token，主要是重复 pandas/sklearn LSP 假阳性。

### Trigger Conditions

触发需要以下条件之一：

1. assistant message 同时含有 `text` part 与 `tool` part。当前 `readCanonicalMessageText()` 只读取 `type: "text"`，压缩输入与 token 估算会忽略同条消息中的工具调用和工具结果，导致压缩模型输入小于主模型实际可见内容。
2. assistant message 没有 `text` part 但含有 `tool` part。当前 `src/compaction/replay-run-input.ts` 在 `message.contentText` 为空时执行 `JSON.stringify(toolParts, null, 2)`，把宿主内部 tool object 完整写入压缩 transcript。
3. tool part 内部含大型 `state.metadata.diagnostics`、重复 diff、patch cache、runtime id、provider item id 等非模型可见字段时，完整 JSON fallback 会把这些字段一起提交给压缩模型。

### Resolution

2026-05-13 已实现统一的模型可见 transcript renderer，并让压缩输入、token 估算、marked-range 体积统计共享它。

renderer 只保留模型正常可见语义：普通 text、tool name、`state.status`、`state.input`、`state.output`。它必须丢弃 `metadata`、`state.metadata`、`state.title`、runtime id、provider item id、diagnostics、重复 diff、重复 patch cache、加密 reasoning metadata 与宿主调度状态。

非字符串 input/output 使用紧凑 JSON。每个 input 和 output 分别保留前 10,000 字符与后 10,000 字符，中间插入包含原始长度和省略长度的标记。

不要用工具类型特化规则修补这个问题。统一 renderer 更接近模型可见 transcript，也能避免每个 tool 单独维护一套容易漂移的摘要逻辑。

Tags: #compaction #tool-calls #token-estimation #runtime #trap
