# opencode-context-compression 插件设计文档

> 本文档是 `opencode-context-compression` 插件的权威设计契约。所有实现、配置、测试、prompt 编写都应以本文档为准。
>
> 本文档综合了 2026-03-31 至 2026-04-03 期间的所有设计决策，以及用户当前明确说明的规则。冲突时优先级：用户当前说明 > 4/2 教程 > 3/31 教程 > 更早文档。

---

## 1. 系统总览

### 1.1 一句话定义

本插件实现 OpenCode 会话的上下文压缩（DCP = Dynamic Context Pruning），通过"标记 → 累积 → 压缩 → 替换"的流水线，在保持宿主历史不变的前提下，动态缩减模型可见的 prompt 窗口。

### 1.2 核心设计原则

- **宿主历史是唯一真相源**：插件不写入、不修改、不删除 OpenCode 的 canonical host history
- **SQLite 是侧车，不是第二套会话**：只存插件派生状态（mark、replacement、sequence 等）
- **投影是确定性的**：相同 canonical history + 相同 sidecar 状态 → 相同 prompt-visible 输出
- **插件是唯一的压缩系统**：不应与其他 compaction/summarize 插件同时运行

### 1.3 五层架构

| 层级 | 职责 | 输入 | 输出 |
|---|---|---|---|
| **Canonical History** | 只读真相源 | OpenCode host history | canonical message 列表 |
| **Sidecar State** | 持久化插件状态 | canonical messages + 现有 SQLite | 对齐后的 marks / replacements / sequence / lock 状态 |
| **Policy** | 纯计算，deterministic | canonical history + sidecar state | compressible/protected/referable 分类、reminder anchor、是否满足压缩条件 |
| **Projection** | 决定最终给模型看的消息 | policy 结果 + canonical history + sidecar replacement | derived prompt view（消息数组） |
| **Execution/Scheduling** | 后台压缩调度 | 当前轮请求上下文 + policy 结果 + 冻结 batch snapshot | 后台 compaction job、lock 文件、普通对话等待/恢复信号 |

### 1.4 端到端数据流

1. 读取当前 host history，得到 canonical message 列表
2. 用 canonical message 列表同步 SQLite sidecar 的有效性
3. 从 canonical history + SQLite 计算 reminder、mark 命中、replacement 命中、visible id
4. 在 `experimental.chat.messages.transform` 中把计算结果投影成最终 prompt-visible 消息数组
5. 如果当前轮满足压缩条件，scheduler 冻结当前 batch snapshot 并触发后台 compaction job
6. compaction job 写 lock、按 `compactionModels` 数组顺序尝试模型、成功则提交 replacement，失败则只保留 mark
7. 普通对话在 lock 期间等待；当 compaction 成功、终态失败、超时或手工清 lock 后，再继续
8. 下一轮再进入 `messages.transform` 时，已提交的 replacement 才会真正替换 source span

### 1.5 端到端示例

假设当前 host history 如下：

```
U1          — 用户提问
A1.1        — AI 调用工具
T1.1        — 工具回复
A1.2        — AI 接着调用
T1.2        — 工具回复
U2          — 用户提问
A2.1        — AI 调用工具
T2.1        — 工具回复
```

当**潜在可压 token**超过 `hsoft` 时，系统插入 soft reminder。AI 发现前一轮有可压缩内容（工具调用），发出 mark：

```
M[U1~T1.2]  — AI 标记 U1 到 T1.2 为可压缩
```

此时需要压缩的 token 数为 12000，小于 `markedTokenAutoCompactionThreshold`，仅标记不压缩。

当 mark 覆盖的 token 总数达到 `markedTokenAutoCompactionThreshold` 后，后台压缩启动：

```
压缩前：
U1, A1.1, T1.1, A1.2, T1.2, U2, A2.1, T2.1

压缩后：
C[A1.1~T1.2]  — 压缩块，替代原来的 A1.1, T1.1, A1.2, T1.2
U1, U2, A2.1, T2.1  — 未被压缩的消息保留
```

压缩完成后，相关的 reminder 和 mark tool 调用从 projection view 中删除。

### 1.6 生命周期实体符号

讨论生命周期时使用以下符号：

| 符号 | 含义 |
|---|---|
| `U.n` | 用户消息（如 `U1`、`U2`） |
| `A.n` | 一次完整的助手回答/回合（不是一次内部模型采样） |
| `A.n.x` | 助手子步骤（如 `A2.1`、`A2.2`） |
| `T.n.x` | 工具回复（如 `T1.1`、`T2.3`） |
| `R.n` | reminder 提醒（如 `R1`、`R2`） |
| `M[...]` | AI 对可压缩 span 的标记，不是压缩结果 |
| `C[...]` | 压缩结果，替代之前被标记的历史 |

**示例**：`M[U1~T1.2]` 表示 AI 标记从 U1 到 T1.2 的跨度为可压缩。`C[A1.1~T1.2]` 表示该跨度已被压缩。

这些符号主要用于讨论生命周期，帮助描述用户例子与压缩前后关系；**实现上的主数据模型仍然是“按消息建模的稳定 visible ID + 每消息 policy 分类”**，而不是把 span 层级本身当成唯一主键。

### 1.7 关闭其他压缩能力

启用本插件前，必须确保以下压缩系统全部关闭：

1. 从 `opencode.jsonc` 中移除旧 `opencode-dcp-fork` 插件入口
2. 不安装或不启用 `@tarquinen/opencode-dcp`（opencode-dynamic-context-pruning）
3. 不并行使用其他修改 `messages.transform` 的压缩插件
4. 不把 OpenCode 原生 compaction 当作第二套自动压缩器（在 `opencode.jsonc` 中设置 `"compaction": { "auto": false, "prune": false }`）

原因：插件假设它是唯一负责决定何时替换、隐藏或移除提示词可见源跨度的组件。多个压缩系统同时运行会让替换匹配、锁恢复与侧车状态解释都失去可信度。

### 1.8 检查命令

从插件根目录执行：

