# `compression_mark` 工具使用说明（已实现）

## 文档定位

本文档承接旧 `.sisyphus/notepad/compression-mark-usage-guide.md` 的正式落点，描述当前 `compression_mark` 工具的公共输入、使用方法、常见错误与适用场景。

## 工具作用

`compression_mark` 用于标记一段当前可见消息范围，要求系统在未来上下文中对这段内容执行压缩或删除风格处理，从而减少 prompt 体积，同时保留必要信息。

## 当前公共契约

### 必填字段

```json
{
  "mode": "compact",
  "from": "msg_...",
  "to": "msg_...",
  "hint": "optional guidance"
}
```

### 字段说明

- `mode`
  - `"compact"`：压缩成信息更密集的保留块
  - `"delete"`：请求删除风格处理；是否允许取决于当前运行时 delete permission
- `from`
  - 起始可见消息 id
- `to`
  - 结束可见消息 id
- `hint`
  - 可选压缩指导，例如保留文件路径、错误信息或工具参数

## 如何选择消息范围

- 目标 id 来自**当前 projection 可见视图**，不是宿主内部任意原始字段。
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

应使用当前 visible view 中的 id，而不是自行猜测或使用旧文档里的其他 id 形式。

### 3. `delete` 模式当前不允许

当当前运行时不允许 delete-style 行为时，应改用 `"compact"`。

## `hint` 的用法

`hint` 用于告诉压缩系统“什么信息必须保留”。

示例：

- `Preserve all file paths and error messages`
- `Keep tool parameters and results`
- `Focus on the final solution, summarize failed exploration`

## 返回行为

成功时，工具会立即返回一个 `markId`，后续压缩/替换由异步运行时流程负责。

这意味着：

- 工具调用成功 ≠ 压缩结果已经立即可见
- 后续结果仍受 runner、gate、replacement 提交等运行时阶段影响

## 相关文档

- `../architecture/system-overview.md`
- `../compaction/compaction-lifecycle.md`
