# Prompt 资产清单与契约

## 文档定位

本文档描述当前 prompt 资产的角色分工与硬约束。运行时真实 prompt 文件仍保留在 `prompts/` 下，docs 只记录其契约。

## 压缩 Prompt

- `prompts/compaction.md`

这是压缩时使用的 system prompt 模板，运行时可以注入：

- 删除许可指令
- 本次执行模式说明
- 输入格式说明
- 输出要求

## Delete Prompt 契约

delete 使用独立 prompt 资产 `prompts/delete.md`，实施状态见 [删除契约](../compaction/allow-delete.md#实施状态)。其转换定义为：

- 输入：按 [输入选择](../compaction/allow-delete.md#输入选择) 组装的 transcript 与主 agent 提供的有效性上下文。
- 转换：按 [目标与保留标准](../compaction/allow-delete.md#目标与保留标准) 提炼后续有效信息，保留来源身份、适用范围和不确定性。
- 输出：按 [输出与替换](../compaction/allow-delete.md#输出与替换) 生成 `compression_output`，使用下述公共 JSON envelope。`compression_output` 必须以 `## 用户相关信息` 开始，集中承载仍有效的用户要求、用途、非目标、偏好、授权和未决用户事项；每条用户信息标明 `[用户明确要求]`、`[用户确认]`、`[用户授权]`、`[用户偏好]` 或 `[用户未决]` 来源标签。其余实现事实和证据边界放在后续标题中。具体模板和正向示例以 `prompts/delete.md` 为准。

文件写入与选区职责见 [主 agent 与本地文档职责](../compaction/allow-delete.md#主-agent-与本地文档职责)。prompt 负责模型转换规则，runtime 负责模式对应的输入构造、JSON 与来源范围校验、结果组完整性和持久化；compact 的 opaque 原文保留要求不能直接套用到 delete。

## Reminder Prompt

四个 reminder prompt 文件：

- `prompts/reminder-soft-compact-only.md`
- `prompts/reminder-soft-delete-allowed.md`
- `prompts/reminder-hard-compact-only.md`
- `prompts/reminder-hard-delete-allowed.md`

这些 reminder prompt 是纯文本正文资产，不是模板。其模型可见承载形态由 `compaction/reminder-system.md` 定义；目标态下正文进入 no-op tool result，而不是独立 user 消息。

四个变体都提醒执行 compact；delete-allowed 正文补充用户显式调用 skill 的授权边界。配置路径保持兼容，具体规则见 [allowDelete 对措辞的影响](../compaction/reminder-system.md#allowdelete-对措辞的影响)。

## 手工整理 Skill

仓库资产为 [skills/context-retire/SKILL.md](../../../skills/context-retire/SKILL.md)。它面向主 agent，负责本地文件留存、最终信息核对与 delete 选区；`prompts/delete.md` 面向压缩模型，只负责输入到整理结果的转换。

在宿主的 skill 搜索目录中安装或链接整个 `context-retire` 目录后，用户明确要求使用 `context-retire` 才启动本次整理。仓库仅提供资产，不会自动安装或加载它。skill 未安装时也可由用户明确指定其文件并要求按该 skill 执行；读取其他文档或普通 cpmark 不构成调用授权。

## 当前状态

旧 `prompts/reminder-soft.md` 和 `prompts/reminder-hard.md` 属于旧版资产，应由四个按 severity × allowDelete 拆分的文件替代。

## 硬约束

- reminder prompt 不使用变量模板
- compaction prompt 是模板
- delete 的独立 prompt 资产遵守 [Delete Prompt 契约](#delete-prompt-契约)
- compaction 响应使用 JSON 对象中的唯一必需 `plan`、唯一必需 `compression_output`、可选且可省略 `explanation`；字段按 `plan` → `compression_output` → `explanation` 顺序生成，`plan` 仅用于执行前自检，不进入最终记忆轨迹
- runtime 只提取 JSON 的 `compression_output` 字符串参与模式对应的校验、source range 映射与持久化；compact 执行 opaque 编号校验，其他 JSON 字段不进入最终轨迹
- 不允许 builtin prompt fallback
- 缺文件、空文件或格式错误时应 fail fast

## 相关文档

- `../compaction/reminder-system.md`
- `../prompting/compaction-prompt-evaluation.md`
