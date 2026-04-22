## hook-observation-and-session-prompt-transport-must-stay-separated
Date: 2026-04-22

### Pattern
真实 seam observation 与 compaction transport 选择必须分开看：`experimental.chat.messages.transform`、`chat.params`、`tool.execute.before` 可以作为可观测 seam，但普通 `session.prompt` / `prompt_async` 仍不应直接当作默认 compaction transport。

### Detail
旧文档体系中的首次真实插件运行记录已经给出了实证边界：

- `chat.params` 能看到当前消息与 provider/runtime state，但不是完整 transcript authoring seam
- `experimental.chat.messages.transform` 能看到消息数组与 identity-bearing fields，是 projection 主 seam
- `tool.execute.before` 足以做 DCP-tool-specific gating/observation
- `session.prompt` / `prompt_async` 会穿过普通 session prompt loop，因此默认上不安全

这条规律的价值不在单次 hook 观察结果本身，而在于它能避免后续工作把“可观测”误当“适合承载 compaction transport”。

### Applies To
- seam 选择
- transport 设计
- projection / scheduling / tool gating 的分层判断

Tags: #hooks #transport #seams #runtime #pattern