```bash
# 查看 canonical host history
/root/.opencode/bin/opencode export <session-id>

# 查看 sidecar 数据库结构
sqlite3 "state/<session-id>.db" ".schema"

# 检查 mark 是否存了完整 source_message_ids 快照
sqlite3 "state/<session-id>.db" "select * from marks;"

# 检查 replacement 是否绑定 canonical source 且 route/状态正确
sqlite3 "state/<session-id>.db" "select * from replacements;"

# 触发 in/out snapshot（需设置 env）
OPENCODE_CONTEXT_COMPRESSION_DEBUG_SNAPSHOT_PATH=logs /root/.opencode/bin/opencode run --session <session-id> "<probe>"

# 手动恢复被卡住的 compressing 状态
rm "locks/<session-id>.lock"
```
---

## 2. 消息分类与 Visible State

### 2.1 分类规则

每条消息在 policy 层被分类为以下三种 visible state 之一：

| 消息类型 | visibleState | 说明 |
|---|---|---|
| `system` | `protected` | 系统消息永远受保护，不可压缩 |
| `user` 且文本长度 ≤ `smallUserMessageThreshold` | `protected` | 短用户消息永久保护 |
| `user` 且文本长度 > `smallUserMessageThreshold` | `compressible` | 长用户消息可被压缩 |
| `assistant` | `compressible` | 助手消息可被压缩 |
| `tool` | `compressible` | 工具调用回复可被压缩 |

### 2.2 分类实现

分类逻辑在 `src/projection/policy-engine.ts` 的 `classifyCanonicalMessage` 函数中：

```typescript
function classifyCanonicalMessage(envelope, smallUserMessageThreshold): CanonicalProjectionVisibleState {
  const role = envelope.info.role;
  if (role === "system") return "protected";
  if (role === "user" && textLength(envelope) <= smallUserMessageThreshold) return "protected";
  return "compressible";
}
```

### 2.3 重要说明

- `tool` 消息**参与 reminder token 计数**（因为它们是 `compressible`）
- 用户消息**不是统一不可压缩的**，只有短消息受永久保护
- 分类只发生在 policy 层，projection 层只消费分类结果

### 2.4 纯工具调用时的合成 assistant 消息

当 assistant 已经有正文时，把 assistant 的 visible id **直接放到正文最前面**。只有在模型只发出 tool 调用、完全没有 assistant 文本时，才补一条**合成 assistant 消息**来承载 assistant 侧的 visible ID。

原因：不能依赖结构化的 `function_call.id` / `call_id` 自然对模型可见。稳定做法是：assistant 有正文时，把 id 插到正文最前面；assistant 没正文时，再补一条只含 id 的壳。

推荐格式：

```text
[assistant_shell_visible_id]
```

约束：

- 这条 assistant 壳文本只写 **visible id 本身**，不要再写 “Calling <tool>” 之类额外说明
- 如果 assistant 已经有正文，不额外补壳，直接把 id 放到正文最前面
- 如果 assistant 没有正文，补一条只含 id 的壳
- 这条 assistant 壳文本是 projection 层的可见性辅助结构，不是写回宿主历史的业务消息

示例：

```text
原始：
- assistant 有正文

投影后：
- `[compressible_000002_m2] 我先查一下。`
- 工具结果：最前面插入各自的 msg id
```

```text
原始：
- 只有 tool 调用，没有 assistant 文本

投影后：
- `[compressible_000002_m2]`
- 工具结果：最前面插入各自的 msg id
```

这里的目标不是伪造业务内容，而是确保 assistant / tool 在模型视野中都有稳定、可引用的前导 id。

### 2.5 Tool Result Visible ID 的放置位置

每个工具返回都必须有**各自独立的 msg id**，直接插到最前面。

- 如果工具输出是普通字符串：把该工具自己的 msg id 直接放在文本最前面
- 如果工具输出是 Responses API content array：把该工具自己的 msg id 插到数组最前面的 `input_text` 位置

示例：

```text
正确：
[compressible_000003_k9] Search results: ...

数组型结果：
[
  {"type":"input_text","text":"[compressible_000003_k9]"},
  {"type":"input_text","text":"Search results: ..."}
]

错误：
Search results: ... [compressible_000003_k9]
```

把 msg id 放在最前面即可；这是当前需要遵守的核心规则。

### 2.6 Tool 的执行身份与可见身份分离

对工具来说，**执行身份**和**可见身份**是两套不同概念：

- 执行身份继续使用宿主运行时的 `toolCallId` / `callID`
- 可见身份使用插件分配的 visible ID，供模型引用和 prompt 投影使用

不要把 visible ID 反过来当成工具执行主键；它是 prompt 层的稳定引用，不是宿主工具调度协议的一部分。

### 2.7 Visible ID 与 Cache 的兼容性

assistant/tool visible ID 可以与 Responses API 的 cache 命中共存。关键不是“永远不要加 ID”，而是：

- 保持稳定的前缀格式
- 不随意改 serializer / output shape
- 对真实 provider 行为做经验验证，而不是靠直觉假设

### 2.8 Durable History 与 Effective Prompt Set 的分离

宿主的 durable history 与实际发给模型的 effective prompt set 是**两个不同层面**。

- durable history 由宿主维护，是长期记录
- effective prompt set 由插件的 projection 结果决定，是当前轮真正送给模型的视图

因此，压缩后旧消息可能仍存在于宿主历史里，但不再进入当前 prompt。插件做的是“改变 prompt 成员资格”，不是“物理删除宿主历史”。

---

## 3. Reminder 系统

### 3.1 架构模型

Reminder 是 **projection 阶段生成的模型可见 artifact**，不是写入 session history 的持久消息。

- 从 canonical history 持续计算得出
- 相同 history 导出相同 reminder 位置
- history 变化后 cache miss 合理
- 不是 durable synthetic message，不写回宿主历史
- 在 projection 中作为一条独立消息插入，锚定在触发 milestone 的那条消息之后

### 3.2 Token 口径

