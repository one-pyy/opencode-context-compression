# 压缩生命周期（半实现）

## 文档定位

本文档描述当前设计中的压缩生命周期、replay-first 模型、覆盖树规则、结果组与 fallback 行为。

## 触发条件

压缩在以下条件同时满足时触发：

1. 当前 hook 重放后存在至少一个合法且仍有效的 mark 节点
2. 当前有效覆盖树中的未压原始 token 总数达到 `markedTokenAutoCompactionThreshold`

## Replay-first 主模型

当前设计不把 mark 理解为调用时立即写入 SQLite 并长期维护的业务状态，而是理解为：

- 历史中的可重放意图记录
- hook 每轮都从历史中的 mark tool 调用重新推导当前有效 mark 集

SQLite 只需保存：

- mark id 对应的结果组
- 必要运行时缓存/执行元数据

## `mode` 与 `allowDelete` 的分离

- `mode`：本次请求的动作（`compact` 或 `delete`）
- `allowDelete`：delete admission gate

一旦 tool 调用被接受，后续历史解释只依赖 `mode` 与结果组，不继续把 `allowDelete` 当长期业务字段。

## 覆盖树规则

1. 后出现的 mark 若包含或等于前 mark → 后盖前，前 mark 作为子节点保留用于 fallback
2. 只有交集、没有包含关系 → 后调用报错，不进入覆盖树
3. 完全不相交 → 保留为并列独立节点

## 渲染算法

对任意节点：

1. 自己有完整结果组 → 直接使用自己的结果，子树不再展开
2. 自己无结果但子节点有结果 → 递归展开子节点，并在原位置保留 gap
3. 自己与子节点都无结果 → 当前节点不替换，保留原位置内容

## 结果组原则

- 一个 mark 可以产出多个 replacement 片段
- 语义上仍是一个整体结果组
- 要么整组存在并可渲染，要么整组都不存在
- 失败压缩不写 result group 供 projection 跳过；应直接视为本轮无结果

## `compact` 与 `delete`

- 二者共用同一套“范围 → 小模型 → result group → projection 替换”机制
- 区别在于提示词与结果类型，不在替换算法

## 不可压缩占位块

当前 `compact` 允许在输入中包含不可压缩原子片段：

- 用 XML 包裹
- 为每个片段分配唯一占位符
- 模型输出必须保留这些占位符

若输出缺失应保留的占位符，则该次输出非法，进入 retry / fallback 流程。

## 流式 transport 与 timeout / fallback 契约

当 compaction transport 改为流式实现时，单次模型尝试应遵守以下 timeout 语义：

1. **首字 timeout**：在 `compressing.firstTokenTimeoutSeconds` 限定时间内必须收到首个 token，否则当前尝试按 timeout 失败
2. **流中断续 timeout**：开始流式输出后，若连续 `compressing.streamIdleTimeoutSeconds` 未再收到新 token，则当前尝试按 timeout 失败
3. **总 timeout**：单次模型尝试总时长上限由 `compressing.timeoutSeconds` 决定，超过即按 timeout 失败

这些 timeout 都属于“当前模型尝试失败”，因此应进入模型 fallback 流程，而不是写入结果组。

本文档当前只定义语义边界：

- timeout failure 仍属于 compaction execution failure 的一类
- timeout failure 不得产生部分 result group
- timeout failure 后应按既定模型 fallback 顺序切换到下一次尝试

当前 docs 先固定 timeout / fallback 契约；具体采用“按模型耗尽后切换”还是“round-robin across models”由后续实现或专门设计文档继续收敛。

## 相关文档

- `mark-tool-contract.md`
- `lock-and-send-gate.md`
- `../projection/projection-rules.md`
