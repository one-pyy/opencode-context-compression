# 压缩生命周期（半实现）

## 文档定位

本文档描述当前设计中的压缩生命周期、replay-first 模型、覆盖树规则、结果组与 fallback 行为。

## 触发条件

压缩在以下条件同时满足时触发：

1. 当前 hook 重放后存在至少一个合法且仍有效的 mark 节点
2. 当前有效覆盖树中的未压原始 token 总数达到 `markedTokenAutoCompactionThreshold`

## 调度与执行时序（当前实现，待替换）

当前 runtime 采用异步 background executor 模式，接受一轮延迟的 opportunistic execution：

1. `messages.transform` 先完成本轮投影，并产出完整 projection state
2. `chat.params` 根据 replayed marks / mark tree / token 阈值冻结 eligible mark，并写入 pending compactions
3. 下一轮 `messages.transform` 末尾的 background executor 扫描 pending compactions，写 lock 并开始压缩
4. lock 存在期间，后续 `messages.transform` gate 会等待压缩完成后再继续投影

因此，`chat.params` 写入 pending 的同一轮请求仍可能继续发给模型；压缩通常在下一轮处理时启动。

## 目标设计：异步压缩 + 替换门槛解耦（未实现）

目标设计保留异步后台压缩，但将**压缩执行**与**替换应用**解耦，并去掉 pending 中转和 send-entry-gate：

### 压缩执行（N+1 启动）

1. N+0：模型在 `chat.params` 之后调用 `compression_mark`，mark 进入 host history
2. N+1：`messages.transform` replay 历史，第一次看到 mark。构造完 projection state 后，若存在 eligible mark，**直接在末尾启动后台压缩**（state 已在手边，不需要 pending 中转，不需要等 `chat.params`）
3. 后台压缩写 lock、调小模型、写 result group、清 lock

关键变化：压缩从 N+2 提前到 N+1，因为 `messages.transform` 已经有 projection state，不需要跨 seam 传递。`chat.params` 的调度评估逻辑合并回 `messages.transform`，pending 中转去掉。

### 替换应用（门槛触发）

result group 入库后**不立即替换**。替换在以下条件之一满足时启用：

1. 待替换内容的未压 token 达到 `markedTokenAutoCompactionThreshold`
2. 本次发送距离上一轮 `time.end` 超过 idle 阈值（如 5 分钟）

投影逻辑变为：result group 存在 **且** 替换门槛满足 → 用 result group 替换；否则保留原内容。

### 收益

- 压缩提前一轮：N+1 即开始，N+2 result group 已入库
- 去掉 pending 中转和 `chat.params` 调度职责，单一路径
- 去掉 send-entry-gate：替换由门槛控制，不需要阻塞普通对话等待压缩完成
- idle 时间吸收等待：用户休息后再发消息时，result group 已就绪，直接替换，无感知

### 代价与开放问题

- 压缩仍异步，N+1 的请求不阻塞，但 result group 要到 N+2 才可用
- 若 N+2 替换门槛满足但压缩仍在进行中，需要决定：等待还是跳过本轮替换（待定）
- `time.end` 是否包含 tool 执行耗时需从实际 host history 验证；若不含，idle 计时起点偏早，门槛偏松
- lock 仍需保留（防止并发压缩），但 send-entry-gate 可移除

### 与当前实现的差异

| 维度 | 当前实现 | 目标设计 |
|---|---|---|
| 压缩启动 | N+2（executor 扫 pending） | N+1（messages.transform 末尾直接启动） |
| pending 中转 | 需要（chat.params 写，executor 读） | 不需要（state 在手边） |
| chat.params 调度 | 冻结 batch、写 pending | 合并回 messages.transform |
| 替换时机 | result group 存在即替换 | result group 存在 **且** 门槛满足 |
| send-entry-gate | 阻塞普通对话 | 移除 |
| lock | 保留 | 保留（防并发压缩） |

同一个 batch 内的多个 pending mark 当前分两阶段执行：

1. **compute 阶段并行**：每个 mark 独立构造 compaction input、调用模型 transport、执行 retry / fallback / output validation。
2. **commit 阶段串行**：已验证结果按 pending 顺序写入 result group，并批量标记 processed pending rows。

并行边界只覆盖模型计算与校验；SQLite result group 写入、pending row 更新、lock settle 仍保持单线程顺序。失败的 mark 不写 result group，也不标记 processed；成功或已有 result group 的 mark 才进入 processed 集合。

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

## 无效模型输出 retry 规则（已实现 / 半实现）

当模型输出因 placeholder 缺失、未知 placeholder、顺序错误或 protected-text leakage 等验证失败而被判定为 `DCP_INVALID_MODEL_OUTPUT` 时，运行时可对同一模型尝试做一次窄 retry。

边界：

- retry 只针对模型输出形状/验证失败，不是无限重试机制
- retry 不应跳过 validator，也不应放宽 placeholder / protected text 规则
- state mutation 只能发生在验证通过之后
- transport/provider 级失败仍按模型 fallback chain 处理

默认 compaction prompt 应从第一次尝试起就强调 protected placeholder discipline，而不是把强约束留到 retry-only prompt。

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