**`hsoft` 和 `hhard` 的 token 计数基于所有 `visibleState === "compressible"` 的消息 token。**

具体来说：

- `system` 消息 → `protected`，**不计入** reminder token
- 短 `user` 消息（文本长度 ≤ `smallUserMessageThreshold`）→ `protected`，**不计入** reminder token
- 长 `user` 消息 → `compressible`，**计入** reminder token
- `assistant` 消息 → `compressible`，**计入** reminder token
- `tool` 消息 → `compressible`，**计入** reminder token

**示例**：

- system 消息占 30k token
- assistant + tool 占 5k token
- 没有 compressible 消息（即 assistant 和 tool 都不存在）

→ 潜在可压 token = 0，**不触发任何 reminder**

**另一个示例**：

- system 消息占 30k token（protected，不计入）
- assistant 消息占 3k token（compressible，计入）
- tool 消息占 2k token（compressible，计入）

→ 潜在可压 token = 5k，如果 `hsoft = 30000`，**不触发 reminder**

### 3.3 首次触发规则

| 条件 | 行为 |
|---|---|
| 潜在可压 token 首次 ≥ `hsoft` | 触发 soft reminder |
| 潜在可压 token 首次 ≥ `hhard` | 触发 hard reminder（hard 优先于 soft） |

### 3.4 阈值与重复 cadence 规则（按 token 配置）

当前 reminder 设计同时定义：

- 首次 soft 阈值：`hsoft`
- 首次 hard 阈值：`hhard`
- soft 区间重复 cadence：`softRepeatEveryTokens`
- hard 区间重复 cadence：`hardRepeatEveryTokens`

规则如下：

- 当潜在可压 token 尚未达到 `hsoft` 时：不导出 reminder
- 当潜在可压 token 首次达到 `hsoft` 且尚未达到 `hhard` 时：导出一条 soft reminder
- 在 soft 区间内，之后每再增加 `softRepeatEveryTokens` 个潜在可压 token，再导出一条 soft reminder
- 当潜在可压 token 首次达到 `hhard` 时：导出一条 hard reminder，hard 覆盖 soft
- 在 hard 区间内，之后每再增加 `hardRepeatEveryTokens` 个潜在可压 token，再导出一条 hard reminder

`repeatEvery` 仍然存在于设计里，但它的语义已经从旧的“消息计数 cadence”重构为**按 token 配置的重复 cadence**。当前权威字段不再使用旧的 `counter.source` / `counter.*.repeatEvery` 结构。

### 3.5 阈值与 cadence 示例

假设配置：

```jsonc
{
  "reminder": {
    "hsoft": 30000,
    "hhard": 88000,
    "softRepeatEveryTokens": 20000,
    "hardRepeatEveryTokens": 10000
  }
}
```

则：

| 潜在可压 token 累计 | 触发类型 | 说明 |
|---|---|---|
| 29,999 | 无 | 尚未达到 soft threshold |
| 30,000 | soft | 首次达到 hsoft |
| 50,000 | soft | 30,000 + 20,000 |
| 70,000 | soft | 30,000 + 2 × 20,000 |
| 87,999 | soft | 尚未达到 hhard |
| 88,000 | hard | 首次达到 hhard，hard 覆盖 soft |
| 98,000 | hard | 88,000 + 10,000 |
| 108,000 | hard | 88,000 + 2 × 10,000 |

### 3.6 Reminder 锚点

Reminder 锚定在**实际跨过该 token milestone 的那条 compressible 消息之后**。

- 如果 milestone 落在某条消息的中间，reminder 加在这条消息后
- 如果当前没有 compressible 消息（潜在可压 token = 0），不触发 reminder

### 3.7 Reminder 消息格式

Reminder 在 projection 中作为一条独立消息插入。

- **不写入消息序号**：reminder 消息本身不携带 visible id 序号（如 `reminder_000004_p4` 这种格式不用于消息层）
- 如果数据库需要记录 reminder 的序号，写在数据库里，永久保留
- Reminder 消息的 visible id 由 projection 层生成，但不占用永久递增序号序列

### 3.8 Reminder Prompt 文件

Reminder 的文本内容来自 repo-owned prompt 文件。根据 **severity × allowDelete** 的组合，需要四个 prompt 文件：

| 文件 | 用途 |
|---|---|
| `prompts/reminder-soft-compact-only.md` | soft reminder + `allowDelete=false` |
| `prompts/reminder-soft-delete-allowed.md` | soft reminder + `allowDelete=true` |
| `prompts/reminder-hard-compact-only.md` | hard reminder + `allowDelete=false` |
| `prompts/reminder-hard-delete-allowed.md` | hard reminder + `allowDelete=true` |

**注意**：这些 prompt 文件是**纯文本提醒消息**，不是模板。模板是 `compaction.md`（压缩时使用的 system prompt）。

当前已有的 `prompts/reminder-soft.md` 和 `prompts/reminder-hard.md` 是旧版，需要被上述四个文件替代。

### 3.9 allowDelete 对 Reminder 的影响

`allowDelete` 决定 reminder 的措辞倾向：

- **`allowDelete=false` 场景下的 reminder**：提示 AI 可以压缩不需要的上下文，但不应把目标作为可直接删除对象对待
- **`allowDelete=true` 场景下的 reminder**：提示 AI 可以调用普通压缩，也可以在不再需要时直接删除消息

### 3.10 Soft 与 Hard Reminder 的约束强度

- `hsoft` 只是提示性提醒。AI 可以先继续完成当前工作，再决定是否立即发 mark。
- `hhard` 是更强的提醒。达到 `hhard` 后，AI 应优先处理不再需要的上下文；只有在确认相关上下文全部必须保留时，才可以暂不压缩。

示例：

```text
A3.2：AI 仍在完成当前任务，虽然已经达到 hsoft，但决定先不标记。

达到 hhard 后：
AI 应在下一轮优先压缩不需要的上下文，除非它确认这些上下文全部必须保留。
```

### 3.11 压缩完成后的 Reminder 清理

