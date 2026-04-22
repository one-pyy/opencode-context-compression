# Prompt 资产清单（已实现）

## 文档定位

本文档描述当前 prompt 资产的角色分工与硬约束。运行时真实 prompt 文件仍保留在 `prompts/` 下，docs 只记录其契约。

## 压缩 Prompt

- `prompts/compaction.md`

这是压缩时使用的 system prompt 模板，运行时可以注入：

- 删除许可指令
- 本次执行模式说明
- 输入格式说明
- 输出要求

## Reminder Prompt

四个 reminder prompt 文件：

- `prompts/reminder-soft-compact-only.md`
- `prompts/reminder-soft-delete-allowed.md`
- `prompts/reminder-hard-compact-only.md`
- `prompts/reminder-hard-delete-allowed.md`

这些 reminder prompt 是纯文本提醒消息，不是模板。

## 当前状态

旧 `prompts/reminder-soft.md` 和 `prompts/reminder-hard.md` 属于旧版资产，应由四个按 severity × allowDelete 拆分的文件替代。

## 硬约束

- reminder prompt 不使用变量模板
- compaction prompt 是模板
- 不允许 builtin prompt fallback
- 缺文件、空文件或格式错误时应 fail fast

## 相关文档

- `../compaction/reminder-system.md`
- `../prompting/compaction-prompt-evaluation.md`
