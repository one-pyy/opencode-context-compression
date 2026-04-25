# 旧设计资料到新文档体系的迁移图（进行中）

## 文档定位

本文档说明根 `DESIGN.md`、`.sisyphus/notepad/`、`.sisyphus/notepads/` 中的高价值信息，应该如何迁入新的 `.sisyphus/docs/` 与 `.sisyphus/knowledge_database/` 正式体系。

## 迁移目标

最终目标不是“给旧目录加说明”，而是让新体系可以独立承载所有高价值信息：

- `docs/` 承接设计契约、当前实现参考、工具与 prompt 使用说明
- `knowledge_database/` 承接 durable 决策、问题、规律、教程

## 迁移规则

### 进 `docs/`

- 当前实现参考
- 目标设计契约
- API / 配置 / prompt / runtime 边界
- 操作步骤、工具使用、评估方法

### 进 `knowledge_database/`

- 为什么做这个设计决策
- 什么问题会出现
- 某类问题的判断规律
- 可复用工作流

## 旧资料的主要去向

### 根 `DESIGN.md`

主要去向：`docs/architecture/`、`docs/projection/`、`docs/compaction/`、`docs/config/`

### `.sisyphus/notepad/`

主要去向：`docs/operator/` 与 `docs/prompting/`

### `.sisyphus/notepads/`

主要去向：`knowledge_database/`

## 不应整包迁移的内容

- task-local handoff
- review verdict
- 一次性 checklist
- 仅对单次工作流有效的状态汇报

## 旧 fork 维护教程的去向

旧 `dcp-code-style-refactor-guide` 描述的是 `opencode-dcp-fork` 阶段的 god-file 拆分方法：按 runtime、decision、inventory、marks、compaction、backend、errors、shared 等责任边界拆模块，并保持行为不变。当前 clean-slate docs 已经用新的 runtime model 和 migration map 承接这类结构边界；该旧教程不应再作为当前实现目录图使用，但其 durable 原则保留为迁移背景：按责任拆分，不按行数切文件，不把工具 transport、runtime policy 与 prompt projection 混在同一层。

## 删除前条件

只有在以下条件全部满足时，旧资料才可以考虑删除：

1. 新 docs / knowledge_database 已覆盖旧资料中的高价值信息
2. 新索引可以独立导航，不再依赖旧目录
3. 旧路径已不再承担信息责任
