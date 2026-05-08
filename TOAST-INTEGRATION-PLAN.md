# opencode-context-compression Toast 通知集成调研计划

## 1. 概述

本文档规划 opencode-context-compression 插件的 Toast 通知集成方案。

### 1.1 目标

为插件生命周期事件添加用户可见的气泡提示（Toast 通知）：
- 插件启动
- 软提醒（soft reminder）触发
- 硬提醒（hard reminder）触发
- 压缩开始
- 压缩完成（含压缩率）

### 1.2 技术栈

- **Toast API**: `@opencode-ai/plugin` TUI 插件 API
- **类型定义**: `TuiToast` from `@opencode-ai/plugin/tui`
- **调用方式**: `api.ui.toast()` 或 `ctx.client.tui.showToast()`

---

## 2. Toast API 规范

### 2.1 类型定义

```typescript
export type TuiToast = {
  variant?: "info" | "success" | "warning" | "error"
  title?: string
  message: string
  duration?: number  // 毫秒
}
```

### 2.2 调用模式

```typescript
// TUI 插件中
api.ui.toast({
  variant: "info",
  title: "标题",
  message: "消息内容",
  duration: 3000
}).catch(() => {})  // 防止 toast 失败影响插件逻辑

// Server 插件中（需要通过 client）
ctx.client.tui.showToast({
  body: {
    variant: "success",
    title: "操作成功",
    message: "详细信息",
    duration: 4000
  }
}).catch(() => {})
```

---

## 3. 场景设计

### 3.1 插件启动

**触发时机**: 插件初始化完成，sidecar 数据库连接成功

**Toast 配置**:
```typescript
{
  variant: "info",
  title: "Context Compression",
  message: "插件已启动，自动压缩已启用",
  duration: 3000
}
```

**实现位置**: `src/index.ts` 或 `src/runtime/plugin-hooks.ts`

---

## 3.2 软提醒（Soft Reminder）

**触发时机**: 潜在可压缩 token 数超过 `hsoft` 阈值

**Toast 配置**:
```typescript
{
  variant: "info",
  title: "上下文提示",
  message: `当前可压缩内容: ${tokenCount} tokens`,
  duration: 4000
}
```

**实现位置**: `src/projection/reminder-service.ts`

---

## 3.3 硬提醒（Hard Reminder）

**触发时机**: 潜在可压缩 token 数超过 `hhard` 阈值

**Toast 配置**:
```typescript
{
  variant: "warning",
  title: "上下文警告",
  message: `上下文接近限制: ${tokenCount} tokens，建议压缩`,
  duration: 5000
}
```

**实现位置**: `src/projection/reminder-service.ts`

---

## 3.4 压缩开始

**触发时机**: 后台压缩任务启动，lock 文件创建

**Toast 配置**:
```typescript
{
  variant: "info",
  title: "开始压缩",
  message: `正在压缩 ${markCount} 个标记块...`,
  duration: 3000
}
```

**实现位置**: `src/runtime/chat-params-scheduler.ts`

---

## 3.5 压缩完成

**触发时机**: 压缩任务成功，replacement 写入数据库

**Toast 配置**:
```typescript
{
  variant: "success",
  title: "压缩完成",
  message: `压缩率: ${compressionRatio}% (${beforeTokens} → ${afterTokens} tokens)`,
  duration: 5000
}
```

**实现位置**: `src/compaction/runner.ts` 或 scheduler 回调

---

## 4. 实现任务清单

### 4.1 阶段一：基础设施（必需）

- [ ] **任务 1.1**: 在 `PluginInput` 中添加 toast 客户端引用
  - 文件: `src/runtime/plugin-hooks.ts`
  - 从 `input.client` 提取 TUI toast API
  - 创建 toast 辅助函数封装错误处理

- [ ] **任务 1.2**: 定义 Toast 通知服务接口
  - 文件: `src/runtime/toast-service.ts` (新建)
  - 类型定义: `ToastService` 接口
  - 实现: `createToastService(client)` 工厂函数
  - 包含 `.catch(() => {})` 错误处理

