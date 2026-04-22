## repo-owned-operator-docs-and-live-verification-maintenance
Date: 2026-04-22

### Use When
当任务会修改 operator-facing docs、live verification 边界说明，或相关 durable memory 时使用。

### Mechanism
这个子项目有两层必须同时保持一致：

1. **runtime contract**：由 repo-owned code / config / prompt / tests 定义
2. **operator contract**：由 README、live verification docs、以及对应 durable memory 共同表达

维护时不要让 operator contract 超过 runtime 与自动化测试真实证明的边界。

### Steps
1. 先确认当前 repo-owned contract 的 truth boundary 没变
2. 若改 operator wording，同时检查 live verification 文档与 durable records
3. 若改动改变了 lasting rule 或 proof boundary，把原因写入 `knowledge_database/decisions/`
4. 若改动形成可复用维护流程，把步骤写入 `knowledge_database/tutorials/`

### Result
operator-facing 文档、verification 说明和 durable memory 会继续表达同一份 repo-owned contract，而不是漂回旧 host-owned 或 overclaimed wording。

Tags: #operator #verification #docs #workflow
