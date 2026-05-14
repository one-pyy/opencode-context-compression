# `compression_mark` 工具使用说明（已实现）

## 文档定位

本文档承接旧 `.sisyphus/notepad/compression-mark-usage-guide.md` 的正式落点，描述当前 `compression_mark` 与 `compression_inspect` 工具的公共输入、使用方法、常见错误与适用场景。

## 工具作用

`compression_mark` 用于标记一段当前可见消息范围，要求系统在未来上下文中对这段内容执行压缩或删除风格处理，从而减少 prompt 体积，同时保留必要信息。

`compression_inspect` 用于查看一段当前可见消息范围内，哪些 compressible 消息还没有被已提交压缩结果覆盖，以及每条消息当前投影阶段计算出的 token 数。

## 当前公共契约

### 必填字段

```json
{
  "mode": "compact",
  "from": "compressible_000123_ab",
  "to": "referable_000130_q7",
  "hint": "optional guidance"
}
```

### 字段说明

- `mode`
  - `"compact"`：压缩成信息更密集的保留块
  - `"delete"`：请求删除风格处理；是否允许取决于当前运行时 delete permission
- `from`
  - 起始可见消息 id，格式为 `<visible-type>_<seq6>_<base62>`；运行时按 `seq6 + base62` 定位端点
- `to`
  - 结束可见消息 id，格式为 `<visible-type>_<seq6>_<base62>`；运行时按 `seq6 + base62` 定位端点
- `hint`
  - 可选压缩指导，例如保留文件路径、错误信息或工具参数

### `compression_inspect` 输入

```json
{
  "from": "compressible_000123_ab",
  "to": "compressible_000130_q7"
}
```

返回结果先是占位 `inspectId`，后续投影会替换为按消息顺序排列的数组：

```json
{
  "ok": true,
  "messages": [
    { "id": "compressible_000123_ab", "tokens": 6489 }
  ]
}
```

## 如何选择消息范围

- 目标 id 来自**当前 projection 可见视图**，不是宿主内部任意原始字段。
- 当前可见 id 形如 `protected_000001_q7`、`compressible_000002_m2`、`referable_000003_w1`，不是 `msg_...`。
- `protected` / `compressible` / `referable` 前缀只表示当前可见状态；如果前缀后来变化，只要 `seq6 + base62` 仍匹配同一条消息，mark replay 仍可命中。
- `from` 和 `to` 是双闭区间端点；如果两者相同，范围就是这一条 visible message。
- 应优先选择已经完成、后续不太需要逐条引用的历史片段。
- 对最近几条消息、仍在进行中的任务或尚未收敛的问题，不应过早压缩。

## 推荐场景

- 长调试会话
- 探索性搜索过程
- 多轮试错但最终方案已经稳定
- 冗长上下文收集阶段

## 不推荐场景

- 最近仍在活跃使用的消息
- 含未解决问题的讨论
- 尚未完成的实现过程

## 常见错误

### 1. `from` / `to` 结构错误

必须同时提供起止 id。

### 2. 消息 id 来源错误

应使用当前 visible view 中的 id，而不是 canonical host message id、宿主内部原始字段，或旧文档里的 `msg_...` 形式。

### 3. `delete` 模式当前不允许

当当前运行时不允许 delete-style 行为时，应改用 `"compact"`。

## `hint` 的用法

`hint` 是传给压缩引擎的最高优先级指令，来自调用者（通常是外层 AI）对任务上下文的判断。压缩引擎会把 hint 视为比默认压缩原则更高优先级。

### 三类 hint 指令

**1. 任务完成 / 已外化**

告诉压缩引擎某段工作已完成或中间材料已经转移到别处，中间步骤可以降级为超链接。

- `Task completed. Bug fixed. Compress to: root cause and fix. All investigation can be reduced to file paths only.`
- `Search dumps externalized to .sisyphus/tmp/work/search-2026-w19.md — keep path and purpose, drop dump bodies.`

**2. 必须保留**

命名必须保留的实体、决策或约束。压缩引擎会把被命名的项目视为 MUST KEEP，即使它们按默认原则可以被总结。

- `Preserve candidate names: Mini Shai-Hulud, NuGet malicious packages, Antel TuID, FastSim.`
- `Keep de-prioritization rationale for each rejected option.`
- `Preserve user-stated constraints and the final agreed scope.`

**3. 丢弃授权**

明确授权压缩引擎简化某类冗长内容。

- `Do not preserve each search result verbatim.`
- `Compress intermediate exploration steps.`
- `Summarize trial-and-error, detail only the final approach.`

### 如何写一个好的 hint

- 从你（调用者）的任务视角出发：哪些已完成、哪些还要复用、哪些只是过程证据
- 命名重要实体（路径、候选名、决策），不要用"保留重要内容"这种模糊措辞
- 如果有外化文件，明确说出路径和用途
- 可以混合三类指令于同一 hint

**示例组合**：

```
Task completed. Compress three-round hidden-CTI search output. Intermediate results externalized to .sisyphus/tmp/compression/2026-05-13_cti-search.md; keep path and purpose, do not preserve full search summaries. Preserve candidate names: Mini Shai-Hulud, malicious NuGet, Antel TuID, FastSim, Vietnam investment fraud, QLNX. Also preserve duplicate/de-prioritization decisions.
```

这个例子包含：任务完成声明、外化引用、命名保留清单、丢弃授权。

## 返回行为

成功时，工具会立即返回一个 `markId`，后续压缩/替换由异步运行时流程负责。

这意味着：

- 工具调用成功 ≠ 压缩结果已经立即可见
- 后续结果仍受 runner、gate、replacement 提交等运行时阶段影响

## 相关文档

- `../architecture/system-overview.md`
- `../compaction/compaction-lifecycle.md`
