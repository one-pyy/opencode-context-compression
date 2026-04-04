# opencode-context-compression 设计改动项清单

> 这份文件只做一件事：列出本轮相对“当前仓库已知状态 / 既有文档”新增或重定义的设计项。
>
> 它**不是**实现完成证明，也**不是**当前代码真实状态的自动同步镜像。
>
> 阅读方法：
> - “已在当前仓库中观察到”表示我已经从现有代码 / 文件中读到对应事实
> - “目标设计（可能尚未实现）”表示这是本轮新定下的目标契约，当前版本中**可能还没做到**

---

## 1. 总原则

### 1.1 这轮文档修订的定位

本轮设计文档不是简单整理旧文档，而是在旧文档基础上做了多项**目标设计收敛**。因此，文档中有些内容代表“未来实现必须遵守”，不应被误读成“当前代码已完全做到”。

### 1.2 你应如何使用这份清单

如果后续要改代码，建议按下面三类理解：

- **A 类：当前仓库已大体具备**
  - 这些内容与当前 repo 的大方向一致，可作为现状认知基础
- **B 类：设计已定，但当前实现可能未跟上**
  - 后续实现需要以这里为目标，不应再回头参考旧语义
- **C 类：设计刚被临时改定，需要实现前再次核对**
  - 这些通常是本轮对话中新拍板的地方，最需要后续改代码时逐项核对

---

## 2. Reminder 相关改动

### 2.1 Reminder 不是 durable 消息，而是 projection artifact

- **状态**：A 类（当前仓库方向已基本一致）
- **含义**：
  - reminder 不写回宿主 session history
  - reminder 从 canonical history 持续计算得到
  - 相同 history 导出相同 reminder 位置

### 2.2 Reminder token 口径改定为“潜在可压 token”

- **状态**：B 类（当前实现可能未完全一致）
- **本轮新定规则**：
  - 只统计 `visibleState === "compressible"` 的消息 token
  - `system` 与受保护的短 `user` 不计入
  - `tool` 计入
- **原因**：用户明确纠正了“system 30k + 其余 5k 但没有可压消息时不应触发 reminder”的例子

### 2.3 Reminder 重复 cadence 仍然存在，但改成按 token 字段表达

- **状态**：C 类（本轮临时重新定下，当前实现很可能未跟上）
- **本轮新定规则**：
  - reminder 仍然有重复 cadence
  - 但不再用旧的 `counter.source` / `counter.*.repeatEvery`
  - 新设计字段是：
    - `reminder.softRepeatEveryTokens`
    - `reminder.hardRepeatEveryTokens`
- **意义**：
  - 首次 soft 触发：`hsoft`
  - soft 区间每增加 `softRepeatEveryTokens` 再提醒
  - 首次 hard 触发：`hhard`
  - hard 区间每增加 `hardRepeatEveryTokens` 再提醒

### 2.4 `counter.source` 从现行设计中移除

- **状态**：C 类
- **本轮新定规则**：
  - `counter.source` 不再属于当前权威配置面
  - reminder 不允许再回到“按消息数”或“按 assistant turn 数”计算 cadence 的旧语义

### 2.5 Reminder prompt 改成 4 份文件

- **状态**：C 类
- **本轮新定规则**：
  - 不是 2 份，而是 4 份
  - 维度：severity × `allowDelete`
  - 文件名：
    - `prompts/reminder-soft-compact-only.md`
    - `prompts/reminder-soft-delete-allowed.md`
    - `prompts/reminder-hard-compact-only.md`
    - `prompts/reminder-hard-delete-allowed.md`
- **补充**：
  - reminder prompt 是纯文本，不是模板
  - `compaction.md` 才是模板

---

## 3. allowDelete / 删除路径相关改动

### 3.1 用 `allowDelete` 取代旧 `route` 语义中心

- **状态**：C 类
- **本轮新定规则**：
  - 不再把 keep/delete 当成 route 枚举来理解
  - 改为 `allowDelete: boolean`
  - 这是局部语义位，不是根级 runtime route

### 3.2 `allowDelete=true` 必须是完整支持路径

- **状态**：C 类
- **本轮新定规则**：
  - 不能再写成“未来再说”或“未实现就 fail-fast”的目标设计
  - 文档层必须把它定义成正式支持能力

### 3.3 `allowDelete=true` 下的两种合法结果

- **状态**：C 类
- **本轮新定规则**：
  1. 普通压缩
     - 生成 replacement
     - 留下可引用压缩块
     - 后续仍可走删除路径
  2. 直接删除
     - 生成删除型结果
     - projection 中移除原跨度
     - 只留极简 delete notice

### 3.4 `allowDelete=false` 的约束

