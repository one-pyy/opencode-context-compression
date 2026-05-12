# 模型可见 transcript 契约（已实现）

## 文档定位

本文档固定压缩输入、token 估算、mark 覆盖统计共享的模型可见消息渲染口径。

## 已修复问题

旧实现曾存在两种相反错误：

1. 有 `text` part 的消息只读取文本，忽略同条消息里的 tool call / tool result，导致压缩模型没看到被主模型实际看到的工具内容。
2. 没有 `text` part 但有 `tool` part 的消息会 fallback 到完整 `JSON.stringify(toolParts, null, 2)`，导致宿主内部 `metadata`、`diagnostics`、重复 diff、runtime id 等被塞进压缩请求。

因此会出现两类异常：压缩模型输入明显小于被替换的主请求内容，或者单个压缩请求被内部 metadata 撑到百万 token 级别。

## 目标契约（已实现）

压缩输入、mark token 统计、未压缩 marked token 统计、相关 debug 体积估算必须使用同一个模型可见 transcript renderer。

renderer 的目标不是复原宿主内部对象，而是模拟上游模型在正常会话中能看到的语义层内容。

每条 canonical message 的渲染顺序为：

1. 原始 `text` 内容
2. 每个 tool part 的 tool call
3. 同一 tool part 的 tool result

如果某段不存在，则跳过该段；不能因为存在文本就跳过 tool，也不能因为没有文本就序列化完整 tool object。

## 通用 tool 渲染格式（已实现）

所有 tool 使用同一个通用格式，不按工具类型特化：

```text
[tool call]
name: <tool>
input: <compact JSON or string>

[tool result]
status: <state.status>
output: <compact JSON or string>
```

保留字段：

- `tool`
- `state.status`
- `state.input`
- `state.output`

丢弃字段：

- `metadata`
- `state.metadata`
- `state.title`
- `state.time`
- `callID`、`messageID`、`sessionID`、provider item id 等运行时身份字段
- diagnostics、重复 diff、重复 patch cache、加密 reasoning metadata、宿主调度状态

## JSON 与截断规则（已实现）

非字符串 input / output 使用紧凑 JSON：不带缩进，不 pretty-print。中文等 Unicode 字符保持可读输出；不要主动转成 `\uXXXX`。

input 和 output 各自应用 head-tail 上限：

- 前 10,000 字符
- 后 10,000 字符
- 中间用明确省略标记连接，标记必须包含原始字符数与省略字符数

截断只应用于单个 input 或 output 字段，不应用于整条 transcript 的最终拼接结果；这样可以避免一个超大工具结果吞掉同条消息其他信息。

## 消费方约束（已实现）

以下路径必须共享同一个 renderer：

- 压缩 runner 构造 transcript
- reminder / scheduler 使用的 token 估算
- `uncompressedMarkedTokenCount` 与相关 debug 统计
- 用于判断压缩收益或上下文压力的任何 marked-range 体积统计

最终 `messages.transform` 可以继续保留结构化 `parts` 供上游宿主序列化，但压缩输入与 token 估算不得再使用 text-only 口径或完整 tool object 口径。

## 必要回归用例（已实现）

实现时至少覆盖：

1. 同一 assistant message 同时包含 text 和 tool part：渲染结果必须同时包含文本、tool input、tool output。
2. tool-only assistant message：渲染结果不得包含 `metadata` / diagnostics / runtime id。
3. 大型 `state.metadata.diagnostics`：即使 metadata 达到 1MB，渲染结果也必须保持在 input/output 上限内。
4. 大型 `state.input` 或 `state.output`：保留前 10,000 字符与后 10,000 字符，并包含省略标记。
5. 非字符串 input / output：使用紧凑 JSON，不能因 pretty JSON 产生额外体积膨胀。

## 相关文档

- `compaction-lifecycle.md`
- `mark-tool-contract.md`
- `../projection/projection-rules.md`
