# 消息分类与 Visible State（已实现）

## 文档定位

本文档描述 policy 层如何对 canonical messages 做 visible-state 分类，以及这些分类如何影响 reminder 计数、投影和可压缩性。

## 分类规则

每条消息在 policy 层被分类为三种 visible state 之一：

| 消息类型 | visibleState | 说明 |
|---|---|---|
| `system` | `protected` | 系统消息永远受保护，不可压缩 |
| `user` 且文本长度 ≤ `smallUserMessageThreshold` | `protected` | 短用户消息永久保护 |
| `user` 且文本长度 > `smallUserMessageThreshold` | `compressible` | 长用户消息可被压缩 |
| `assistant` | `compressible` | 助手消息可被压缩 |
| `tool` | `compressible` | 工具结果可被压缩 |

## 关键含义

- `tool` 消息参与 reminder token 计数
- 用户消息不是一律不可压缩；只有短用户消息永久保护
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