- **状态**：C 类
- **本轮新定规则**：
  - 允许普通压缩
  - 不允许删除
  - 压缩后内容不能再次压缩，也不能删除

---

## 4. Visible ID / 渲染契约相关改动

### 4.1 metadata 中保存 bare canonical visible id

- **状态**：B/C 类（和后续 4/2 决策一致，但当前实现未必完全对齐）
- **本轮文档定法**：
  - metadata 中保存 bare id，例如：
    - `000001_q7`
    - `000002_m2`
  - 最终模型可见文本在单一出口渲染

### 4.2 single-exit 三态前缀渲染

- **状态**：C 类（文档已迁，当前实现未必完全做到）
- **本轮文档定法**：
  - 最终模型可见前缀使用：
    - `protected`
    - `referable`
    - `compressible`
  - 不再把 role 前缀当成最终权威展示层

### 4.3 tool-only turn 的 assistant shell 规则

- **状态**：C 类
- **本轮新定规则**：
  - assistant 有正文 → id 直接放到正文最前
  - assistant 没正文、只有 tool 调用 → 才补一条只含 id 的 assistant 壳
  - 不再写 `Calling <tool>` 之类说明文字

### 4.4 tool result 的 msg id 规则

- **状态**：C 类
- **本轮新定规则**：
  - 每个工具结果各自有独立 msg id
  - 直接插到最前面
  - 如果是数组型结果，把 id 插到第一个 text item

### 4.5 compact 的序号规则

- **状态**：C 类
- **本轮新定规则**：
  - compact 的 visible id 序号取被压缩消息的最小值

### 4.6 reminder 不写消息序号

- **状态**：C 类
- **本轮新定规则**：
  - reminder 在消息层不携带序号
  - 如果数据库需要，可在数据库里保存 reminder 相关编号

---

## 5. Replacement / Canonical Source 相关改动

### 5.1 Canonical Source 的语义约束里改用 `allowDelete`

- **状态**：C 类
- **本轮新定规则**：
  - canonical source 结构中不再用 `route`
  - 改用：
    - `allowDelete`
    - `policy version`

### 5.2 Replacement 多命中时改为取最后一条（按最后时间）

- **状态**：C 类（刚刚新增）
- **本轮新定规则**：
  - 不再取第一条
  - 改为：**取最后一条（按最后时间）**

### 5.3 Source 校验失败不替换

- **状态**：A/B 类
- **含义**：
  - 如果 source 不完整、顺序不一致、版本不匹配、`allowDelete`/policy 冲突
  - 则不替换

---

## 6. Prompt / 模板相关改动

### 6.1 reminder prompt 不再要求模板变量

- **状态**：B 类（与 2026-04-04 reminder prompt 决策一致）
- **本轮确认规则**：
  - reminder prompt 是纯文本
  - 不需要 `{{compressible_content}}` 等变量

### 6.2 compaction prompt 仍然是模板

- **状态**：A/B 类
- **含义**：
  - `compaction.md` 仍然是 system prompt 模板
  - 运行时注入：
    - 删除许可
    - 本次执行模式（普通压缩 / 直接删除）

---

## 7. Debug / 验证相关改动

### 7.1 debug snapshot 的“开关”与“路径”分层

- **状态**：C 类（本轮澄清）
- **本轮确认规则**：
  - “要不要开” 与 “写到哪里” 是两层语义，不冲突
  - 文档里保留路径型字段：
    - `OPENCODE_CONTEXT_COMPRESSION_DEBUG_SNAPSHOT_PATH`
  - 如果后续还保留布尔开关，也应明确它只负责启用，不负责路径

### 7.2 设计文档不是实现完成证明

- **状态**：C 类（本轮新增这份清单的核心动机）
- **含义**：
  - 当前 `DESIGN.md` 里相当一部分是目标设计
  - 尤其是本轮临时拍板的内容，当前代码未必已经做到
  - 实现前必须逐项核对，不应把文档直接当成“现状说明书”

---

## 8. 当前最需要实现前再次核对的项目

以下几项最可能是“文档已定，但当前版本未必已实现”的高风险项：

1. `allowDelete=true` 的完整删除路径
2. `softRepeatEveryTokens` / `hardRepeatEveryTokens` 新配置面
3. 四个 reminder prompt 文件及其加载逻辑
4. visible id 的 single-exit 三态渲染
5. assistant 正文前置 id / tool-only 壳 / per-tool msg id 规则
6. replacement 多命中取最后一条（按最后时间）

---

## 9. 使用建议

后续如果开始改代码，建议按这个顺序做：

1. 先把配置面和 prompt 文件契约落稳
2. 再改 reminder / allowDelete / visible-id 的核心运行时逻辑
3. 最后补测试与文档对齐

不要直接假设当前代码已经遵守本文档中的所有条目。
