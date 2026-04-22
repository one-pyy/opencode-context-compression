## transform-hook-role-surface-cannot-express-literal-system-artifacts
Date: 2026-04-22

### Pattern
当前本仓库所使用的 `experimental.chat.messages.transform` 类型面并不接受任意字面 `system` role 输出；因此概念上类似 system 的 reminder / protected artifact，必须通过当前 hook 可接受的 envelope 形状表达，而不是直接假设可以发出字面 `system` role 消息。

### Detail
旧文档体系里这条经验的长期价值在于：它提醒实现者区分两个层面：

- 架构上的“protected derived artifact”语义
- 当前本地 plugin SDK / TypeScript surface 实际允许的输出 envelope

对本仓库版本而言，安全做法是：

- 保持 reminder 是 derived、non-durable artifact
- 在 projection 与 visible-state 层表达其保护语义
- 不把“概念上类似 system”误当成“实现上必须输出字面 system role”

### Applies To
- `messages.transform`
- projection builder
- future derived-artifact work

Tags: #projection #types #hooks #artifact #pattern