当某个压缩窗口成功提交 replacement 后，该窗口内**已过期的 reminder**应从 prompt-visible view 中一并消失。

这不是因为 reminder 从宿主历史被删除，而是因为 reminder 的职责已经结束，新的 projection 已有 replacement 承担主要上下文承载责任。

---

## 4. allowDelete（删除许可）

### 4.1 语义定义

`allowDelete` 是**目标消息或压缩结果是否允许被删除**的布尔许可位，不是“压缩结果路由枚举”。

它不改变宿主 canonical history 的只读事实地位，只影响插件在 prompt-visible projection 与后续压缩生命周期中允许采取的动作。

| allowDelete | 行为 |
|---|---|
| `false` | 允许普通压缩；压缩后消息不得被再次压缩，也不得被删除 |
| `true` | 允许普通压缩，也允许直接删除消息；如果先压缩再保留压缩块，该压缩块之后仍可进入删除路径，但不得再次压缩 |

### 4.2 共同规则

- 删除不是独立的第二套子系统；它仍属于同一条 mark → source snapshot → replacement / delete → projection 语义链
- 无论 `allowDelete` 取值如何，**再次压缩都被禁止**
- `allowDelete=true` 允许的“直接删除”是终结性清理，不是再次压缩

### 4.3 控制来源

`allowDelete` 是与目标消息、mark、source snapshot、replacement 相关的局部语义位，不是全局 runtime config 根级开关。

当前设计中，`allowDelete` 应作为 mark / replacement / canonical source 的语义属性被保存和比较，而不是作为 repo 级统一 route 被广播。

### 4.4 `allowDelete=true` 的完整删除路径

既然设计文档允许 `allowDelete=true`，那删除路径就必须是**完整支持的正式能力**，而不是过渡期兜底语义。

`allowDelete=true` 下，模型和运行时至少应支持两种合法结果：

1. **普通压缩**
   - 对目标消息生成普通 replacement
   - projection 中留下可引用的压缩块
   - 该压缩块之后仍可进入删除路径，但不得再次压缩

2. **直接删除**
   - 对目标消息提交删除型结果
   - projection 中移除原始源跨度，只留下极简 delete notice
   - delete notice 是终结性清理结果，不再进入压缩链

因此，`allowDelete=true` 不是“未来再说”的能力开关，而是会影响 mark、replacement、prompt、projection、canonical source 匹配与执行分支的现行设计语义。

---

## 5. Visible ID 系统

### 5.1 规则

- 前六位：永久递增序号（`000001`, `000002`, ...）
- 后缀：基于 canonical host message identifier 的校验码/checksum
- 按当前口径，canonical host message identifier 默认使用 message envelope 的 `info.id`
- 不使用随机数
- 不因中间消息删除而 renumber
- 永久单调递增，删除/隐藏消息只产生序号空洞，不触发重新编号

### 5.2 格式示例

```
metadata 中的 canonical visible id（bare form）：
000001_q7
000002_m2
000003_k9

最终渲染到模型可见文本时（single-exit）：
[protected_000001_q7] ...
[compressible_000002_m2] ...
[compressible_000003_k9] ...
[referable_000003_w1] ...
```

说明：

- metadata 中保存的是 bare canonical id
- 最终模型可见前缀只在单一出口渲染一次
- 当前模型可见状态前缀使用 `protected` / `referable` / `compressible`

### 5.3 Compact 序号规则

Compact 消息的 visible id 序号**取被压缩消息的最小值**。

例如：如果压缩了 `000003`、`000004`、`000005` 三条消息，compact 消息的序号为 `000003`。

### 5.4 Reminder 序号规则

Reminder 消息**不写入 visible id 序号**到消息层。如果数据库需要记录 reminder 的序号，写在数据库里，永久保留。

### 5.5 Canonical Message Identifier 的选择规则

按当前已确认的运行时口径，canonical host message identifier 默认取 `experimental.chat.messages.transform` 消息 envelope 上的 `info.id`。

`parts[*].messageID` 可以作为一致性旁证，但不是第一选择。不要在代码里假定字面 `hostMessageId` 一定存在。

---

## 6. Mark 工具

### 6.1 职责

AI 唯一的 DCP 工具是 `compression_mark`，职责仅为**打 tag/mark**：

- 不负责压缩执行
- 不负责调度
- 不负责 prompt 投影

### 6.2 工具契约

- `contractVersion` 是 `v1`
- `allowDelete` 是 `boolean`
- `target.startVisibleMessageID` 和 `target.endVisibleMessageID` 来自当前 projected visible view
- 工具解析目标跨度并持久化 mark 到 sidecar

### 6.3 Mark 与 Replacement 的关系

Mark 是 lookup hint，不是 source of truth：

1. 看到 mark tool 调用
2. 由 mark tool 调用找到 SQLite 中的 mark 记录
3. 从 mark 里取出 `source_message_ids`
4. 用这组 canonical source 去匹配 replacement
5. 命中后才替换原消息

如果 replacement 已成功替换原内容，相应的 mark tool 调用应从 prompt-visible view 中删除。

### 6.4 Canonical Source 的定义与命中规则

一个 replacement 是否命中当前历史，不看 tool 文本是否“长得一样”，而看 canonical source 是否匹配。

推荐的 canonical source 结构：

- 有序的 `source_message_ids`
- 必要时再加内容/版本指纹
- `allowDelete` / `policy version`（如果它会影响替换语义）

命中条件：

1. 当前 history 中这组 source 仍都存在
2. 顺序仍一致
3. 内容/版本指纹仍匹配（如启用）
4. `allowDelete` / policy 没冲突

如果匹配到多条 replacement，当前规则是：**取最后一条（按最后时间）**。

如果 source 校验失败：**不替换**。

示例：

```text
mark_17 绑定 [msg_a1, msg_tool_1, msg_tool_2]

当前 history 里只剩 [msg_a1, msg_tool_1]
=> source 已不完整，即使看见了 mark tool 调用，也不能替换
```

---

