# 投影规则（已实现 / 半实现）

## 文档定位

本文档描述 replacement、delete-style 结果、mark tool 调用清理以及压缩成功后的 artifact 清理如何共同决定最终 prompt-visible world。

## 消息分类总表

| 消息类型 | visibleState | 是否参与 reminder token 计数 | 是否可被压缩 |
|---|---|---|---|
| `system` | `protected` | 否 | 否 |
| 短 `user` | `protected` | 否 | 否 |
| 长 `user` | `compressible` | 是 | 是 |
| `assistant` | `compressible` | 是 | 是 |
| `tool` | `compressible` | 是 | 是 |

## Replacement 渲染

- `allowDelete=false`：replacement 作为可引用块留在 projection 中，原始源跨度被隐藏
- `allowDelete=true` 且执行普通压缩：replacement 作为可引用块留在 projection 中，之后仍可进入 delete 路径
- `allowDelete=true` 且执行直接删除：projection 渲染为极简 delete notice，原始源跨度被移除
- 已压缩内容不再进入下一轮内部重写

已提交 replacement 必须通过最终 prompt-visible projection seam 生效；仅在调度侧或 providerOptions 中写入 side-channel context，不足以证明模型实际看到了缩短后的 transcript。

在当前 OpenCode hook 形态下，`messages.transform` 应原地改写传入的 messages 数组。只把 `output.messages` 替换成新数组，可能让上游继续序列化旧数组引用，导致日志/测试显示已改写但真实 provider request 仍是旧 transcript。

## 前缀幂等约束

已写入宿主历史的同一条消息，在没有 replacement 接管或确定性错误改写时，跨轮投影必须保持稳定，不能因 pending / result / executor 状态变化而在 `ok:true` 与 `ok:false` 之间来回变化。

运行时生命周期状态应进入 sidecar、日志或稳定 notice；不要回写旧 tool result。原因是 provider 的 exact-prefix cache 依赖早期 transcript 字节稳定，动态改写旧前缀会打掉缓存。

## 空 assistant 与 tool-only assistant shell（已实现）

投影层必须区分两类空文本 assistant：

- 纯空尾部 assistant placeholder：没有 `text`，也没有 `tool` part。它只是宿主占位，最终 `contentText` 保持为空，不额外暴露 visible-id-only 文本。
- tool-only assistant：没有 `text`，但存在 `tool` part。它代表真实模型动作，最终 `contentText` 必须渲染为对应 visible id 本身，用作稳定锚点；不要追加 `Calling <tool>` 之类说明文本。

这个 shell 只负责 prompt-visible anchor；工具调用本身仍由结构化 `parts` 保留给最终 materialization 层。

## Mark tool 调用删除

如果 replacement 已成功接管原内容，相应的 mark tool 调用应从 prompt-visible view 中删除。

处理顺序：

1. 先替换原 source span
2. 记录哪些 mark 命中了 replacement
3. 最后统一删除这些 mark tool 调用

SQLite 中仍保留“该 mark 曾存在并被结果消费”的事实，不等于它还必须继续留在投影视图里。

## 压缩成功后的统一清理

一旦某个窗口压缩成功，projection view 中与该窗口职责直接相关、已过期的 artifact 可以统一移除，包括：

- 已被 replacement 覆盖的 mark tool 调用
- 窗口内部已失效的 reminder
- 其他只为压缩前过渡阶段服务的可见 artifact

## 基本渲染算法

对任意节点都执行同一规则：

1. 节点自己有完整结果组 → 直接用自己的结果，整棵子树不再展开
2. 节点自己无结果 → 递归检查子节点，并按原始顺序保留原文 gap
3. 节点和子节点都无结果 → 当前节点本轮不产生替换，保留原位置内容不变

## 错误 tool 调用的视图语义

失败调用：

- 不进入覆盖树
- 不参与 token 统计
- 不参与 replacement lookup
- 最终投影中改写为 `ok:false` 的结构化 tool result，保留具体 `errorCode`、`message` 与 `details`
- 投影层产出 `toolResultOverrides` 补丁；最终 `messages.transform` materialization 层负责把补丁写入宿主会真正序列化的 `compression_mark` tool part `state.output`
- 失败原因来源只包括确定性错误：覆盖树冲突检测的 conflict message、tool 层直接拒绝的原始错误消息。accepted mark 暂无 pending / result 是正常悬挂状态，不应被投影层改写为失败。

## Reasoning part 语义

OpenCode 历史中的 reasoning 内容以 `type: "reasoning"` part 表示，正文在 `text` 字段中。投影层保留 reasoning part 的结构化字段，不应把它降级成普通 text，也不应删除它。

部分 provider 的 thinking / interleaved 模式要求最终 API 请求中带回 `reasoning_content` 或 `reasoning_details` 字段。该字段名属于 provider 请求 materialization 语义，不是 OpenCode part 的字段名；projection 只负责保留 `reasoning` part，不能在 compaction / replay / rendering 过程中丢失其 `text` 内容。

当原始跨度被 result-group replacement 覆盖时，原始 reasoning part 会随原始消息一起被隐藏；replacement assistant message 必须补一个 `type: "reasoning"`、`text: "compressed"` 的 reasoning part，避免 thinking 模式下压缩后的消息缺少 reasoning 内容。

## Transform reprocessing 约束

如果 transform 可能再次处理先前 transform 产出的消息，normalization 必须保留已有 `metadata.dcp`。否则没有稳定 host id 的 assistant 消息可能被重新分配 visible id，而旧文本中的 id 前缀仍残留，产生重复或冲突的可见 id。

孤立 tool result 的 assistant shell 归属判断不能只看紧邻前一条消息；应向前跳过连续 tool 消息，找到最近的非 tool assistant turn 并确认其拥有对应 tool call，只有找不到时才合成 shell。

## 相关文档

- `message-classification-and-visible-state.md`
- `visible-id-system.md`
- `../compaction/compaction-lifecycle.md`
- `../compaction/mark-tool-contract.md`
