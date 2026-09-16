# Recall Tool 契约（已实现）

## 文档定位

本文档描述 `compression_recall` tool 的实现：让模型召回未被生效 delete 覆盖的原始 host history transcript。

## 背景问题

compact 结果在投影中表现为 `referable` replacement，模型只能看到压缩后的摘要，无法回看压缩前的原始内容。当模型需要验证摘要中的具体细节、引用原文、或确认压缩是否丢失关键信息时，没有回查手段。

## 设计方向

新增 `compression_recall` tool，采用与 `compression_inspect` 相同的占位符模式：tool 调用当下返回占位符 id，`messages.transform` 每轮投影时填充真实内容。

## 输入

```typescript
interface CompressionRecallInputV1 {
  readonly from: string;
  readonly to: string;
}
```

- `from` / `to` 是双闭区间端点，与 `compression_mark` / `compression_inspect` 一致
- **不校验 visible-type 与 suffix**，只提取 `visibleSeq` 数字
- 接受任意合法 visible id 形态（`compressible_000123_ab`、`referable_000130_q7` 等均可）
- 范围顺序要求：`from.seq ≤ to.seq`；可回查范围遵循下述删除边界。

## 输出

```typescript
type CompressionRecallErrorCode = "INVALID_RANGE" | "TARGET_NOT_FOUND" | "SESSION_NOT_READY" | "RANGE_RETIRED";

interface CompressionRecallSuccess {
  readonly ok: true;
  readonly recallId: string;  // "recall_xxxxxx"
}
```

tool 调用当下只返回 `recallId` 占位符。真实内容由 `messages.transform` 每轮填充。

## 准入

无 `allowDelete` gate。调用时检查 session-ready；投影填充时检查删除边界。调用返回占位符不代表范围可回查。

## 删除边界

请求范围与任一已生效 delete 来源范围相交时，整次请求返回 `RANGE_RETIRED`，不返回未重叠部分。错误详情的 `retiredRanges` 列出相交 delete 组的来源范围，调用者可缩小查询范围；已退役内容通过事先留存的项目文件取得。

生效依据是 result group 的持久 `applied` 状态，或本次实际渲染的 replacement 集合。替换门槛打开但未被投影采用的结果不触发拒绝；仅有 mark、执行失败或门槛关闭且尚未应用的结果也不触发拒绝。已应用的 delete 边界在门槛关闭及后续覆盖后仍有效。

每轮投影重新检查历史中的 accepted recall，因此早先成功的 recall 在目标随后被 delete 覆盖时也返回该错误。宿主档案仍保留，此规则限制的是插件的 recall 通道，不是物理擦除档案或清理其他工具、助手文本中已有的副本。compact 覆盖范围保持可回查。

## 填充机制

### Replay 侧

`history-replay-reader.ts` 新增：

- `ReplayableCompressionRecallToolEntry`，识别 `toolName === "compression_recall"`
- `ReplayedCompressionRecallToolCall`，提取 `input.from` / `input.to`

### Projection 侧

新建 `projection/compression-recall.ts`：

1. 遍历 `state.history` 中已 replay 的 `compressionRecallToolCalls`
2. 对每个 accepted call，解析 `from` / `to` 的 `visibleSeq`
3. 检查范围顺序和删除边界，通过后从 `state.history.messages` 读 `[fromSeq, toSeq]` 范围内的原始消息
4. 用 `renderModelVisiblePartsText` 渲染每条消息（同 compaction input builder 口径）
5. 格式化为 transcript blocks
6. 产出 `ToolResultOverride { sourceMessageId, toolName: "compression_recall", output }`

### 定位逻辑

先根据 result group 与实际渲染结果检查删除边界，再将 `visibleSeq` 范围直接映射到 host history sequence range；不匹配 fragment 或校验 referable 类型。

对 referable 编号：`visibleSeq` 就是 fragment 的 `sourceStartSeq` / `sourceEndSeq`，seq range 自然等于原始 source range。

