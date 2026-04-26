# Reminder 系统（已实现）

## 文档定位

本文档描述 reminder 的语义、token 口径、阈值与重复 cadence 规则，以及 reminder prompt 的选择方式。

## 架构模型

reminder 是 projection 阶段生成的模型可见 artifact，不写入宿主长期历史。

- 从 canonical history 持续计算得出
- 相同 history 导出相同 reminder 位置
- 不是 durable synthetic message
- 作为一条独立消息插入在触发 milestone 的消息之后

历史实现曾采用 `chat.params` 决策并在 `messages.transform` 尾部追加 staged reminder 的方式修复“模型不可见”问题。当前契约进一步收敛为 deterministic projection：decision / cadence 仍可由调度层计算，但最终以 canonical history 派生的 projection artifact 出现在模型可见世界中。

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

这些都是纯文本提醒消息，不是模板。

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
