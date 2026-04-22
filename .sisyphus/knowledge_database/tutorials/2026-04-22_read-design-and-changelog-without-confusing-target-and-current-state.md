## read-design-and-changelog-without-confusing-target-and-current-state
Date: 2026-04-22

### Use When
当你要根据设计文档改代码、配置、测试或文档，但又不能把“目标设计”误读成“当前实现现状”时使用。

### Mechanism
本项目中，设计资料与现状并不是同一层信息：

- 设计文档描述目标契约与统一后的主语义
- changelog / audit / problems 记录的是哪些地方仍未对齐、哪些描述之间仍有冲突

因此阅读顺序不能只看 design 本体。

### Steps
1. 先读当前 docs 中的设计总览与 lifecycle/runtime contract
2. 再看相关的 changelog / conflict audit / problems 条目
3. 区分哪些是当前已实现行为，哪些只是目标态
4. 再决定是修改代码、补测试，还是先修正文档冲突

### Result
执行者不会把目标设计误当实现现状，也不会因为 docs 更新就自动假设 runtime 已完全收敛。

Tags: #design #changelog #workflow #docs
