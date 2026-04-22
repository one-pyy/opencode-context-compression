## design-contract-keeps-token-cadence-and-delete-permission
Date: 2026-04-22

### Decision
当前设计契约必须继续把 repeated reminders 表达为 token-based cadence，并把 `allowDelete=true` 视为真实支持的 delete permission 路径，而不是未来占位语义。

### Rationale
旧文档体系中这条结论是对设计漂移的直接纠偏：

- repeated reminder 不能被错误移除，只能从旧 message-count 语义收敛成 token cadence
- `allowDelete=true` 不能一边写进设计，一边又被当成尚未实现的 future-only placeholder

这类信息属于 durable design decision，应保留在 `knowledge_database/decisions/`，并由 `docs/` 消费其结果，而不是继续埋在旧入口里。

### Alternatives Considered
- 彻底移除 repeated reminders：拒绝，因为与设计目标不符。
- 保留旧 counter/source 语义：拒绝，因为它会反复引入 message-count contract drift。
- 把 `allowDelete` 保留为挂名能力：拒绝，因为目标设计文档应描述支持路径，而不是空壳能力。

### Consequences
- 新 docs 中的 reminder 与 delete permission 相关描述，应采用 token cadence 与 delete permission vocabulary。
- 后续代码与测试讨论不应再回退到旧 `route` 或 message-count cadence 词汇。

Tags: #design #reminder #delete-permission #contract