- [ ] **任务 1.3**: 添加配置开关
  - 文件: `src/config/runtime-config.ts`
  - 新增字段: `enableToast?: boolean` (默认 `true`)
  - 允许用户通过配置禁用 toast

### 4.2 阶段二：插件启动通知

- [ ] **任务 2.1**: 插件初始化完成通知
  - 文件: `src/index.ts`
  - 时机: `createContextCompressionHooks` 返回前
  - 条件: sidecar 数据库连接成功
  - Toast: info variant, 3s duration

### 4.3 阶段三：Reminder 通知

- [ ] **任务 3.1**: 软提醒 Toast 集成
  - 文件: `src/projection/reminder-service.ts`
  - 时机: `hsoft` 阈值触发时
  - 传递 token 计数到 toast 消息
  - Toast: info variant, 4s duration

- [ ] **任务 3.2**: 硬提醒 Toast 集成
  - 文件: `src/projection/reminder-service.ts`
  - 时机: `hhard` 阈值触发时
  - 传递 token 计数到 toast 消息
  - Toast: warning variant, 5s duration

- [ ] **任务 3.3**: 防止重复通知
  - 实现去重逻辑：同一轮只触发一次 toast
  - 使用 session + turn 标识符追踪已发送通知

### 4.4 阶段四：压缩生命周期通知

- [ ] **任务 4.1**: 压缩开始通知
  - 文件: `src/runtime/chat-params-scheduler.ts`
  - 时机: 后台压缩任务 dispatch 时
  - 传递 mark 数量到消息
  - Toast: info variant, 3s duration

- [ ] **任务 4.2**: 压缩完成通知（含压缩率）
  - 文件: `src/compaction/runner.ts` 或 scheduler 回调
  - 时机: replacement 成功写入数据库后
  - 计算压缩率: `(1 - afterTokens / beforeTokens) * 100`
  - Toast: success variant, 5s duration

- [ ] **任务 4.3**: 压缩失败通知
  - 时机: 所有 compaction 模型尝试失败后
  - Toast: error variant, 6s duration
  - 消息: "压缩失败，请检查日志"

### 4.5 阶段五：Token 计数器类

- [ ] **任务 5.1**: 创建 Token 计数器服务
  - 文件: `src/runtime/token-counter.ts` (新建)
  - 职责: 接收 token 数据，触发硬提醒 toast
  - 接口: `notifyTokenThreshold(tokens: number, threshold: 'soft' | 'hard')`
  - 与 reminder-service 集成

- [ ] **任务 5.2**: 集成到 projection 流程
  - 在 `messages.transform` 中计算 token 数
  - 调用 token 计数器服务
  - 根据阈值触发相应 toast

---

## 5. 技术细节

### 5.1 Toast 服务实现示例

```typescript
// src/runtime/toast-service.ts
import type { OpencodeClient } from "@opencode-ai/sdk";

export interface ToastService {
  info(title: string, message: string, duration?: number): void;
  success(title: string, message: string, duration?: number): void;
  warning(title: string, message: string, duration?: number): void;
  error(title: string, message: string, duration?: number): void;
}

export function createToastService(
  client: OpencodeClient,
  enabled: boolean
): ToastService {
  const show = (
    variant: "info" | "success" | "warning" | "error",
    title: string,
    message: string,
    duration: number = 3000
  ) => {
    if (!enabled) return;
    
    client.tui
      .showToast({
        body: { variant, title, message, duration },
      })
      .catch(() => {});
  };

  return {
    info: (title, message, duration) => show("info", title, message, duration),
    success: (title, message, duration) => show("success", title, message, duration),
    warning: (title, message, duration) => show("warning", title, message, duration),
    error: (title, message, duration) => show("error", title, message, duration),
  };
}
```

### 5.2 压缩率计算

```typescript
// 在 compaction runner 或 scheduler 回调中
const beforeTokens = estimateTokens(sourceMessages);
const afterTokens = estimateTokens(replacementContent);
const compressionRatio = Math.round((1 - afterTokens / beforeTokens) * 100);

toastService.success(
  "压缩完成",
  `压缩率: ${compressionRatio}% (${beforeTokens} → ${afterTokens} tokens)`,
  5000
);
```

### 5.3 去重逻辑

