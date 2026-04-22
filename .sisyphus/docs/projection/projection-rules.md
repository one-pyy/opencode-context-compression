# 投影规则（已实现 / 半实现）

## 文档定位

本文档描述 replacement、delete-style 结果、mark tool 调用清理以及压缩成功后的 artifact 清理如何共同决定最终 prompt-visible world。

## 消息分类总表

| 消息类型 | visibleState | 是否参与 reminder token 计数 | 是否可被压缩 |
|---|---|---|---|
| `system` | `protected` | 否 | 否 |
| 短 `user` | `protected` | 否 | 否 |
| 长 `user` | `compressible` | 是 | 是 |
| `assistant` | `compressible` | 是 | 是 |
| `tool` | `compressible` | 是 | 是 |

## Replacement 渲染

- `allowDelete=false`：replacement 作为可引用块留在 projection 中，原始源跨度被隐藏
- `allowDelete=true` 且执行普通压缩：replacement 作为可引用块留在 projection 中，之后仍可进入 delete 路径
- `allowDelete=true` 且执行直接删除：projection 渲染为极简 delete notice，原始源跨度被移除
- 已压缩内容不再进入下一轮内部重写

## Mark tool 调用删除

如果 replacement 已成功接管原内容，相应的 mark tool 调用应从 prompt-visible view 中删除。

处理顺序：

1. 先替换原 source span
2. 记录哪些 mark 命中了 replacement
3. 最后统一删除这些 mark tool 调用

SQLite 中仍保留“该 mark 曾存在并被结果消费”的事实，不等于它还必须继续留在投影视图里。

## 压缩成功后的统一清理

一旦某个窗口压缩成功，projection view 中与该窗口职责直接相关、已过期的 artifact 可以统一移除，包括：

- 已被 replacement 覆盖的 mark tool 调用
- 窗口内部已失效的 reminder
- 其他只为压缩前过渡阶段服务的可见 artifact

## 基本渲染算法

对任意节点都执行同一规则：

1. 节点自己有完整结果组 → 直接用自己的结果，整棵子树不再展开
2. 节点自己无结果 → 递归检查子节点，并按原始顺序保留原文 gap
3. 节点和子节点都无结果 → 当前节点本轮不产生替换，保留原位置内容不变

## 错误 tool 调用的视图语义

错误调用：

- 不进入覆盖树
- 不参与 token 统计
- 不参与 replacement lookup
- 但仍作为普通错误消息保留在最终可见世界里

## 相关文档

- `message-classification-and-visible-state.md`
- `visible-id-system.md`
- `../compaction/compaction-lifecycle.md`
- `../compaction/mark-tool-contract.md`