## 7. 压缩生命周期

### 7.1 触发条件

压缩在以下条件同时满足时触发：

1. 存在至少一个 active mark
2. 所有 active mark 覆盖的 token 总数 ≥ `markedTokenAutoCompactionThreshold`

### 7.2 不支持多次压缩

**压缩后的内容不能再次被压缩。**

这适用于：
- `allowDelete=false` 下产生的 compacted block
- `allowDelete=true` 下产生的 compacted block
- `allowDelete=true` 下产生的删除性结果

这里的“禁止”只针对**再次压缩**，不针对删除许可本身；也就是说，`allowDelete=true` 不违反“不支持多次压缩”，因为删除不是再次压缩。

### 7.3 压缩失败语义

- 压缩失败不写 replacement
- mark 保留
- 当前 compaction 尝试可以停
- 若普通对话正在等待，则等待应在"终态失败"这里结束，而不是机械地再等到 timeout

### 7.4 Compaction Input Builder 与 Projection Builder 的分离

压缩输入构造和 prompt 投影必须是两个独立模块：

- `projection-builder` 负责生成当前轮给模型看的 derived prompt view
- `compaction-input-builder` 负责基于 canonical source snapshot 构造压缩专用输入

不要复用 projected prompt view 再去“清洗”出 compaction 输入；正确行为应来自清晰输入边界，而不是靠后续补救。

---

## 8. Lock / Compressing 门闩

### 8.1 Lock 生命周期

- 后台压缩任务**真正开始时**写入 lock 文件
- Lock 文件记录当前时间
- 所有 retry/fallback 尝试全部完成后清除（成功或失败都清）
- 超过 `compressing.timeoutSeconds` 后，后续请求自动忽视该 lock
- 手动删除 `locks/<session-id>.lock` 可恢复

### 8.2 阻塞范围

- **普通对话继续发送时等待**：等待到 lock 解除/终态失败/超时/手工恢复后再继续
- **DCP mark 工具不进入当前运行 batch**：当前 batch 在 dispatch 时已经冻结，后续写入自然不属于当前 batch
- **非 DCP 工具调用不阻塞**

### 8.3 Batch Snapshot 冻结规则

当前 compaction batch 的 mark 集合在 **dispatch 时冻结**。这意味着：

- lock 期间后来新增的 mark 不属于当前 batch
- 不需要在运行时代码里写“这是 lock 期间新加的 mark”的 special-case branching
- 正确行为来自批次快照边界，而不是来自一堆时间窗口特判

### 8.4 普通对话等待入口

普通对话的等待应发生在**真正进入 send path 之前的 send-entry gate**，而不是依赖 `chat.params` 晚期返回错误。

`chat.params` 如保留，只承担后台压缩调度和少量 runtime metadata，不承担普通对话等待入口。

---

## 9. 配置面

### 9.1 配置文件

`src/config/runtime-config.jsonc` 是 canonical runtime settings 文件。

### 9.2 字段清单

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `version` | `1` | 必填 | 配置契约版本 |
| `promptPath` | string | 必填 | 压缩 prompt 文件路径 |
| `compactionModels` | string[] | 必填 | 压缩模型链（有序，用于 retry/fallback） |
| `markedTokenAutoCompactionThreshold` | number | `20000` | marked token 就绪阈值 |
| `smallUserMessageThreshold` | number | `1024` | 短 user 消息保护阈值 |
| `reminder.hsoft` | number | `30000` | soft reminder 潜在可压 token 阈值 |
| `reminder.hhard` | number | `70000` | hard reminder 潜在可压 token 阈值 |
| `reminder.softRepeatEveryTokens` | number | `20000` | soft 区间重复 cadence 的 token 步长 |
| `reminder.hardRepeatEveryTokens` | number | `10000` | hard 区间重复 cadence 的 token 步长 |
| `reminder.promptPaths.compactOnly.soft` | string | `prompts/reminder-soft-compact-only.md` | `allowDelete=false` 下的 soft reminder 文本路径 |
| `reminder.promptPaths.compactOnly.hard` | string | `prompts/reminder-hard-compact-only.md` | `allowDelete=false` 下的 hard reminder 文本路径 |
| `reminder.promptPaths.deleteAllowed.soft` | string | `prompts/reminder-soft-delete-allowed.md` | `allowDelete=true` 下的 soft reminder 文本路径 |
| `reminder.promptPaths.deleteAllowed.hard` | string | `prompts/reminder-hard-delete-allowed.md` | `allowDelete=true` 下的 hard reminder 文本路径 |
| `logging.level` | `"off"\|"error"\|"info"\|"debug"` | `"off"` | 日志级别 |
| `compressing.timeoutSeconds` | number | `600` | 压缩锁超时秒数 |
| `schedulerMarkThreshold` | number | `1` | 内部/test 兼容性参数 |
| `runtimeLogPath` | string | 必填 | 运行时事件日志路径 |
| `seamLogPath` | string | 必填 | seam 观察日志路径 |

### 9.3 Env 覆盖

环境变量优先级高于配置文件：

| 环境变量 | 覆盖字段 |
|---|---|
| `OPENCODE_CONTEXT_COMPRESSION_RUNTIME_CONFIG_PATH` | 配置文件路径 |
| `OPENCODE_CONTEXT_COMPRESSION_PROMPT_PATH` | `promptPath` |
| `OPENCODE_CONTEXT_COMPRESSION_MODELS` | `compactionModels`（逗号分隔） |
| `OPENCODE_CONTEXT_COMPRESSION_RUNTIME_LOG_PATH` | `runtimeLogPath` |
| `OPENCODE_CONTEXT_COMPRESSION_SEAM_LOG` | `seamLogPath` |
| `OPENCODE_CONTEXT_COMPRESSION_LOG_LEVEL` | `logging.level` |
| `OPENCODE_CONTEXT_COMPRESSION_COMPRESSING_TIMEOUT_SECONDS` | `compressing.timeoutSeconds` |
| `OPENCODE_CONTEXT_COMPRESSION_DEBUG_SNAPSHOT_PATH` | debug snapshot 路径 |

