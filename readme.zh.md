# opencode-context-compression

这是一个独立的 OpenCode 插件工作区，采用“规范历史加 SQLite 侧车”的上下文压缩设计。

该插件把 OpenCode 宿主历史视为规范信任源，把插件拥有的状态写入每个会话独立的 SQLite 侧车数据库，通过 `experimental.chat.messages.transform` 投射提示词可见替换内容，并使用文件锁作为操作员可见的实时压缩门控。它唯一公开的压缩工具是 `compression_mark`。

## 显式加载插件

请在 `opencode.json` 或 `opencode.jsonc` 中使用显式的插件条目。在这个工作区里，显式配置加载是受支持的激活路径。

```jsonc
{
  "plugin": [
    "/root/_/opencode/opencode-context-compression/src/index.ts"
  ]
}
```

操作员说明：

- 以上绝对路径就是这份本地检出的信任源。
- 修改插件列表后必须重启 OpenCode。
- 不要依赖目录自动加载。

## 仓库自有的运行时配置、提示词与日志契约

规范运行时契约由本仓库直接维护：

- `src/config/runtime-config.jsonc`，规范运行时配置文件
- `src/config/runtime-config.schema.json`，用于编辑器校验与 `$schema` 关联的本地 JSON Schema
- `prompts/compaction.md`，显式压缩提示词资源
- `prompts/reminder-soft.md`，软提醒模板资源
- `prompts/reminder-hard.md`，硬提醒模板资源
- `logs/runtime-events.jsonl`，仓库自有运行时日志路径契约
- `logs/seam-observation.jsonl`，仓库自有 seam 与调试日志路径

提示词加载是显式的。插件会加载配置里声明的提示词文件。如果配置文件或提示词资源缺失、为空或格式错误，插件会立即失败。不存在内建提示词回退，也不存在旧运行时配置回退。

### 已恢复的运行时配置面

仓库自有的 `runtime-config.jsonc` 现在重新承载此前明确保留的用户侧契约，而不再只是 cutover 阶段的最小运行字段。

这份规范配置现在支持注释，并通过指向 `src/config/runtime-config.schema.json` 的本地 `$schema` 为编辑器提供结构校验。

- `markedTokenAutoCompactionThreshold`：保留的外部压缩就绪阈值契约
- `smallUserMessageThreshold`：用于在 projection 中保护短用户消息的保留阈值契约
- `reminder.hsoft` 与 `reminder.hhard`：显式软/硬提醒 token 阈值（仓库默认值：`30000` / `70000`）
- `reminder.counter.*`：现在会实际影响 deterministic reminder 调度的 cadence 概念
- `reminder.promptPaths.soft` 与 `reminder.promptPaths.hard`：仓库自有的提醒模板路径
- `logging.level`：显式日志控制字段
- `compressing.timeoutSeconds`：显式压缩与锁超时字段
- `schedulerMarkThreshold`：仅用于当前 mark 数量调度的内部/测试兼容字段

重要区分：`schedulerMarkThreshold` 不等价于 `markedTokenAutoCompactionThreshold`。`schedulerMarkThreshold` 仍是内部兼容门槛，而运行时调度现在还会基于 `markedTokenAutoCompactionThreshold` 执行真实的 marked-token 就绪判断。

当前仓库内的执行边界：

- `counter.*` —— 已由 deterministic reminder derivation 实际执行
- `smallUserMessageThreshold` —— 已由 projection visibility policy 对短用户消息实际执行
- `markedTokenAutoCompactionThreshold` —— 已由 scheduler 的 marked-token readiness 实际执行
- `logging.level` —— 已由写入 `runtimeLogPath` 的运行时事件 JSONL sink 实际执行

本仓库的 token 估算策略：

1. 阈值判断统一使用仓库自有的本地 `tiktoken` 路径估算
2. 如果 tokenizer 解析或编码失败，阈值判断现在会以插件自有错误直接失败

本仓库的阈值判断不会优先采用上游消息自带的 `tokenCount` 或 `metadata.*tokenCount`；reminder 与 marked-token readiness 都使用同一把本地 tokenizer 标尺，而且 tokenizer 失败不会再被静默降级成启发式猜测。

本仓库的运行时日志行为：

- `off` —— 不向 `runtimeLogPath` 持久化普通运行时事件
- `error` —— 只持久化失败 / stale 的 runtime gate 事件
- `info` 与 `debug` —— 将普通 runtime gate 事件以 JSONL 写入 `runtimeLogPath`

### Reminder 模板占位符

