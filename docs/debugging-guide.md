# 调试必读指导

> **强制要求**：所有 AI 在调试本插件时必须阅读并遵循本指导。

---

## 核心原则

1. **永远不要直接读取完整的 debug snapshot 文件** - 这些文件包含大量长字符串（工具输出、代码片段等），会浪费大量 token 且难以分析
2. **必须使用 trim-json 工具** - 在分析任何 debug snapshot 之前，先用工具裁剪长字符串
3. **理解数据流** - debug snapshot 只是某一时刻的快照，要理解完整行为需要结合代码逻辑

---

## 必备工具：trim-json

### 用途

裁剪 JSON 文件中的长字符串字段，保留结构和关键信息，移除冗余内容。

### 使用方法

```bash
# 基本用法（默认裁剪到 150 字符）
npm run trim-json logs/debug-snapshots/ses_xxx.in.json

# 指定裁剪长度
npm run trim-json logs/debug-snapshots/ses_xxx.out.json 200

# 保存到文件
npm run trim-json logs/debug-snapshots/ses_xxx.out.json 200 > /tmp/trimmed.json

# 只看统计信息
npm run trim-json logs/debug-snapshots/ses_xxx.out.json 200 2>&1 | tail -10
```

### 输出说明

- **stdout**：裁剪后的 JSON（可重定向到文件）
- **stderr**：统计信息（总字符串数、裁剪数、移除字符数、裁剪率）

### 何时使用

- ✅ 分析 debug snapshot 文件（`.in.json` / `.out.json`）
- ✅ 检查消息结构和 visible ID
- ✅ 调试 projection 输出
- ✅ 分析 reminder 触发情况
- ✅ 检查 token 计数

### 何时不使用

- ❌ 读取配置文件（`runtime-config.jsonc`）
- ❌ 读取小型测试 fixture
- ❌ 需要完整字符串内容时（如验证具体文本）

---

## Debug Snapshot 文件说明

### 文件位置

```
logs/debug-snapshots/
├── ses_xxx.in.json   # messages.transform 输入（OpenCode host 提供的原始消息）
└── ses_xxx.out.json  # messages.transform 输出（插件修改后的消息）
```

### 生成条件

仅当配置启用时生成：

```jsonc
// runtime-config.jsonc
{
  "debugSnapshot": {
    "enabled": true,
    "outputDir": "logs/debug-snapshots"
  }
}
```

或通过环境变量：

```bash
OPENCODE_CONTEXT_COMPRESSION_DEBUG_SNAPSHOT=1
```

### 文件结构

```json
{
  "messages": [
    {
      "info": {
        "id": "msg_xxx",
        "sessionID": "ses_xxx",
        "role": "user|assistant|system",
        "model": {
          "providerID": "opencode-context-compression",
          "modelID": "projection-replay"
        }
      },
      "parts": [
        {
          "type": "text|tool_use|tool_result|step-start|step-finish",
          "text": "...",
          "id": "msg_xxx:text:0"
        }
      ]
    }
  ]
}
```

### 关键字段

- **info.id**：消息的 canonical ID
- **info.role**：消息角色（user/assistant/system）
- **info.model.providerID**：
  - `opencode-context-compression` = 插件生成的消息（projection-replay）
  - 其他值 = OpenCode host 原始消息
- **parts[].type**：
  - `text` = 文本内容
  - `tool_use` = 工具调用
  - `tool_result` = 工具返回
  - `step-start` / `step-finish` = 执行步骤边界
- **parts[].text**：消息文本，应包含 visible ID 前缀（如 `[compressible_000001_Ke]`）

---

## 调试工作流

### 1. 问题定位

**症状**：某个功能不工作（如 reminder 未触发、visible ID 丢失、压缩未生效）

**步骤**：

1. 找到相关的 session ID（从日志或用户报告）
2. 检查是否有对应的 debug snapshot 文件
3. 使用 trim-json 裁剪文件：
   ```bash
   npm run trim-json logs/debug-snapshots/ses_xxx.out.json 200 > /tmp/out.json
   ```
4. 检查关键字段：
   - 消息数量是否正确
   - Visible ID 是否存在
   - Role 是否正确
   - 是否有 reminder 消息（role=system）

### 2. 对比输入输出

**目的**：理解插件做了什么转换

**步骤**：

```bash
# 裁剪输入
npm run trim-json logs/debug-snapshots/ses_xxx.in.json 200 > /tmp/in.json

# 裁剪输出
npm run trim-json logs/debug-snapshots/ses_xxx.out.json 200 > /tmp/out.json

# 对比（使用你喜欢的 diff 工具）
diff /tmp/in.json /tmp/out.json
```

**关注点**：

- 消息数量变化（压缩/删除）
- Role 变化（不应该改变 canonical 消息的 role）
- Visible ID 添加/修改
- 新增的 reminder 消息

### 3. 检查 Reminder 触发

**症状**：应该触发 reminder 但没有触发

**检查清单**：