未设置的环境变量表示"无覆盖"。空值或纯空白值在插件启动时被拒绝。

`schedulerMarkThreshold` 与 `markedTokenAutoCompactionThreshold` 不是同一个概念：

- `schedulerMarkThreshold` 是内部 / test 兼容性阈值，按 mark 数量工作
- `markedTokenAutoCompactionThreshold` 是真正的 marked-token readiness 阈值，按被 mark 覆盖的 token 总数工作

在 reminder 配置上，当前设计保留：

- `hsoft` / `hhard`
- `softRepeatEveryTokens` / `hardRepeatEveryTokens`
- 四类 reminder prompt path

旧的 `counter.source` / `counter.*.repeatEvery` 不属于当前权威配置面。新的重复提醒语义必须通过显式 token 字段表达，而不是通过消息数计数器表达。

### 9.4 与旧配置面的映射

为了帮助后续实现与迁移，下列旧配置概念在新插件中的命运如下：

#### 保留或沿用语义

- `enabled` — 保留
- `reminder.cadence.hsoft` — 保留
- `reminder.cadence.hhard` — 保留
- `reminder.cadence.resetMultiplier` — 删除；当前设计改为显式 `softRepeatEveryTokens` / `hardRepeatEveryTokens`
- `reminder.cadence.counter.*` — 删除；当前设计不保留计数器型 reminder cadence
- `compaction.prompt.source` — 保留，而且必须是明确文件路径
- `compaction.prompt.smallUserMessageThreshold` — 保留
- `compaction.execution.markedTokenAutoCompactionThreshold` — 保留
- `compaction.execution.route` — 删除；语义重构为 `allowDelete: boolean`，且不再作为根级 runtime route 存在
- `compaction.model` — 保留为数组，因为顺序 retry/fallback 链更容易实现和调试
- `logging.level` — 保留
- `logging.runtimeLog.path` — 保留

#### 删除或重做

- `decision.mode` — 删除；新插件不再围绕旧 decision envelope 设计
- `reminder.delivery` — 删除；新 reminder 不再是旧 delivery mode
- `compaction.prompt.allow_builtin_prompt_fallback` — 删除；新插件固定一个 prompt 文件路径
- `compaction.execution.mode` — 删除；新插件默认后台压缩，不再保留旧双执行模式
- `compaction.execution.allow_deterministic_fallback` — 删除；第一版不引入第二套 compaction 引擎
- `errors.mode` — 重做为简单语义：DCP 可以停；普通对话在 `compressing` 期间等待，直到成功、终态失败、超时或手工恢复后再继续
- `state.store` — 删除；不做多种持久化后端

### 9.5 Metadata 的地位

metadata 可以存在，但**不是跨轮真相源**。跨轮真相在 SQLite sidecar。

不要把临时 metadata 当成 mark、replacement、lock 或 visible sequence 的长期依据。

---

## 10. 投影规则

### 10.1 消息分类表

| 消息类型 | visibleState | 是否参与 reminder token 计数 | 是否可被压缩 |
|---|---|---|---|
| `system` | `protected` | 否 | 否 |
| 短 `user`（≤ `smallUserMessageThreshold`） | `protected` | 否 | 否 |
| 长 `user`（> `smallUserMessageThreshold`） | `compressible` | 是 | 是 |
| `assistant` | `compressible` | 是 | 是 |
| `tool` | `compressible` | 是 | 是 |

### 10.2 Replacement 渲染

- `allowDelete=false`：replacement 作为可引用块留在 projection 中，原始源跨度被隐藏；该压缩块之后不得被删除
- `allowDelete=true` 且执行普通压缩：replacement 作为可引用块留在 projection 中，原始源跨度被隐藏；该压缩块之后仍可进入删除路径
- `allowDelete=true` 且执行直接删除：projection 渲染为极简 delete notice，原始源跨度被移除
- 无论哪种情况，已压缩的内容都不再参与下一轮压缩

### 10.3 Mark Tool 调用删除

如果 replacement 已成功替换原内容，相应的 mark tool 调用应从 prompt-visible view 中删除。

处理顺序：
1. 先替换原 source span
2. 记录哪些 mark 命中了 replacement
3. 最后统一删除这些 mark tool 调用

删除只发生在 projection view，SQLite 中仍保留"这个 mark 曾存在，并已被某个 replacement 消费"的记录。

### 10.4 压缩成功后的统一清理

一旦某个窗口压缩成功，projection view 中与该窗口职责直接相关、已过期的 artifact 可以统一移除，包括：

- 已被 replacement 覆盖的 mark tool 调用
- 窗口内部已失效的 reminder
- 其他只为压缩前过渡阶段服务的可见 artifact

示例：

```text
压缩前：R1, M[T2.1,T2.3], ...
压缩后：C[T2.1], C[T2.3], ...

=> R1 与相关 mark tool 调用在新的 projection 中一起消失
```

---

## 11. Prompt 文件清单

### 11.1 压缩 Prompt（System Prompt 模板）

| 文件 | 用途 |
|---|---|
| `prompts/compaction.md` | 压缩时使用的 system prompt 模板，定义压缩输出契约 |

压缩 prompt 是**模板**，运行时注入删除许可与本次执行模式指令。模板包含：
- 输入格式说明
- 删除许可指令（`allowDelete=true|false`）
- 本次执行模式说明（普通压缩 / 直接删除）
- 输出要求

### 11.2 Reminder Prompt（纯文本提醒消息）

| 文件 | 用途 |
|---|---|
| `prompts/reminder-soft-compact-only.md` | soft reminder + `allowDelete=false` |
| `prompts/reminder-soft-delete-allowed.md` | soft reminder + `allowDelete=true` |
| `prompts/reminder-hard-compact-only.md` | hard reminder + `allowDelete=false` |
| `prompts/reminder-hard-delete-allowed.md` | hard reminder + `allowDelete=true` |