```typescript
// 防止同一轮多次触发 reminder toast
const sentToasts = new Set<string>();

function maybeShowReminderToast(
  sessionId: string,
  turnId: string,
  type: "soft" | "hard",
  tokens: number
) {
  const key = `${sessionId}:${turnId}:${type}`;
  if (sentToasts.has(key)) return;
  
  sentToasts.add(key);
  
  if (type === "soft") {
    toastService.info("上下文提示", `当前可压缩内容: ${tokens} tokens`, 4000);
  } else {
    toastService.warning("上下文警告", `上下文接近限制: ${tokens} tokens，建议压缩`, 5000);
  }
}
```

---

## 6. 配置集成

### 6.1 插件配置位置

**插件不在 opencode.jsonc 中配置**，而是通过以下方式：

1. **运行时配置文件**: `src/config/runtime-config.jsonc`
2. **环境变量**: `OPENCODE_CONTEXT_COMPRESSION_*` 系列

### 6.2 runtime-config.jsonc 配置示例

```jsonc
{
  "$schema": "./runtime-config.schema.json",
  "version": 1,
  "allowDelete": false,
  "enableToast": true,  // 新增：启用 toast 通知
  "promptPath": "prompts/compaction.md",
  "compactionModels": [
    "google.right/gemini-3-flash-preview",
    "google.doro/gemini-3-flash-preview"
  ],
  "schedulerMarkThreshold": 1,
  "runtimeLogPath": "logs/runtime-events.jsonl",
  "seamLogPath": "logs/seam-observation.jsonl",
  "markedTokenAutoCompactionThreshold": 60000,
  "smallUserMessageThreshold": 1536,
  "reminder": {
    "hsoft": 60000,
    "hhard": 200000,
    "softRepeatEveryTokens": 30000,
    "hardRepeatEveryTokens": 10000,
    "promptPaths": {
      "compactOnly": {
        "soft": "prompts/reminder-soft-compact-only.md",
        "hard": "prompts/reminder-hard-compact-only.md"
      },
      "deleteAllowed": {
        "soft": "prompts/reminder-soft-delete-allowed.md",
        "hard": "prompts/reminder-hard-delete-allowed.md"
      }
    }
  },
  "logging": {
    "level": "off"
  },
  "compressing": {
    "timeoutSeconds": 600
  }
}
```

### 6.3 环境变量配置

```bash
# 启用/禁用 toast 通知
export OPENCODE_CONTEXT_COMPRESSION_ENABLE_TOAST=true

# 其他现有环境变量
export OPENCODE_CONTEXT_COMPRESSION_RUNTIME_CONFIG_PATH="./src/config/runtime-config.jsonc"
export OPENCODE_CONTEXT_COMPRESSION_LOG_LEVEL="info"
```

### 6.4 运行时配置加载修改

```typescript
// src/config/runtime-config.ts

// 1. 添加环境变量常量
export const RUNTIME_CONFIG_ENV = {
  configPath: "OPENCODE_CONTEXT_COMPRESSION_RUNTIME_CONFIG_PATH",
  promptPath: "OPENCODE_CONTEXT_COMPRESSION_PROMPT_PATH",
  models: "OPENCODE_CONTEXT_COMPRESSION_MODELS",
  runtimeLogPath: "OPENCODE_CONTEXT_COMPRESSION_RUNTIME_LOG_PATH",
  seamLogPath: "OPENCODE_CONTEXT_COMPRESSION_SEAM_LOG",
  logLevel: "OPENCODE_CONTEXT_COMPRESSION_LOG_LEVEL",
  compressingTimeoutSeconds: "OPENCODE_CONTEXT_COMPRESSION_COMPRESSING_TIMEOUT_SECONDS",
  debugSnapshotPath: "OPENCODE_CONTEXT_COMPRESSION_DEBUG_SNAPSHOT_PATH",
  enableToast: "OPENCODE_CONTEXT_COMPRESSION_ENABLE_TOAST",  // 新增
} as const;

// 2. 添加到 RuntimeConfigInput 接口
interface RuntimeConfigInput {
  readonly $schema?: unknown;
  readonly version?: unknown;
  readonly allowDelete?: unknown;
  readonly enableToast?: unknown;  // 新增
  readonly promptPath?: unknown;
  // ... 其他字段
}

// 3. 添加到 ResolvedRuntimeConfig 接口
export interface ResolvedRuntimeConfig {
  readonly allowDelete: boolean;
  readonly enableToast: boolean;  // 新增
  readonly promptPath: string;
  // ... 其他字段
}

// 4. 在 loadRuntimeConfig 中解析
export async function loadRuntimeConfig(): Promise<ResolvedRuntimeConfig> {
  // ... 现有逻辑
  
  const enableToast = readOptionalEnv(process.env, RUNTIME_CONFIG_ENV.enableToast);
  const enableToastValue = enableToast !== undefined 
    ? enableToast === "true" 
    : (input.enableToast === true);  // 默认从配置文件读取，环境变量优先
  
  return {
    allowDelete: /* ... */,
    enableToast: enableToastValue,
    // ... 其他字段
  };
}
```

