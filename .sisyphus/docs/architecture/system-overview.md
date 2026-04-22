# 系统总览（已实现 / 半实现）

## 文档定位

本文档描述本插件当前最稳定的设计骨架：它如何以宿主历史为真相源、以 SQLite sidecar 承载派生状态、以 deterministic projection 生成当前模型可见世界，并在后台执行压缩。

## 一句话定义

本插件通过“宿主历史 + SQLite sidecar + deterministic projection + 异步 compaction gating”的结构，在不改写宿主 canonical history 的前提下，收缩模型实际可见的上下文窗口。

## 核心设计原则

- **宿主历史是唯一真相源**：插件不写入、不修改、不删除 canonical host history
- **SQLite 是侧车，不是第二套会话**：只保存派生结果与运行时状态
- **投影是确定性的**：相同 canonical history + 相同 sidecar 状态 → 相同 prompt-visible 输出
- **插件是唯一的压缩系统**：不应与其他 compaction / summarize 插件同时运行

## 五层结构

| 层 | 角色 | 当前状态 |
|---|---|---|
| Canonical History | 宿主只读真相源 | 已实现 |
| Sidecar State | 派生状态、运行时状态、结果组 | 已实现 |
| Policy | 分类、token accounting、命中条件 | 半实现 |
| Projection | prompt-visible 视图构造 | 已实现 |
| Scheduling / Execution | 冻结 batch、runner、gate、lock | 半实现 |

## 生命周期主线

1. 读取 canonical host history
2. 同步 sidecar 状态
3. 计算 reminder、mark 命中、replacement 命中与 visible id
4. 在 `messages.transform` 中生成最终 prompt-visible 视图
5. 满足条件时冻结当前 batch 并触发后台 compaction
6. 后续 transform 消费已提交结果

## 当前最重要的约束

- 不要把 host history 与 sidecar 混成两套真相源
- 不要把 docs、knowledge_database 与旧 notepad/notepads 再混写
- 不要把 prompt 契约文档写进 `prompts/`
- 不要把当前运行时局部可用误说成生命周期已经完全收敛

## 半实现与未完全收敛的部分

- durable reminder 语义
- mark 与 marked-token accounting 的完整闭环
- compaction 成功后的 cleanup 语义
- replay-first / admission-only 相关语义仍需继续收敛

## 相关文档

- `runtime-model.md`
- `verification-boundary.md`
- `../projection/message-classification-and-visible-state.md`
- `../compaction/compaction-lifecycle.md`
