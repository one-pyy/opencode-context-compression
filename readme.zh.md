# opencode-context-compression

这是一个独立的 OpenCode 插件工作区，采用了“规范历史（canonical-history）+ SQLite 侧车（sidecar）”的上下文压缩设计方案。

该插件将 OpenCode 宿主历史记录视为规范的信任源，并将插件拥有的状态存储在每个会话独立的 SQLite 侧车数据库中。它通过 `experimental.chat.messages.transform` 投射出提示词可见的替换内容，并使用文件锁作为操作员可见的实时压缩门控。

## 显式加载插件

请在 `opencode.json` 或 `opencode.jsonc` 中使用显式的插件条目。在此工作区中，显式配置加载是唯一支持的激活路径。

```jsonc
{
  "plugin": [
    "/root/_/opencode/opencode-context-compression/src/index.ts"
  ]
}
```

> **操作员重要笔记**
> 
> - 请使用上述绝对路径作为此本地检出代码的信任源。
> - 修改插件列表后，必须重启 OpenCode。
> - 请勿依赖此仓库的目录自动加载功能。

## 仓库自有的运行时配置、提示词与日志契约

插件的规范运行时契约现在随本仓库一起维护：

- `src/config/runtime-config.json` —— 规范的运行时配置文件
- `prompts/compaction.md` —— 显式的压缩提示词资源
- `logs/runtime-events.jsonl` —— 仓库自有的运行时日志路径契约
- `logs/seam-observation.jsonl` —— 仓库自有的 seam / 调试日志路径

提示词加载是显式的。插件会加载配置里声明的提示词文件；如果配置文件或提示词资源缺失、为空或格式错误，插件会立即失败。不存在内建提示词回退，也不存在旧运行时配置的回退路径。

### 环境变量覆盖名与优先级

优先级是确定性的：

1. `OPENCODE_CONTEXT_COMPRESSION_RUNTIME_CONFIG_PATH` 用于选择替代的配置文件。
2. 之后，字段级环境变量会覆盖该配置文件中的对应值：
   - `OPENCODE_CONTEXT_COMPRESSION_PROMPT_PATH`
   - `OPENCODE_CONTEXT_COMPRESSION_MODELS`（按顺序的逗号分隔模型数组）
   - `OPENCODE_CONTEXT_COMPRESSION_ROUTE`（只能是 `keep` 或 `delete`）
   - `OPENCODE_CONTEXT_COMPRESSION_RUNTIME_LOG_PATH`
   - `OPENCODE_CONTEXT_COMPRESSION_SEAM_LOG`
   - `OPENCODE_CONTEXT_COMPRESSION_DEBUG_SNAPSHOT_PATH`

未设置的环境变量表示“不覆盖”。仅包含空白的环境变量值会在插件启动时被拒绝，避免它们被静默地当成未设置处理。

## 首先禁用竞争的压缩路径

此插件设计为会话中唯一活跃的提示词压缩系统。请勿将其与其他转录重写或自动压缩路径同时运行。

在启用此插件之前，请务必禁用或移除以下所有内容：

- **opencode-dcp-fork**
  - 从你的 OpenCode 配置中移除其插件条目。
  - 不要让本插件继续依赖 fork 拥有的运行时配置或提示词资源。
- **@tarquinen/opencode-dcp**
  - 在相同的会话/配置文件中，将其从 OpenCode 的 `plugin` 列表中移除。
- **任何其他转换/压缩插件**
  - 如果某个插件会重写转录消息、注入替换块、自动总结或执行其自身的上下文修剪策略，请针对该配置文件禁用它。
- **原生 OpenCode 自动总结/压缩**
  - 将 `compaction.auto` 设置为 `false`。
  - 将 `compaction.prune` 设置为 `false`。

最小化配置示例：

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

> **为什么这很重要？**
> 
> 插件假设它是唯一决定何时替换、隐藏或从提示词可见投射中删除源跨度（source spans）的组件。同时运行多个压缩系统会导致替换匹配、锁定恢复以及侧车状态解释变得不可靠。

## 一页纸运行时模型

该插件围绕四个操作员可见的规则进行组织：

- **规范历史由上游拥有**
  - 插件不会覆盖宿主历史记录。
  - 每次转换运行都会在投射替换内容之前，将活跃的宿主消息重新同步到侧车中。
- **SQLite 是侧车状态，而非第二份转录**
  - 每个会话都会在 `state/<session-id>.db` 下获得一个数据库。
  - 标记（marks）、源快照、替换内容、压缩批次、作业以及运行时门控观测结果都存储在这里。