Reminder prompt 是**纯文本**，不是模板。内容是给 AI 看的提醒消息。

### 11.3 当前状态

当前已有的 prompt 文件：
- `prompts/compaction.md` — 压缩模板，已到位
- `prompts/reminder-soft.md` — 旧版 soft reminder，需要被 `reminder-soft-compact-only.md` 和 `reminder-soft-delete-allowed.md` 替代
- `prompts/reminder-hard.md` — 旧版 hard reminder，需要被 `reminder-hard-compact-only.md` 和 `reminder-hard-delete-allowed.md` 替代

### 11.4 Prompt 文件的硬约束

- reminder prompt 是纯文本，不使用变量模板
- compaction prompt 是 system prompt 模板，允许运行时注入删除许可与本次执行模式指令
- 不允许 builtin prompt fallback；缺文件、空文件或格式错误时应 fail fast

---

## 12. 运行时模型

### 12.1 四个操作员可见规则

1. **Canonical history 保持 upstream-owned**
   - 插件不覆盖宿主历史
   - 每次 transform 运行前重新同步 live host messages 到 sidecar

2. **SQLite 是 sidecar state，不是第二套会话**
   - 每个 session 一个数据库：`state/<session-id>.db`
   - marks、source snapshots、replacements、compaction batches、jobs、runtime gate observations 都存在这里

3. **文件锁是实时压缩门控**
   - 活跃 batch 写入 `locks/<session-id>.lock`
   - 普通 chat 等待该锁
   - 不相关工具继续运行
   - `compression_mark` 保持在已冻结 batch 之外

4. **投影是确定性的**
   - 已提交的 replacement 通过 `experimental.chat.messages.transform` 渲染
   - 对相同 canonical history 重新运行投影，得到相同可见输出

### 12.2 侧车布局

```
state/<session-id>.db          — SQLite 侧车数据库
locks/<session-id>.lock        — 实时压缩锁文件
logs/runtime-events.jsonl      — 运行时事件日志
logs/seam-observation.jsonl    — seam 观察日志（启用时）
```

### 12.3 侧车存储原则

- 每个 session 一个 SQLite 文件
- SQLite 文件名使用 `sessionId`
- 表内主键不必再重复携带 `sessionId`

SQLite 应保存：

- 每条 host message 的 DCP meta
- mark 记录及其完整 source 快照
- replacement 记录
- reminder 的计算/消费状态
- `compressing` 锁和后台 job 状态
- 永久 visible-id 序号分配状态

SQLite 不应被设计成：

- 另一份完整 transcript
- 可独立于 host history 运作的平行会话

### 12.4 模块职责边界

`experimental.chat.messages.transform` 是唯一的 prompt projection seam；所有模型可见改写只发生在这里。

`chat.params` 如果保留，只承担：

- 读取当前 session 是否处于 `compressing`
- 当满足条件时调度后台 compaction job
- 写入或读取少量 runtime 级 metadata（例如 trace / log 辅助字段）

`chat.params` 不应承担：

- 组装完整 transcript
- 决定 reminder 放在哪条消息后
- 渲染 visible id
- 删除或插入 mark / replacement 消息
- 普通对话等待入口

### 12.5 `messages.transform` 的实现约束

`messages.transform` 必须**原地改写** `output.messages`，不能只返回一个新数组；否则真实 provider 请求可能仍然继续使用旧数组引用。

### 12.6 Compaction Transport 的边界

compaction transport 的硬目标是：

- 独立于普通 `session.prompt` / `prompt_async` 路径
- 不污染普通会话历史

具体 transport 机制在实现前可以继续验证，但设计上不要把“普通对话发模型”与“后台压缩发模型”混成同一条职责链。

### 12.7 参考模块职责

下面这组模块边界是实现时的参考拆分方式。它们不要求当前仓库必须一字不差采用相同文件名，但**职责边界应保持等价**：

- `index.ts` — 注册 hooks、读取配置、初始化 sidecar 访问、组装模块；这里只做 wiring，不写业务逻辑
- `history-sync` — 读取当前 host messages，做 normalize，并把 sidecar 状态与 canonical history 对齐
- `sqlite-store` — 所有 SQLite 读写；不混入 prompt 逻辑
- `sequence-service` — 分配永久递增 visible-id 序号，并基于 canonical host message identifier 生成 checksum
- `mark-service` — 记录 mark、查找 mark 对应 canonical source、标记已消费关系
- `replacement-service` — 按 canonical source 匹配 replacement，并校验其在当前 history 下是否仍有效
- `reminder-service` — 从 canonical history 计算 reminder anchor 与 reminder artifact
- `projection-builder` — 组装 derived prompt view：替换 source、删除 mark tool 调用、插入 reminder、准备 visible id
- `messages-transform` — 唯一的 prompt projection seam；把 projection-builder 的结果 materialize 到 `output.messages`
- `chat-params` — 如果保留，只做后台压缩调度与少量 runtime metadata
- `compaction-input-builder` — 从 canonical source snapshot 构造压缩专用输入；不要复用 projected prompt view
- `compaction-runner` — 后台压缩任务、retry/fallback 链、lock 写入与清除，以及 compaction transport 调用
- `send-entry-gate` — 普通对话在真正进入 send path 之前的等待入口
- `debug-snapshot` — 在调试开关启用时写 `session_id.in.json` / `session_id.out.json`
- `visible-id-renderer` — 只在单一出口把 bare canonical visible id 渲染成带 `protected` / `referable` / `compressible` 前缀的最终文本
- `tools/compression_mark` — AI 唯一 DCP 工具；只打 tag/mark，不做调度、不做压缩执行

---

## 13. 验证边界

### 13.1 自动化测试范围

- `tests/cutover/runtime-config-precedence.test.ts` — 配置、prompt、日志、env 优先级
- `tests/cutover/legacy-independence.test.ts` — 无旧 runtime/tool/provider 所有权下的规范执行
- `tests/cutover/docs-and-notepad-contract.test.ts` — 操作员文档和持久记忆契约审计
- `tests/e2e/plugin-loading-and-compaction.test.ts` — 插件加载、mark 流、scheduler seam、committed replacement 路径
- `tests/e2e/delete-route.test.ts` — 旧文件名；当前应理解为 `allowDelete=true` / delete-style 行为覆盖

