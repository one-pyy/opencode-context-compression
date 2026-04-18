# compression_mark Tool 使用指南

## 概述

`compression_mark` 工具用于标记对话消息范围进行压缩或删除，从而减少上下文大小同时保留重要信息。

## 基本用法

### 完整示例

```json
{
  "contractVersion": "v1",
  "mode": "compact",
  "target": {
    "startVisibleMessageID": "msg_d9c014aa2001Fj6KX6ypuz0nNf",
    "endVisibleMessageID": "msg_d9c01b4e2001def",
    "hint": "Preserve all file paths and error messages"
  }
}
```

### 参数说明

#### `contractVersion` (必需)
- **值**: 必须是 `"v1"`
- **说明**: 当前合约版本

#### `mode` (必需)
- **值**: `"compact"` 或 `"delete"`
- **推荐**: 大多数情况使用 `"compact"`
- **说明**:
  - `"compact"`: 将消息压缩为密集摘要，保留关键信息
  - `"delete"`: 完全删除消息（仅用于完全无关的内容）

#### `target` (必需)
- **类型**: 对象
- **字段**:
  - `startVisibleMessageID`: 范围起始消息 ID（格式：`msg_...`）
  - `endVisibleMessageID`: 范围结束消息 ID（格式：`msg_...`）
  - `hint` (可选): 压缩策略指导

## 如何找到消息 ID

消息 ID 在对话历史中显示为 `msg_...` 格式的标识符。

示例：
```
### 1. user host_1 (msg_d9c014aa2001Fj6KX6ypuz0nNf)
Read the design doc

### 2. assistant host_2 (msg_d9c0188dd001YtQl1y7N4Z65Ih)
I'll read the DESIGN.md file for you.
```

要压缩这两条消息，使用：
- `startVisibleMessageID`: `"msg_d9c014aa2001Fj6KX6ypuz0nNf"`
- `endVisibleMessageID`: `"msg_d9c0188dd001YtQl1y7N4Z65Ih"`

## Hint 使用指南

### 何时使用 hint

当你希望压缩保留特定类型的信息时，提供 hint 可以指导压缩策略。

### Hint 示例

#### 调试会话
```json
"hint": "Preserve all file paths and error messages from this debugging session"
```
**效果**: 保留所有文件路径和错误详情，压缩对话部分

#### 探索性工作
```json
"hint": "Focus on the final solution, compress intermediate exploration steps"
```
**效果**: 详细保留最终方案，总结试错过程

#### 技术实现
```json
"hint": "Keep tool parameters and results, summarize conversational parts"
```
**效果**: 保留技术细节，压缩客套话

#### 上下文收集
```json
"hint": "This is context gathering, retain all discovered file locations"
```
**效果**: 列出所有发现的文件，压缩搜索过程

### Hint 最佳实践

- **简洁明确**: 一句话说明保留什么
- **具体**: 指定具体的信息类型（文件路径、错误消息、参数等）
- **可选**: 如果没有特殊要求，可以省略 hint

## 常见错误和解决方法

### 错误 1: contractVersion 不正确

**错误消息**:
```
compression_mark contractVersion must be exactly "v1" (current version). You provided: "2025-05-01"
```

**解决方法**: 使用 `"contractVersion": "v1"`

### 错误 2: target 格式错误

**错误消息**:
```
compression_mark target must be a single object with startVisibleMessageID and endVisibleMessageID.
```

**解决方法**: 确保 target 是对象格式：
```json
"target": {
  "startVisibleMessageID": "msg_abc",
  "endVisibleMessageID": "msg_xyz"
}
```

### 错误 3: 消息 ID 格式错误

**错误消息**:
```
compression_mark target.startVisibleMessageID and target.endVisibleMessageID must both be non-empty strings (format: msg_...).
```

**解决方法**: 使用正确的消息 ID 格式（`msg_...`）

### 错误 4: delete 模式被禁用

**错误消息**:
```
compression_mark mode="delete" is not allowed in this session. Use mode="compact" instead.
```

**解决方法**: 使用 `"mode": "compact"`

## 工作流程

1. **调用 tool**: 提供消息范围和可选的 hint
2. **立即返回**: 返回 `{"ok": true, "markId": "mark_..."}`
3. **异步压缩**: 压缩在后台进行，不阻塞你的工作
4. **自动应用**: 压缩结果在未来的上下文中自动替换原始范围

## 何时使用压缩

### 推荐场景

- ✅ 长时间的调试会话（保留关键发现）
- ✅ 探索性代码搜索（保留最终结果）
- ✅ 重复的试错过程（保留成功方案）
- ✅ 冗长的对话（提取核心信息）

### 不推荐场景

- ❌ 最近的几条消息（可能还需要引用）
- ❌ 包含未解决问题的讨论（可能需要回顾）
- ❌ 正在进行的工作（等完成后再压缩）

## 返回值

### 成功
```json
{
  "ok": true,
  "markId": "mark_40a328e6fb65"
}
```

### 失败
```json
{
  "ok": false,
  "errorCode": "INVALID_RANGE",
  "message": "详细的错误说明和解决方法"
}
```

## 常见问题

### Q: 压缩后的内容还能被引用吗？
A: 可以。压缩后的内容会保留关键信息，可以在后续对话中引用。

### Q: 压缩需要多长时间？
A: 通常几秒到几十秒，取决于消息数量。压缩是异步的，不会阻塞你的工作。

### Q: 可以撤销压缩吗？
A: 原始消息会被保留在历史记录中，但压缩后的版本会在未来的上下文中使用。

### Q: 一次可以压缩多少消息？
A: 没有硬性限制，但建议每次压缩 10-50 条消息以获得最佳效果。

### Q: compact 和 delete 有什么区别？
A: 
- `compact`: 压缩为摘要，保留关键信息（推荐）
- `delete`: 完全删除（仅用于完全无关的内容）