软/硬提醒文本现在来自仓库自有 prompt 文件，而不是 `reminder-service.ts` 里的硬编码字符串。这两份模板都必须包含以下占位符：

- `{{compressible_content}}` —— 当前可压缩投影视图内容快照
- `{{compaction_target}}` —— 当前推导出的压缩目标跨度摘要
- `{{preserved_fields}}` —— 受保护或需要保留的上下文摘要

任一 reminder 模板缺少这些占位符时，运行时配置加载会立即失败。

### 环境变量覆盖名与优先级

优先级是确定的：

1. `OPENCODE_CONTEXT_COMPRESSION_RUNTIME_CONFIG_PATH` 选择替代配置文件。
2. 字段级环境变量覆盖该配置文件中的对应值：
   - `OPENCODE_CONTEXT_COMPRESSION_PROMPT_PATH`
   - `OPENCODE_CONTEXT_COMPRESSION_MODELS`，按顺序排列的逗号分隔模型数组
   - `OPENCODE_CONTEXT_COMPRESSION_ROUTE`，只能是 `keep` 或 `delete`
   - `OPENCODE_CONTEXT_COMPRESSION_RUNTIME_LOG_PATH`
   - `OPENCODE_CONTEXT_COMPRESSION_SEAM_LOG`
   - `OPENCODE_CONTEXT_COMPRESSION_LOG_LEVEL`，只能是 `off`、`error`、`info` 或 `debug`
   - `OPENCODE_CONTEXT_COMPRESSION_COMPRESSING_TIMEOUT_SECONDS`，正整数秒数
   - `OPENCODE_CONTEXT_COMPRESSION_DEBUG_SNAPSHOT_PATH`

未设置的环境变量表示“不覆盖”。空字符串或只含空白的环境变量值会在插件启动时被拒绝，避免被静默当成未设置处理。

## 公共工具契约

唯一公开的压缩工具是 `compression_mark`。

- `contractVersion` 固定为 `v1`
- `route` 只能是 `keep` 或 `delete`
- `target.startVisibleMessageID` 与 `target.endVisibleMessageID` 来自当前投射后的可见消息视图
- 该工具会先在仓库自有的投射视图里解析目标跨度，然后把 mark 持久化进侧车数据库

`compression_mark` 不会暴露公共执行步骤。批次冻结、调度、runner 调用与锁处理都属于插件内部运行时行为，而不是公共执行工具。

## 作为唯一压缩系统运行

这个插件应该是一个会话里唯一活跃的提示词压缩系统。请禁用任何其他会重写转录消息、注入替换块、自动总结或自行执行上下文裁剪策略的 transform 或 compaction 插件。

同一 profile 下，也要关闭 OpenCode 原生自动总结与 prune：

```jsonc
{
  "plugin": [
    "/root/_/opencode/opencode-context-compression/src/index.ts"
  ],
  "compaction": {
    "auto": false,
    "prune": false
  }
}
```

原因很直接：插件假设它是唯一负责决定何时替换、隐藏或移除提示词可见源跨度的组件。多个压缩系统同时运行会让替换匹配、锁恢复与侧车状态解释都失去可信度。

## 一页纸运行时模型

该插件围绕四条操作员可见规则组织：

1. **规范历史仍由上游拥有**
   - 插件不会覆盖宿主历史
   - 每次 transform 运行都会先把最新宿主消息重新同步到侧车，再投射替换内容
2. **SQLite 是侧车状态，不是第二份转录**
   - 每个会话都会生成 `state/<session-id>.db`
   - marks、source snapshots、replacements、compaction batches、jobs 与 runtime gate 观测都存放在这里
3. **文件锁就是实时压缩门控**
   - 活跃批次会写入 `locks/<session-id>.lock`
   - 普通聊天会等待这个锁
   - 不相关工具继续运行，`compression_mark` 只会进入下一批，不会混入已冻结批次
4. **投射是确定性的**
   - 已提交 replacement 会通过 `experimental.chat.messages.transform` 从侧车状态渲染
   - 对同一份规范历史重复投射，会得到相同可见结果

## `route=keep` 与 `route=delete`

两条路由都走同一条“mark 到 source snapshot 到 replacement 到 projection”流水线。`route=delete` 不是独立的删除子系统。

### `route=keep`

- 已提交 replacement 会作为幸存的可引用块保留在提示词可见视图里
- 原始源跨度只会在投射视图中被隐藏
- replacement 不再参与下一轮压缩

### `route=delete`

