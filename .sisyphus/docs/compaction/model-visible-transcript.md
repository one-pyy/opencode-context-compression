# 模型可见 transcript 契约（已实现）

## 文档定位

本文档固定原始消息在压缩输入、token 估算与 mark 覆盖统计中的共享渲染口径。delete 的输入选材与实施状态见 [删除契约](allow-delete.md#输入选择)；选材和单条原文的渲染是不同层次。

## 已修复问题

旧实现曾存在三类容易混淆的问题：

1. 有 `text` part 的消息只读取文本，忽略同条消息里的 tool call / tool result，导致压缩模型没看到被主模型实际看到的工具内容。
2. 没有 `text` part 但有 `tool` part 的消息会 fallback 到完整 `JSON.stringify(toolParts, null, 2)`，导致宿主内部 `metadata`、`diagnostics`、重复 diff、runtime id 等被塞进压缩请求。
3. `reasoning`、`patch`、`file` 曾被当成额外文本入口特殊展开，造成与真实 tool input/output 口径混杂。

因此会出现两类异常：压缩模型输入明显小于被替换的主请求内容，或者单个压缩请求被内部 metadata 撑到百万 token 级别。

## 目标契约（已实现）

原始消息在压缩输入、mark token 统计、未压缩 marked token 统计及相关 debug 体积估算中必须使用同一个模型可见 transcript renderer。

renderer 的目标不是复原宿主内部对象，而是模拟上游模型在正常会话中能看到的语义层内容。

每条 canonical message 的压缩可见渲染顺序为：

1. 原始 `text` 内容
2. 每个 tool part 的 tool call
3. 同一 tool part 的 tool result

如果某段不存在，则跳过该段；不能因为存在文本就跳过 tool，也不能因为没有文本就序列化完整 tool object。

当前实现只把 `text` 和 `tool.state.input` / `tool.state.output` 作为文本来源。`patch` / `file` 内容若来自工具调用，会通过 tool input/output 计入；renderer 不再为 `patch` / `file` 设计额外展开入口。`reasoning` 不计入。

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

## JSON 规则（已实现）

非字符串 input / output 使用紧凑 JSON：不带缩进，不 pretty-print。中文等 Unicode 字符保持可读输出；不要主动转成 `\uXXXX`。

input 和 output 按模型可见内容完整渲染，不做字符数截断。压缩输入必须等于模型可见内容，否则压缩模型看到的范围与主模型不一致。

体积控制只靠字段白名单：`metadata` / diagnostics / diff 等宿主内部字段直接丢弃，不进入 transcript。历史上的百万 token 膨胀来自这些内部字段，不来自 input/output 本身，因此不需要对 input/output 设上限。

## 消费方约束（已实现）

以下路径必须共享同一个 renderer：

- 压缩 runner 构造 transcript
- reminder / scheduler 使用的 token 估算
- `uncompressedMarkedTokenCount` 与相关 debug 统计
- 用于判断压缩收益或上下文压力的任何 marked-range 体积统计

最终 `messages.transform` 可以继续保留结构化 `parts` 供上游宿主序列化，但压缩输入与 token 估算不得再使用 text-only 口径或完整 tool object 口径；它们只共享“text + tool input/output”这条文本口径。

## 服务计数缓存

`estimateTextTokensWithService` 在服务请求前查询进程内模块级缓存。同一服务端实例的主会话与 task 子会话共享计数；独立进程或独立模块实例各有自己的缓存。只缓存成功服务计数，不保留原文、消息对象、响应或在途 Promise。

缓存最多 65536 条，命中更新使用顺序，超出容量淘汰最久未使用项。条目保留至容量淘汰或宿主重启，不按时间过期。空文本仍直接返回零，不占容量。

键使用 SHA-256，覆盖完整计数文本、有效服务地址、实际 modelName、文本长度和内部键版本。文本以 UTF-16LE 进入摘要，保留孤立代理项的区别。消息身份不进入计数键；流式正文、tool input/output/status 变化重新计数，不参与 renderer 的 metadata 不影响 canonical 计数。reasoning 仍只在侧栏独立统计中计数。

热命中返回此前成功值及 `python-tiktoken` 来源，即使服务此时离线也可复用。未命中请求保持原超时；错误、异常返回和近似回退不缓存，各消费者继续使用自己的 fallback。并发首次未命中不合并，各请求有独立超时；缓存不会跳过每轮的消息分类、分桶、重复消息累加或统计更新时间。

同一地址与模型在宿主生命周期内应对应稳定分词算法。更换计数服务的 tiktoken 版本或编码算法时同步重启 OpenCode 清空缓存；当前服务不返回算法 revision，地址不变不能自动识别算法切换。内部键版本与 LRU 实现在 `src/token-estimation-cache.ts`，计数入口在 `src/token-estimation.ts`。

验收入口为 `tests/architecture/token-estimation-cache.test.ts` 和 `token-service-cache.test.ts`，覆盖容量淘汰、完整键隔离、服务失败恢复、冷/热分类与侧栏分桶、预算边界和跨会话复用。缓存省去热命中的计数 HTTP、请求体 JSON 与服务分词，完整历史读取和文本渲染仍执行。

## 必要回归用例（已实现）

实现时至少覆盖：

1. 同一 assistant message 同时包含 text 和 tool part：渲染结果必须同时包含文本、tool input、tool output。
2. `reasoning` 不计入；`patch` / `file` 不再通过额外入口计入，只能随 tool input/output 计入。
3. tool-only assistant message：渲染结果不得包含 `metadata` / diagnostics / runtime id。
4. 大型 `state.metadata.diagnostics`：即使 metadata 达到 1MB，渲染结果也不受影响。
5. 大型 `state.input` 或 `state.output`：必须完整渲染，不做截断。
6. 非字符串 input / output：使用紧凑 JSON，不能因 pretty JSON 产生额外体积膨胀。

## 相关文档

- `compaction-lifecycle.md`
- `mark-tool-contract.md`
- `../projection/projection-rules.md`