---

## 7. 测试计划

### 7.1 单元测试

- [ ] Toast 服务创建和调用
- [ ] 配置开关生效验证
- [ ] 去重逻辑验证

### 7.2 集成测试

- [ ] 插件启动时显示 toast
- [ ] 软/硬提醒触发 toast
- [ ] 压缩开始/完成/失败显示 toast
- [ ] 压缩率计算正确性

### 7.3 手动测试场景

1. 启动 OpenCode，加载插件，验证启动 toast
2. 触发软提醒阈值，验证 info toast
3. 触发硬提醒阈值，验证 warning toast
4. 标记内容并触发压缩，验证开始 toast
5. 压缩完成后，验证成功 toast 和压缩率显示
6. 模拟压缩失败，验证错误 toast

---

## 8. 风险与注意事项

### 8.1 Server 插件限制

**问题**: opencode-context-compression 是 server 插件，不是 TUI 插件。

**解决方案**:
- Server 插件通过 `input.client.tui.showToast()` 调用 TUI API
- 需要确认 `input.client` 是否包含 `tui` 对象
- 如果不可用，toast 功能应优雅降级（静默失败）

### 8.2 Toast 频率控制

**问题**: 高频触发可能导致 toast 堆叠，影响用户体验。

**解决方案**:
- 实现去重逻辑（session + turn 级别）
- Reminder toast 每轮最多触发一次
- 压缩 toast 与实际压缩任务一对一

### 8.3 异步时序

**问题**: 压缩是后台异步任务，toast 时机需要精确控制。

**解决方案**:
- 压缩开始 toast：在 scheduler dispatch 时立即触发
- 压缩完成 toast：在 replacement 写入数据库后触发
- 使用回调或 Promise 链确保时序正确

### 8.4 Token 计数准确性

**问题**: Token 估算可能不准确，影响压缩率显示。

**解决方案**:
- 使用现有 `token-estimation.ts` 模块
- 压缩率仅作参考，不影响核心功能
- 在 toast 消息中标注"约"或"估算"

---

## 9. 里程碑

### M1: 基础设施（1-2 天）
- Toast 服务实现
- 配置集成
- 插件启动通知

### M2: Reminder 通知（1 天）
- 软/硬提醒 toast
- 去重逻辑

### M3: 压缩生命周期（2-3 天）
- 压缩开始/完成/失败 toast
- 压缩率计算
- Token 计数器类

### M4: 测试与优化（1-2 天）
- 单元测试
- 集成测试
- 手动测试
- 文档更新

**总计**: 5-8 天

---

## 10. 参考资料

- **Toast API 定义**: `/root/_/opencode/opencode-context-compression/node_modules/@opencode-ai/plugin/dist/tui.d.ts:151-156`
- **实际使用示例**: `/root/_/refs/opencode-upstream/packages/opencode/src/cli/cmd/tui/feature-plugins/system/plugins.tsx`
- **插件 API 封装**: `/root/_/refs/opencode-upstream/packages/opencode/src/cli/cmd/tui/plugin/api.tsx:304-311`
- **错误处理模式**: `/root/_/refs/oh-my-openagent/src/plugin/ultrawork-model-override.ts:26-32`
