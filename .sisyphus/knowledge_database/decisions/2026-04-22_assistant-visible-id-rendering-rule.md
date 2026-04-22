## assistant-visible-id-rendering-rule
Date: 2026-04-22

### Decision
assistant visible id 的稳定渲染规则应为：assistant 有正文时，直接把 id 前置到正文；assistant 只有 tool 调用、没有正文时，生成仅含 id 的 assistant shell；每个 tool result 仍需各自独立的前置 msg id。

### Rationale
这条规则来自对旧设计漂移的收敛：比起过度叙述的 shell 文本，这个更小、更稳定，也更符合 projection artifact 的角色。

同时，tool result 的 id 必须前置，才能让模型更可靠地看到 referable identity。

### Alternatives Considered
- 即使有 assistant 正文也总是补 shell：拒绝，因为增加多余结构。
- 在 shell 中加入解释性 prose：拒绝，因为会把核心规则复杂化。
- 整个 tool batch 共用一个结果 id：拒绝，因为每个 tool result 仍需要独立可引用身份。

### Consequences
- docs 中关于 visible id / rendering 的说明应使用该规则。
- 后续若继续拆 DESIGN 的 rendering 章节，应以此为稳定规则，而不是回到旧示例风格。

Tags: #visible-id #rendering #projection #design
