# Reminder 系统（已实现）

## 文档定位

本文档描述 reminder 的语义、token 口径、阈值与重复 cadence 规则、prompt 选择方式，以及 thinking-safe 的模型可见承载形态。

## 架构模型

reminder 是 projection 阶段生成的模型可见 artifact，不写入宿主长期历史。

- 从 canonical history 持续计算得出
- 相同 history 导出相同 reminder 位置
- 不是 durable synthetic message
- 作为一个独立 projection artifact 插入在触发 milestone 的消息之后

历史实现曾采用 `chat.params` 决策并在 `messages.transform` 尾部追加 staged reminder 的方式修复“模型不可见”问题。当前契约进一步收敛为 deterministic projection：decision / cadence 仍可由调度层计算，但最终以 canonical history 派生的 projection artifact 出现在模型可见世界中。

## 模型可见承载形态（已实现）

reminder materialize 为明确的 no-op 工具调用 / 工具结果对：

```text
assistant: tool_call opencode_context_compression_notice({})
tool: tool_result <reminder prompt text>
```

工具说明必须保持短而稳定：永远不要调用此工具；此工具只会返回上下文管理提醒；模型需要关注返回内容，并按其中的要求处理上下文。

### 承载不变式

- 每个 reminder 必须 materialize 为完整的 tool-call / tool-result 对，不能产生悬空 tool call。
- no-op 工具名必须稳定，例如 `opencode_context_compression_notice`。
- no-op 工具没有语义输入；如果 provider 协议强制工具调用带参数，只能使用空对象 `{}`。
- prompt 正文放在 tool result 中，模型必须关注 tool result 内容。
- no-op 工具不得进入 compaction mark tree，不得写入宿主 canonical history，不得改变 sidecar 真相源。
- 投影层仍必须保留原始 canonical `reasoning` part；no-op reminder 不能替代 provider 要求原样传回的 reasoning / signature / encrypted reasoning item。

### thinking / tool continuity 边界

no-op 工具载体的目的不是让服务端完全无感，而是避免 `user` reminder 把当前 assistant 工具循环切成新的用户回合。对 Anthropic、Gemini、OpenAI 这类带 thinking block、thought signature 或 reasoning item 的 provider，目标请求形态应保持“assistant 产生工具调用，随后收到对应工具结果”的语义，而不是“用户中途插入新消息”。

OpenCode materialization 层接受 projection 生成的工具调用/结果对，并把它转换成 provider 合法的 tool-use / tool-result 结构。回归测试必须证明：no-op reminder 不是普通 user text，而是合法且闭合的工具调用结果对。

## Token 口径

`hsoft` 与 `hhard` 的 token 计数基于当前投影后仍可见、且 `visibleState === "compressible"` 的 canonical 消息 token。

即：

- `system` 不计入
- 短 `user` 不计入
- 长 `user` 计入
- `assistant` 计入
- `tool` 计入

已被 replacement 隐藏的原始消息不再计入 reminder / toast 展示口径；否则压缩后旧窗口 token 会继续累加，导致 toast 显示高于当前模型实际可见的待压缩 token。

## 首次触发规则

- 潜在可压 token 首次达到 `hsoft` → 触发 soft reminder
- 潜在可压 token 首次达到 `hhard` → 触发 hard reminder，hard 覆盖 soft

## 重复 cadence

当前 reminder 设计保留：

- `hsoft`
- `hhard`
- `softRepeatEveryTokens`
- `hardRepeatEveryTokens`

重复 cadence 已从旧 message-count 语义收敛为按 token 配置的重复 cadence。

## Reminder 锚点

reminder 锚定在实际跨过 milestone 的那条 compressible 消息之后。

## Reminder Prompt 文件

根据 `severity × allowDelete`，当前需要四个 prompt 文件：

- `prompts/reminder-soft-compact-only.md`
- `prompts/reminder-soft-delete-allowed.md`
- `prompts/reminder-hard-compact-only.md`
- `prompts/reminder-hard-delete-allowed.md`

这些都是 reminder prompt 正文，不是模板。正文进入 no-op tool result，不作为独立 user 消息注入。

## `allowDelete` 对措辞的影响

- `allowDelete=false`：提醒 AI 可以压缩，但不把对象当作当前可直接删除目标
- `allowDelete=true`：提醒 AI 可以选择普通压缩，也可以在适合时直接删除

## 压缩完成后的 reminder 清理

当某个压缩窗口成功提交 replacement 后，该窗口内已过期的 reminder 应从最终 projection 中消失。

这属于 effective prompt set 清理，不表示宿主 durable history 被物理删除。

## 相关文档

- `allow-delete.md`
- `../projection/message-classification-and-visible-state.md`
- `../config/prompt-assets.md`