1. **配置阈值**：
   ```bash
   cat runtime-config.jsonc | grep -A 5 reminder
   ```
   确认 `hsoft` 和 `hhard` 值

2. **Token 计数**：
   在裁剪后的 `.out.json` 中搜索 `compressible_` 前缀的消息，估算可压缩 token 数

3. **Reminder 消息**：
   搜索 `role: "system"` 的消息，检查是否存在 reminder

4. **Runtime events**：
   ```bash
   cat logs/runtime-events.jsonl | grep reminder
   ```

### 4. 检查 Visible ID

**症状**：消息缺少 visible ID 或 ID 格式错误

**检查清单**：

1. **所有消息都应该有 visible ID**：
   ```bash
   npm run trim-json logs/debug-snapshots/ses_xxx.out.json 200 | grep -o '\[.*_[0-9]\{6\}_.*\]'
   ```

2. **ID 格式**：
   - Protected: `[protected_NNNNNN_XX]`
   - Compressible: `[compressible_NNNNNN_XX]`
   - Referable: `[referable_NNNNNN_XX]`

3. **Assistant 消息特殊情况**：
   如果 assistant 消息只有 tool parts（没有 text part），插件会合成一个 text part 承载 visible ID

### 5. 检查压缩结果

**症状**：压缩未生效或结果不正确

**检查清单**：

1. **数据库状态**：
   ```bash
   sqlite3 state/ses_xxx.db "SELECT mark_id, mode, status FROM result_groups;"
   ```

2. **Lock 文件**：
   ```bash
   ls -la state/ses_xxx.lock
   ```
   如果存在，说明压缩正在进行或卡住了

3. **Runtime events**：
   ```bash
   cat logs/runtime-events.jsonl | grep -E 'compaction|scheduler'
   ```

---

## 常见问题

### Q: Debug snapshot 文件太大，无法读取

**A**: 永远不要直接读取。使用 `npm run trim-json` 裁剪后再分析。

### Q: 如何知道某条消息是插件生成的还是 host 原始的？

**A**: 检查 `info.model.providerID`：
- `opencode-context-compression` = 插件生成（projection-replay）
- 其他值 = host 原始消息

### Q: 为什么输入消息的 role 和输出不一致？

**A**: 这通常是 bug。Canonical 消息的 role 应该保持不变。检查 `src/runtime/messages-transform.ts` 中的 `projectProjectionToEnvelopes` 函数。

### Q: 如何验证 reminder 应该触发？

**A**: 
1. 计算所有 `compressible_` 消息的 token 总数（粗略估算：字符数 / 4）
2. 对比 `runtime-config.jsonc` 中的 `hsoft` 阈值
3. 检查是否已经有 reminder 消息（避免重复触发）

### Q: "Tool output unavailable (context compacted)" 是什么？

**A**: 这是 OpenCode host 生成的占位符，不是本插件生成的。当 host 检测到某个 tool result 被压缩/删除时，会自动生成这个占位符。

---

## 禁止事项

❌ **禁止直接读取完整 debug snapshot 文件** - 浪费 token，难以分析

❌ **禁止在没有裁剪的情况下分析长字符串** - 无法看到结构

❌ **禁止假设文件内容** - 必须实际读取（裁剪后）

❌ **禁止忽略统计信息** - 裁剪率可以帮助判断文件复杂度

---

## 最佳实践

✅ **总是先裁剪，再分析**

✅ **使用合适的裁剪长度**：
- 快速浏览结构：100-150
- 详细分析：200-300
- 需要更多上下文：500+

✅ **结合多个数据源**：
- Debug snapshot（快照）
- Runtime events（事件流）
- 数据库状态（持久化）
- 代码逻辑（真相源）

✅ **保存裁剪结果**：
```bash
npm run trim-json logs/debug-snapshots/ses_xxx.out.json 200 > /tmp/analysis.json
```
然后在后续分析中引用 `/tmp/analysis.json`

✅ **记录发现**：
在分析过程中，记录关键发现和假设，便于后续验证

---

## 工具实现细节

### 裁剪逻辑

- 递归遍历 JSON 结构
- 只裁剪字符串类型的值
- 保留数组和对象结构
- 裁剪后添加 `... [truncated]` 后缀

### 统计信息

- **Total strings**: 遍历到的字符串总数
- **Truncated strings**: 被裁剪的字符串数
- **Total chars removed**: 移除的字符总数
- **Truncation rate**: 裁剪率（百分比）

### 性能

- 单次遍历，O(n) 时间复杂度
- 内存占用：原始文件大小 + 裁剪后大小
- 适用于 100MB 以下的文件

---

## 总结

**记住**：调试本插件时，`trim-json` 是你的第一工具。永远不要直接读取完整的 debug snapshot 文件。

**工作流**：
1. 使用 `trim-json` 裁剪文件
2. 分析裁剪后的结构
3. 结合代码逻辑理解行为
4. 验证假设
5. 修复问题
