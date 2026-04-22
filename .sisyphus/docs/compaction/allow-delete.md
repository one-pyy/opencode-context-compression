# 删除许可（已实现）

## 文档定位

本文档描述 `allowDelete` 的当前正式语义：它是 delete admission gate，而不是旧 route 枚举，也不是长期持久业务字段。

## 基本定义

`allowDelete` 是当前运行时是否允许创建 delete 型 mark 的准入条件。

它不是：

- keep/delete route 枚举
- mark / replacement / canonical source 的长期局部语义位

## 共同规则

- 删除不是第二套子系统；它属于同一条 mark → result group / delete-style result → projection 语义链
- 无论 `allowDelete` 取值如何，再次内部压缩 compact 结果都被禁止
- `allowDelete=true` 允许的直接删除是终结性清理，不是再次压缩

## Admission 规则

- `mode=compact`：总是允许创建 mark
- `mode=delete`：只有当前 `allowDelete=true` 时才允许
- 若不允许 delete，则该次 tool 调用返回错误结果，不生成可重放的 delete mark

## 完整删除路径

`allowDelete=true` 不是未来占位，而是正式支持的能力。至少支持两种合法结果：

1. 普通压缩
2. 直接删除

delete-style 结果在 projection 中表现为极简 delete notice，并接管原始范围。

## 相关文档

- `mark-tool-contract.md`
- `compaction-lifecycle.md`
- `../projection/projection-rules.md`