- **文件锁是实时压缩门控**
  - 活跃的批次会写入 `locks/<session-id>.lock`。
  - 普通聊天会等待该锁释放。
  - 不相关的工具会继续运行，且 `compression_mark` 会保持在已冻结批次之外。
- **投射是确定性的**
  - 已提交的替换内容通过 `experimental.chat.messages.transform` 从侧车状态渲染。
  - 在相同的规范历史记录上重新运行投射，会产生相同的可见输出。

## route=keep 与 route=delete

这两条路由使用相同的“标记 -> 源快照 -> 替换 -> 投射”流水线。`route=delete` 并不是一个独立的删除子系统。

### route=keep

- 已提交的替换内容作为幸存的可引用块，在提示词中保持可见。
- 原始源跨度仅在投射视图中被隐藏。
- 该替换内容不具备再次进行压缩传递的资格。

### route=delete

- 压缩仍会在 SQLite 中创建一条已提交的替换记录。
- 投射会将该提交结果渲染为一个极简的删除通知，而不是一个可重用的总结块。
- 一旦删除替换被提交，原始源跨度就会从提示词可见的投射中移除。
- 删除结果仍通过与 `route=keep` 相同的替换表、源快照和消耗标记链接进行追踪。
- 删除输出被视为终结性的清理结果，不会作为另一次压缩传递的候选对象。

> **简而言之**
> 
> `keep` 会留下一个压缩后的幸存者，而 `delete` 仅留下一个极简的可引用通知。

## 锁定行为与手动恢复

实时压缩门控是会话锁定文件：

- **路径：** `locks/<session-id>.lock`
- **创建时机：** 当一个冻结的压缩批次实际开始时创建。
- **清除时机：** 在批次达到终结结果且所有尝试均已完成后清除。
- **过期处理：** 超过配置的超时窗口后，陈旧的锁会被自动忽略。

在实时锁定期间会发生什么：

- 普通聊天会一直等待，直到批次成功、失败、超时或被手动清除。
- 非压缩工具继续运行。
- `compression_mark` 仍可能注册未来的标记，但这些标记不会加入已经冻结的批次。

### 手动锁定恢复

如果由于操作员可见的锁定文件意外遗留导致会话卡住，请仅移除受影响的会话锁定文件：

```bash
rm "/root/_/opencode/opencode-context-compression/locks/<session-id>.lock"
```

> **警告**
> 
> 仅当你确认某个会话不再处于活跃压缩状态时，才使用手动锁移除。下一次请求会将缺失的实时锁视为手动恢复，并尝试从持久化的批次状态（如果可用）中解析最终结果。

## 侧车布局

默认情况下，此仓库相对于插件目录写入状态：

- `state/<session-id>.db` —— SQLite 侧车数据库。
- `locks/<session-id>.lock` —— 实时压缩锁定文件。
- `logs/runtime-events.jsonl` —— 仓库自有的运行时日志路径契约。
- `logs/seam-observation.jsonl` —— 启用接缝日志时的接缝调试日志。

调试快照默认关闭。设置 `OPENCODE_CONTEXT_COMPRESSION_DEBUG_SNAPSHOT_PATH` 后即可启用；相对路径会从本仓库根目录解析。

侧车数据库是操作员检查已接受标记、已提交替换、批次/作业状态以及运行时门控审计记录的主要界面。

## 本仓库的端到端验收覆盖

本仓库附带了涵盖 README 中描述的操作员行为的端到端测试：

- 显式的绝对路径插件加载到临时项目并创建侧车。
- 针对已提交的 `route=keep` 替换进行确定性的投射重新运行。
- 成功的 `route=delete` 提交及极简的投射删除通知。
- 使用 `sqlite3` 对已提交的 keep/delete 记录进行 SQLite 验证。
- 实时锁等待行为，该行为在解锁后从持久化的批次状态中解析。

运行测试：

```bash
node --import tsx --test tests/e2e/**/*.test.ts
```

运行完整的仓库验证：

```bash
npm run typecheck
node --import tsx --test tests/**/*.test.ts
```

## 接缝探测（Seam probe）

对于接缝调试工作，仓库仍包含临时配置探测运行器：

```bash
npm run probe:seams
```

它的具体工作内容如下：

- 在 `.tmp/opencode-config/` 下创建一个临时的 `OPENCODE_CONFIG_DIR`。
- 为此仓库的 `src/index.ts` 写入一个显式的插件条目。
- 运行一个最小化的 `opencode run`。
- 将钩子观测结果记录到 `logs/seam-observation.jsonl`。

> 当你需要原始的钩子形状证据时，请使用接缝探测。当你需要可重复的操作员验收证明时，请使用端到端（e2e）套件。