- 压缩仍会在 SQLite 中创建已提交 replacement 记录
- 投射会把该结果渲染成极简 delete notice，而不是可复用总结块
- 一旦 delete replacement 提交，原始源跨度会从提示词可见投射中移除
- delete 结果仍通过与 `route=keep` 相同的 replacement 表、source snapshot 与 consumed-mark 链接追踪
- delete 输出被视为终结性清理结果，不会再次参与压缩

简而言之，`keep` 留下压缩后的幸存者，`delete` 只留下极简可引用通知。

## 锁行为与手动恢复

实时压缩门控就是会话锁文件：

- 路径：`locks/<session-id>.lock`
- 创建时机：冻结批次真正开始时
- 清除时机：批次进入终态且所有尝试结束后
- 过期处理：超出配置超时窗口后，陈旧锁会被自动忽略

活跃锁期间：

- 普通聊天会等待，直到批次成功、失败、超时或被手动清除
- 非压缩工具继续运行
- `compression_mark` 仍可登记未来 mark，但不会加入已冻结批次

### 手动锁恢复

如果某个会话因为操作员可见的锁文件意外残留而卡住，只移除该会话的锁文件：

```bash
rm "/root/_/opencode/opencode-context-compression/locks/<session-id>.lock"
```

只有在你确认该会话已经不再活跃压缩时才这样做。下一次请求会把缺失锁视为手动恢复，并在可用时从已持久化的批次状态里解析最终结果。

## 侧车布局

默认情况下，本仓库会把状态写到插件目录相对路径：

- `state/<session-id>.db`，SQLite 侧车数据库
- `locks/<session-id>.lock`，实时压缩锁文件
- `logs/runtime-events.jsonl`，仓库自有运行时日志路径契约
- `logs/seam-observation.jsonl`，启用 seam 日志时的观测日志

调试快照默认关闭。设置 `OPENCODE_CONTEXT_COMPRESSION_DEBUG_SNAPSHOT_PATH` 后即可启用，相对路径从本仓库根目录解析。

侧车数据库是操作员检查 accepted marks、committed replacements、batch 与 job 状态、runtime gate 审计记录的主要入口。

## 验证真相边界

本仓库已经有针对 repo-owned 契约的自动化证明，但证明边界必须说清楚。

当前已经纳入证明范围的自动化检查：

- `tests/cutover/runtime-config-precedence.test.ts`，验证仓库自有配置、提示词、日志与环境变量优先级
- `tests/cutover/legacy-independence.test.ts`，验证规范执行不依赖旧 runtime、旧工具或旧 provider ownership
- `tests/cutover/docs-and-notepad-contract.test.ts`，审计操作员文档与 durable memory 契约
- `tests/e2e/plugin-loading-and-compaction.test.ts`，用注入的 safe transport fixture 验证仓库自有插件加载、mark 流程、scheduler seam 与 committed replacement 路径
- `tests/e2e/delete-route.test.ts`，用同样的 repo-owned fixture 风格验证 `route=delete`

这份 README 明确不声称以下两件事：

- 当前宿主暴露的 legacy 工具已经能在真实会话里为本插件提供有效的 keep 与 delete 端到端证明
- 本仓库已经自带默认生产 compaction executor transport

关于当前可做的人工观察，请看 `docs/live-verification-with-mitmproxy-and-debug-log.zh.md`。那份文档保留同样的真相边界：真实会话可以确认插件加载、seam 日志、sidecar 创建等运行时副作用，但完整 keep 与 delete 证明目前仍以本仓库自动化测试为准。

## Seam probe

仓库提供了一个 seam 调试探针：

```bash
npm run probe:seams
```

它会：

- 在 `.tmp/opencode-config/` 下创建临时 `OPENCODE_CONFIG_DIR`
- 为本仓库 `src/index.ts` 写入显式插件条目
- 运行一个最小化 `opencode run`
- 把 hook 观测结果写到 `logs/seam-observation.jsonl`

需要原始 hook 形状证据时，用 seam probe。需要可重复的 repo-owned 契约证明时，用 cutover 测试和 e2e 套件。

## 验证命令

在 `/root/_/opencode/opencode-context-compression` 下运行：

```bash
npm run typecheck
node --import tsx --test tests/cutover/runtime-config-precedence.test.ts
node --import tsx --test tests/cutover/legacy-independence.test.ts
node --import tsx --test tests/cutover/docs-and-notepad-contract.test.ts
node --import tsx --test tests/e2e/plugin-loading-and-compaction.test.ts
node --import tsx --test tests/e2e/delete-route.test.ts
```
