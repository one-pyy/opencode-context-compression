# Reminder 系统（已实现）

## 文档定位

本文档描述 reminder 的语义、token 口径、阈值与重复 cadence 规则、prompt 选择方式，以及 thinking-safe 的模型可见承载形态。

## 架构模型

soft/hard reminder 是 projection 阶段生成的模型可见 artifact，不写入宿主长期历史。另有 [cpmark 用户提醒](#cpmark-用户提醒)，通过宿主接口写入用户消息。

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
- 紧随 reminder 的 inspect 也以完整工具调用/结果对承载，输入明确包含 `mode` 与 `to`，正文对应相同模式和跨度。
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

- 所有基础 reminder 都引导对未压缩原文使用 `mode=compact`，soft/hard 阈值、重复 cadence、类型与锚点保持不变。
- `allowDelete=true` 且满足下述摘要阈值时，在原 reminder 后追加退役指令；否则保留普通 compact 清单。
- delete 的内容判断与文件留存遵循 [退役执行准则](allow-delete.md#退役执行准则)，由 skill 承载。

## 摘要退役追加指令

`reminder.hdelete` 默认 `60000`，只影响已产生的 soft/hard 提醒：本次投影的 `del > hdelete` 且 delete 能力开启时，追加 `prompts/reminder-retire.md`，附带 inspect 切换为 `mode="delete"`。摘要超过阈值但 soft/hard 尚未触发时，不生成提醒。阈值与 soft/hard 使用不同基数，不要求大小顺序。

del 在基础投影完成后预先计算，只累计当前实际可见、已应用的 compact 摘要文本；未应用或被覆盖的结果、隐藏原文、system、protected 用户消息及 delete 替换文本不计入。计算使用现有文本估算器与服务缓存，本地计数服务不可用时回退字符估算。面板的 del 直接复用本次投影结果，不另算摘要，也不把异步落盘的旧统计用于提醒判断。

追加指令保留两个动作：未压缩原文用 compact；已压缩摘要按后续是否有用检查并退役。此前未加载 `context-retire` 时再加载，已完整加载则复用。删除准则见 [退役执行准则](allow-delete.md#退役执行准则)。

delete inspect 的 `compressible` 条目可用于 compact 选区，`fragment` 用于摘要退役候选，`user` 用于核对用户要求及范围边界。它只覆盖 reminder 锚点及此前的可选跨度；所需候选超出跨度或清单缺失时，主 agent 再请求 inspect。条目按当前可见文本计数，具体口径见 [Inspect 工具契约](mark-tool-contract.md#inspect-工具契约)；fragment 使用与面板 del 相同的预计算摘要计数。清单总量还包含用户与原文，不能作为摘要 del。

## 压缩完成后的 reminder 清理

当某个压缩窗口成功提交 replacement 后，该窗口内已过期的 reminder 应从最终 projection 中消失。

这属于 effective prompt set 清理，不表示宿主 durable history 被物理删除。

## cpmark 用户提醒

`reminder.cpmarkThreshold` 是正整数，默认 `190000`。异步面板统计发布成功后，使用同一份统计判断：`del + comp > cpmarkThreshold + fixed` 时发送一次提醒；发送成功后进入等待回落状态，直到 `del + comp <= cpmarkThreshold + fixed - 30000` 才重新激活。等于上限不触发，等于下限重新激活，reasoning 不参与计算。

提醒正文固定为“别忘了cpmark，这次不用调用inspect，用之前的就好。cpmark完继续之前的任务。如果之前的任务已结束，同样结束。”，使用 `client.session.prompt` 的 `noReply: true` 写入真实用户消息，不启动回复，不附带 inspect。已经发出的模型请求不会被追加入此消息，后续读取历史时才能看到；旧 inspect 清单可能未覆盖后来新增的消息。

统计调度按会话串行处理，待处理投影合并为最新版本；计算或落盘期间被新投影替代的统计不发送提醒。激活状态保存在各会话 sidecar 的 `schema_meta` 键 `cpmark_reminder_armed` 中，初始激活，重启后沿用。发送失败不关闭激活状态，下次统计发布时重试；错误写入运行诊断。宿主消息写入和 sidecar 状态更新属于两个独立写入，发送成功但响应丢失或状态保存前进程退出时，后续可能重复提醒。

发送前读取当前会话历史，从最新用户消息继承 `agent`（代理）、`model`（模型）、`variant`（推理档位）和 `tools`（工具设置），避免提醒消息使会话回退到默认设置。历史读取失败或没有用户消息时不发送，保持激活状态，等待下次统计发布重试。

此提醒独立于 soft/hard 提醒、toast 和 `allowDelete`，不会发起压缩；宿主保存的提醒随正常历史重放进入后续投影。

## 相关文档

- `allow-delete.md`
- `../projection/message-classification-and-visible-state.md`
- `../config/prompt-assets.md`