对 compressible / protected 编号：seq range 映射到当前已可见的原始 host history 内容，recall 返回的是去掉投影包装的原文。

## 填充内容格式

与 compaction input 的 transcript 格式一致：

```
### 3. user host_3 (msg_003)
不要动 tsconfig，只修这个文件的问题。

### 4. assistant host_4 (msg_004)
收到。不动 tsconfig，改为在 loader.ts 内局部处理...
[tool call: edit src/config/loader.ts → File edited successfully.]
```

- 每条消息用 `renderModelVisiblePartsText(parts)` 渲染（text + tool parts，head/tail 截断 10k+10k）
- **不包含 opaque placeholder 包裹**——recall 展示的是原始 host history，不是 compaction input
- recall tool result 作为普通 message 留在历史中，带 `compressible` visible id 前缀

## 与现有系统的交互

| 环节 | 行为 |
|---|---|
| token 计数 | recall tool result 是普通 message，正常参与计数 |
| visible state | `compressible`，分配 `compressible` visible id |
| 可压缩 | 是。模型可对它打 `compression_mark`，压缩后变 replacement |
| 覆盖树 | recall tool result 不在覆盖树中（它不是 mark），但可被 mark 覆盖 |
| 再次 recall | 每次按当前删除边界重新检查；允许范围仍返回原始内容 |
| delete 结果 | 已生效 delete 来源范围不可回查，改读已留存的项目文件 |

## 边界情况

- **`from` / `to` 无法解析为有效 seq** → `INVALID_RANGE`
- **`from.seq > to.seq`** → `INVALID_RANGE`
- **范围与生效 delete 相交** → `RANGE_RETIRED`，不输出任何原始内容
- **seq 超出 host history 范围** → 返回存在的部分，不报错。host history 是动态增长的，模型可能引用了刚出现但尚未被 replay 读取的 seq
- **范围内一条消息都没有** → `TARGET_NOT_FOUND`
- **source range 内有消息已被删除 from host history** → 跳过缺失消息，返回存在的部分，不 crash

## 需要改动的现有类型/文件

| 文件 | 改动 |
|---|---|
| `projection/types.ts` | `ToolResultOverride.toolName` 联合类型加 `"compression_recall"` |
| `history/history-replay-reader.ts` | 加 `ReplayableCompressionRecallToolEntry` + `ReplayedCompressionRecallToolCall` + 识别逻辑 |
| `projection/compression-recall.ts` | **新建**，`buildCompressionRecallOverrides(state)` |
| `tools/compression-recall/contract.ts` | **新建**，输入校验 + 序列化 |
| `tools/compression-recall/tool.ts` | **新建**，tool 定义 + admission |
| `projection/projection-builder.ts` | 调用 `buildCompressionRecallOverrides` 并合并到 `toolResultOverrides` |
| `runtime/messages-transform.ts` | materialization 层应用 override 时识别 `compression_recall` toolName |
| `index.ts` | 注册新 tool |

## 设计取舍

### 为什么不限制只对 referable 编号 recall

- referable 的 seq range 天然等于原始 source range，不需要特殊处理
- 允许任意编号让 tool 语义更通用：召回指定 seq 范围的原始 host history
- 编号类型不影响定位；删除边界统一由结果组的生效覆盖判断
- 模型不需要记住"这个 tool 只能对 referable 用"

### 为什么不做轮数限制或永久展开状态管理

- recall tool result 就是历史里的一条普通 message，自然参与 token 计数、自然可被压缩
- 不引入"展开到期"、"展开状态字段"、不改覆盖树
- 模型自主决定何时 recall、何时压缩 recall result
- 唯一代价是 token 占用，由模型自己承担

### 为什么 recall result 带 visible id 前缀

- recall result 需要可被 `compression_mark` 标记，而 mark 需要可见的 visible id 作为 from/to 端点
- 不带前缀等于剥夺了模型压缩 recall result 的能力

## 相关文档

- `mark-tool-contract.md`
- `model-visible-transcript.md`
- `../projection/projection-rules.md`
