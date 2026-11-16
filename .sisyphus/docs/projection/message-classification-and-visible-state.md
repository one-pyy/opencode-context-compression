# 消息分类与 Visible State（已实现）

## 文档定位

本文档描述 policy 层如何对 canonical messages 做 visible-state 分类，以及这些分类如何影响 reminder 计数、投影和可压缩性。

## 分类规则

每条消息在 policy 层被分类为三种 visible state 之一：

| 消息类型 | visibleState | 说明 |
|---|---|---|
| `system` | `protected` | 系统消息永远受保护，不可压缩 |
| `user` 且加权文本长度 ≤ `smallUserMessageThreshold` | `protected` | compact 保留短用户消息原文 |
| `user` 且加权文本长度 > `smallUserMessageThreshold` | `compressible` | 长用户消息可被压缩 |
| `assistant` | `compressible` | 助手消息可被压缩 |
| `tool` | `compressible` | 工具结果可被压缩 |

主会话的用户消息采用中英文加权长度：中文表意字符每个计 1，连续 ASCII 字母或数字串每段计 2，空白、标点及其他字符每个计 1。阈值数值表示加权后的总量，不是原始字符数；例如 `1536` 可容纳约 768 个英文单词。分类与 `tokenCount` 是否计算共用同一度量。

子 agent 会话通过宿主 `Session.parentID` 检测。此类会话的所有用户消息都为 `protected`，不应用上述阈值，也不计入 compact 可压缩 token；查询成功的父子关系按 sessionId 缓存，查询失败不按主会话降级处理。这里的保护只约束 compact 原文替换，delete 仍可按照 delete 准入与输入契约处理这些用户消息。

## 关键含义

- `tool` 消息参与 reminder token 计数
- compact 按上表保护短用户消息；delete 对用户原文的处理及有效信息继承遵守 [删除契约](../compaction/allow-delete.md#目标与保留标准)，实施状态见该文档。
- `protected` 分类不单独证明 delete 的运行行为，不能将其解释为跨模式永久保留用户原文。
- 分类发生在 policy 层，projection 只消费分类结果

## Tool-only assistant 的合成 shell

当 assistant 已经有正文时，把 assistant 的 visible id 直接放到正文最前面。只有当模型只发出 tool 调用、没有 assistant 文本时，才补一条只含 assistant visible id 的合成 shell。

约束：

- shell 只写 visible id 本身
- 不写 `Calling <tool>` 之类额外解释
- 这是 projection artifact，不写回宿主历史

## Tool result 的 visible id 位置

每个 tool result 都必须有各自独立的 msg id，并直接插到最前面：

- 字符串输出：前置 id
- 数组型输出：把 id 放在最前面的 `input_text`

## 工具执行身份与可见身份分离

- 执行身份继续使用宿主运行时的 `toolCallId` / `callID`
- 可见身份使用插件分配的 visible id

visible id 只用于 prompt-visible 引用，不是宿主工具调度协议的执行主键。

## Durable History 与 Effective Prompt Set 的分离

宿主的 durable history 与真正发给模型的 effective prompt set 是两层不同概念：

- durable history 由宿主维护
- effective prompt set 由 projection 决定

压缩改变的是 prompt 成员资格，不是物理删除宿主历史。

## 相关文档

- `visible-id-system.md`
- `projection-rules.md`
- `../compaction/reminder-system.md`