### 13.2 不声称的内容

- 宿主暴露的 legacy 工具已能在真实会话里提供 keep 与 delete 的端到端证明
- 仓库已提供默认生产 compaction executor transport

### 13.3 调试快照与常规日志分离

当启用调试快照时，应写出：

- `session_id.in.json`
- `session_id.out.json`

这类 snapshot 用于理解 projection 前后是否稳定，应与常规 runtime JSONL 日志分离，不要混写到同一个日志流中。

### 13.4 Truth Boundary 的操作含义

真实会话中的 live verification 适合确认：

- 插件确实加载了
- seam 日志确实写出
- sidecar / lock / snapshot 等 repo-owned 路径确实在工作

但完整的 keep / delete 成功路径仍以仓库自动化测试为准，不能把“看见了模型流量”误写成“真实会话已完成 keep / delete 证明”。

---

## 14. 设计决策记录

### 14.1 Reminder 不是插入消息

Reminder 从 canonical history 持续计算，不是 durable synthetic message。相同 history 导出相同 reminder 位置。

### 14.2 Reminder token 口径是潜在可压 token

`hsoft` / `hhard` 只计算 `visibleState === "compressible"` 的消息 token。`system` 消息和受保护的短 `user` 消息不计入。**但 `tool` 消息计入**（因为它们是 `compressible`）。

### 14.3 Reminder 仍定义按 token 的重复 cadence

当前 reminder 契约同时定义首次阈值与重复 cadence，但重复 cadence 必须使用显式 token 字段表达：`softRepeatEveryTokens` 与 `hardRepeatEveryTokens`。

### 14.4 Soft → Hard 切换

当潜在可压 token 达到 `hhard` 后，当前投影中的提醒从 soft 切换为 hard；之后继续按 `hardRepeatEveryTokens` 的 token cadence 重复提醒。

### 14.5 `allowDelete` 是删除许可位，不是 route 枚举

`allowDelete` 决定目标及其压缩结果是否允许进入删除路径；它不是 keep/delete route 枚举。当前应作为 mark / replacement / canonical source 的局部语义位处理。

- `allowDelete=false`：允许压缩，但不允许删除
- `allowDelete=true`：允许压缩，也允许删除

### 14.6 不支持多次压缩

压缩后的内容（无论 `keep` 还是 `delete`）不能再次被压缩。这是降复杂度的硬边界。

### 14.7 压缩失败保留 mark

压缩失败不写 replacement，mark 保留，后续可重新尝试压缩同一个 mark。

### 14.8 Visible ID 永久单调递增

不因消息删除/隐藏而 renumber。删除只产生序号空洞。

### 14.9 Compact 序号取最小值

Compact 消息的 visible id 序号取被压缩消息的最小值。

### 14.10 Reminder 不写入消息序号

Reminder 消息不携带 visible id 序号到消息层。如果数据库需要记录，写在数据库里，永久保留。

### 14.11 Reminder Prompt 按 severity × allowDelete 拆分

需要四个 reminder prompt 文件：soft-compact-only、soft-delete-allowed、hard-compact-only、hard-delete-allowed。Reminder prompt 是纯文本，不是模板。

### 14.12 压缩 Prompt 是模板

`compaction.md` 是压缩时使用的 system prompt 模板，运行时注入删除许可与执行模式指令。

### 14.13 Tool-Only 场景必须补合成 Assistant

当模型只发出 tool 调用而没有 assistant 文本时，projection 必须补一条简短的合成 assistant 消息，以保证 assistant / tool 的 visible ID 对模型可读。

### 14.14 Tool 执行身份与 Visible ID 分离

工具执行继续使用宿主的 `toolCallId` / `callID`；visible ID 只是模型可见引用，不是执行主键。

### 14.15 Canonical Source 校验失败不替换

如果 replacement 的 canonical source 在当前 history 中不完整、顺序不一致、版本不匹配或 `allowDelete` / policy 冲突，则不替换；如果命中多条 replacement，当前取最后一条（按最后时间）。

### 14.16 Batch 在 Dispatch 时冻结

当前 compaction batch 的 mark 集合在 dispatch 时冻结；lock 期间新写入的 mark 自然进入下一轮，不需要 special-case branching。

### 14.17 `messages.transform` 必须原地改写

不能只返回新数组；必须原地 materialize 到 `output.messages`。

### 14.18 `chat.params` 只是窄调度缝

`chat.params` 不是 prompt-authoring 层，也不是普通对话等待入口；它只是可选的窄调度缝。

### 14.19 Durable History 与 Effective Prompt Set 分离

压缩改变的是 prompt-visible membership，不是宿主 durable history 的物理存在性。

### 14.20 Metadata 不是跨轮真相源

跨轮真相在 SQLite sidecar，metadata 只是运行时附属信息。

### 14.21 `allowDelete=true` 是完整支持路径

`allowDelete=true` 下的删除路径属于目标设计的正式能力：它必须支持普通压缩与直接删除两种结果，不能只实现前者再把后者当成未来能力。

### 14.22 Reminder 不再使用 `counter` 型字段

新的 reminder 设计不再保留 `counter.source` 或任何消息数驱动的 reminder cadence 字段；重复提醒仍然存在，但通过显式 token 字段表达。

### 14.23 Visible ID 采用 bare metadata + single-exit 三态渲染

canonical visible id 在 metadata 中以 bare form 保存；最终模型可见文本只在单一出口渲染一次，并使用 `protected` / `referable` / `compressible` 三态前缀。

### 14.24 `schedulerMarkThreshold` 与 Marked-Token 阈值分离

`schedulerMarkThreshold` 只承担内部 / test 兼容角色；真正决定自动压缩 readiness 的是 `markedTokenAutoCompactionThreshold`。
