# Context Compression System Improvements

## 完成的所有修复和增强

### 1. 范围标记 `[id1~id2]` ✅
- **文件**: `src/identity/visible-sequence.ts`, `src/projection/rendering.ts`
- **功能**: Fragment 显示覆盖的源消息范围
- **示例**: `[msg_abc~msg_xyz] The user and assistant discussed...`

### 2. Protected 消息保护（opaque placeholder）✅
- **文件**: `src/compaction/replay-run-input.ts`
- **功能**: Protected user 消息被包裹在 `<opaque slot="Sx">...</opaque>` 中
- **作用**: 小 user 消息在压缩时被完整保护，LLM 必须用 `<opaque slot="Sx"/>` 替换

### 3. Tool 调用消息压缩 ✅
- **文件**: `src/compaction/replay-run-input.ts`
- **功能**: 包含 tool 调用但 text 为空的 assistant 消息现在会被包含
- **实现**: 如果 `contentText` 为空但有 tool parts，使用 `JSON.stringify(toolParts)`
- **作用**: LLM 可以看到完整的对话流程，根据 `compaction.md` 压缩 tool 调用

### 4. 用户消息格式优化 ✅
- **文件**: `src/compaction/transport/direct-llm.ts`
- **功能**: 
  - 添加 `allowDelete` 参数
  - 添加 opaque slots 列表提醒
  - 添加 hint 支持

### 5. 启用 Thinking 模式 ✅
- **文件**: `src/compaction/transport/direct-llm.ts`
- **功能**: Gemini 添加 `thinkingConfig: {}`
- **作用**: 提升压缩质量，生成 `<analysis>` 块

### 6. Reminder 消息改为 user role ✅
- **文件**: `src/projection/projection-builder.ts`
- **功能**: Reminder 消息从 `system` role 改为 `user` role
- **原因**: 中途插入的 system 消息可能被某些 LLM 忽略

### 7. Prompt 改进 ✅
- **文件**: `prompts/compaction.md`
- **改进**:
  - 更新示例，展示正确的 opaque 用法（protected user 消息）
  - 添加 tool 调用 JSON 压缩指南
  - 添加 hint 处理说明和示例

### 8. Hint 功能 ✅
- **文件**: 
  - `src/tools/compression-mark/contract.ts`
  - `src/tools/compression-mark/tool.ts`
  - `src/history/history-replay-reader.ts`
  - `src/projection/types.ts`
  - `src/projection/policy-engine.ts`
  - `src/compaction/types.ts`
  - `src/compaction/replay-run-input.ts`
  - `src/compaction/transport/request.ts`
  - `src/compaction/transport/types.ts`
  - `src/compaction/transport/direct-llm.ts`
  - `prompts/compaction.md`
- **功能**: AI 可以在调用 `compression_mark` 时提供 hint 字符串
- **示例**:
  ```typescript
  compression_mark({
    contractVersion: "v1",
    mode: "compact",
    target: {
      startVisibleMessageID: "msg_abc",
      endVisibleMessageID: "msg_xyz",
      hint: "Preserve all file paths and error messages from this debugging session"
    }
  })
  ```
- **作用**: Hint 会被传递到压缩 LLM，指导压缩策略

### 9. Tool 可用性改进 ✅
- **文件**: `src/tools/compression-mark/tool.ts`, `src/tools/compression-mark/contract.ts`
- **改进**:
  - **更清晰的描述**: 添加详细的使用说明、示例和最佳实践
  - **参数说明**: 每个参数都有 `.describe()` 说明其用途和格式
  - **完整示例**: 提供 JSON 格式的完整调用示例
  - **使用场景**: 明确说明 compact vs delete 的使用时机
  - **改进的错误消息**: 
    - 显示用户提供的实际值
    - 提供正确格式的示例
    - 解释错误原因和如何修复
  - **工作流说明**: 解释压缩是异步的，不会阻塞工作流

### 10. 工具文档 ✅
- **文件**: `.sisyphus/notepad/trim-json-usage.md`, `.sisyphus/notepad/index.md`
- **内容**: JSON log 读取最佳实践

## 压缩系统现在能够：
- ✅ 保护 protected 消息（小 user 消息）
- ✅ 压缩包含 tool 调用的 assistant 消息
- ✅ 生成高质量压缩结果（thinking 模式 + 详细指南）
- ✅ 显示范围标记 `[id1~id2]`
- ✅ 自动重试失败的压缩
- ✅ 正确处理 tool 调用的 JSON 格式
- ✅ 支持 AI 通过 hint 指导压缩方向
- ✅ Reminder 消息不会被 LLM 忽略

## Hint 使用指南

### 何时使用 hint：
- 调试会话：保留错误信息和文件路径
- 探索性工作：压缩中间步骤，保留最终结果
- 上下文收集：保留所有发现的文件位置
- 实现工作：保留技术细节，压缩对话部分

### Hint 示例：
- `"Preserve all file paths and error messages from this debugging session"`
- `"Focus on the final solution, compress intermediate exploration steps"`
- `"Keep tool parameters and results, summarize conversational parts"`
- `"This is context gathering, retain all discovered file locations"`
