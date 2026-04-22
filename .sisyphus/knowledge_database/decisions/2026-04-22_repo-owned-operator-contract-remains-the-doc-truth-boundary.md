## repo-owned-operator-contract-remains-the-doc-truth-boundary
Date: 2026-04-22

### Decision
关于 operator-facing 文档与 live verification 边界，`opencode-context-compression` 仍应坚持 repo-owned contract：公开工具只有 `compression_mark`，配置与 prompt 资产以本仓库为准，完整 keep/delete 证明以 repo-owned automated tests 为准，而不是以旧宿主工具或单次真实会话观察为准。

### Rationale
旧文档体系中关于 operator contract 的结论仍然有效，而且在迁往 `docs/` 与 `knowledge_database/` 后仍需要保留这个边界，否则新文档体系会重新混入两套 competing contracts。

这条边界有两个关键价值：

1. 文档可以直接绑定本仓库维护的 config、prompt、lock、log 和测试边界。
2. live verification 的成功范围必须诚实，不得把 plugin loaded 的观察误说成完整 keep/delete 证明。

### Alternatives Considered
- 继续保留旧 host-tool wording：拒绝，因为会把 operator-facing contract 再次拆成两套真相源。
- 把真实会话观察视为完整行为证明：拒绝，因为当前 live path 仍不等同于 repo-owned automated proof。

### Consequences
- `docs/` 中关于 operator / live verification 的说明必须继续保留 truth boundary。
- 后续若 broaden real-session claims，必须同步更新 docs 与测试，而不是只改一侧。

Tags: #operator #docs #verification #contract
