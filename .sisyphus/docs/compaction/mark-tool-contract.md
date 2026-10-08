# 压缩工具公共契约（已实现）

## 文档定位

本文档描述 `compression_mark` 与 `compression_inspect` 的职责、输入输出与 replay 入口语义。

## 职责边界

`compression_mark` 只负责打 tag / mark：

- 不负责压缩执行
- 不负责调度
- 不负责 prompt projection

`compression_inspect` 只负责请求查看当前可见范围内尚未被压缩结果覆盖的 compressible 消息 token 情况：

- 不负责计算 token
- 不负责读取 sidecar
- 不负责压缩执行或调度

## 工具契约

- `mode` 是 `"compact" | "delete"`
- `from` 与 `to` 来自当前 projected visible view
- `from` 与 `to` 是双闭区间端点，端点消息自身也包含在目标范围内
- `from` 与 `to` 解析到目标范围：宿主消息端点按 `seq6 + base62` 定位；`referable` 区间标记必须唯一匹配当前结果组的片段标记，再按 `seq6` 解析到它覆盖的来源消息，可直接用于跨已压缩范围选区。两种端点都必须完整覆盖范围内的摘要片段
- `from` 与 `to` 的书写形态是 `<visible-type>_<seq6>_<base62>`；replay 不把 `visible-type` 当作长期身份字段：宿主消息端点按稳定的 `seq6 + base62` 定位，`referable` 端点先按标记 id 匹配当前结果组、再按 `seq6` 定位。身份层规则见 [visible id 系统](../projection/visible-id-system.md#mark-端点匹配规则)
- 端点无法解析到宿主消息、或 `referable` 端点匹配不到当前结果组片段（含过期与多义）时，该次调用不创建 mark，并按失败结果呈现
- 成功调用时立即返回随机 `mark id`
- `mode=delete` 且当前策略不允许 delete 时，返回错误结果
- 主 agent 使用 delete 须遵循 [退役执行准则](allow-delete.md#退役执行准则)，按后续是否有用自主选区；普通 reminder 和 cpmark 对未压缩原文使用 compact，附带退役指令时另行检查已应用摘要。
- `mode=delete` 的目标范围可包含用户消息；是否从投影移除用户原文由 [删除契约](allow-delete.md#目标与保留标准) 定义，不由 `smallUserMessageThreshold` 单独决定

## Inspect 工具契约

- `compression_inspect` 输入为 `{ to, mode?, mergeAdjacent? }`；`mode` 缺省为 `"compact"`，`mergeAdjacent` 缺省为 `true`
- 工具调用当下只返回 `inspectId` 占位结果
- 后续 `messages.transform` 使用当前 `ProjectionState.messagePolicies` 中已经计算出的 `tokenCount` 生成真实结果
- compact 模式下，inspect 范围从当前投影中的首个 compressible 消息开始，到 `to` 端点结束，端点消息包含在范围内
- delete 模式下，inspect 范围从当前投影中的首个非 system 可见条目开始，到 `to` 端点结束；这样开头就存在的摘要片段与短用户消息不会被漏掉。`mergeAdjacent` 在 delete 模式下不生效
- `mergeAdjacent=true` 时，真实结果返回两级结构：referable replacement 切分外层 `sections`，protected 消息在 section 内切分连续 compressible `atoms`
- 每个 atom 返回起止 visible id 与 token 数；atom id 省略 `compressible_` 前缀，形如 `<seq6>_<base62>`，因为 atom 按定义都是 compressible。每个 section 返回首尾 atom 的 visible id、`atomCount` 与 atom token 总数；`atomCount=1` 时省略 `atoms` 字段，避免重复范围
- sections 按 `totalTokens` 降序排列；`tokens <= 0` 的 compressible 消息不生成 atom；顶层同时返回所有 section 的 token 总数
- `mergeAdjacent=false` 时，真实结果保留按消息顺序排列的明细：`[{"id":"compressible_...","tokens":123}]`
- compact 模式下，结果只描述当前投影中仍可见的 compressible 消息；已应用压缩结果只作为 section 边界出现，不作为条目返回。因此“未出现在结果中”不代表该范围不在窗口内或不可删除
- `compression_inspect` 的 `to` 端点按 `seq6` 定位，`referable` 区间 id 可以用于 inspect；mark 的端点规则见 [工具契约](#工具契约)
- sections / atoms 只提供确定性的范围与计数结构，不判断内容是否已完成，也不构成自动 mark 建议；语义选择由调用模型完成

推荐按任务或主题跨 inspect 分段选取符合条件的连续范围，减少标记调用往返；统计分段不决定 mark 边界。成功但尚未应用的标记视为已处理，避免重复覆盖；已应用 compact 可以完整纳入更大选区。涉及摘要时须完整覆盖片段，delete 还须满足下方的标记包含规则；活跃细节、区间冲突或输入预算需要时才拆段。hint 指定范围内的关键保留项，不替代选区准入和信息留存检查。

`mode="delete"` 时，真实结果改为按位置顺序返回 delete 选区的可选项清单：

```json
{
  "ok": true,
  "mode": "delete",
  "entries": [
    { "kind": "fragment", "from": "referable_000002_wq", "to": "referable_000004_wq", "tokens": 1200 },
    { "kind": "user", "from": "000005_y9", "to": "000005_y9", "tokens": 0 },
    { "kind": "compressible", "from": "000012_ab", "to": "000020_cd", "tokens": 1234 }
  ],
  "totalTokens": 2434
}
```

- `kind=fragment`：当前投影中已应用的 compact 摘要片段，`from` 与 `to` 是该片段的 `referable` 区间标记，可直接作为 `compression_mark` 端点。这是唯一保留 `referable_` 前缀的条目类型，因为只有该类型会走片段标记解析路径
- `kind=user`：范围内被分类为 protected 的用户消息，`from` 与 `to` 相同且为宿主消息 id，省略 `protected_` 前缀。compressible 的用户消息不重复列出，它们已进入 `kind=compressible` 条目
- `kind=compressible`：范围内连续的 compressible 消息段，`from` 与 `to` 为宿主消息 id，省略 `compressible_` 前缀
- system 消息不进入清单；已被 delete 结果接管的来源不再出现在投影中，因此也不会成为条目
- delete 条目 token 估算当前实际可见文本：`fragment` 报当前摘要，`user` 报用户正文，`compressible` 报当前未压缩文本；`totalTokens` 是清单条目合计。投影预计算每条可见文本并复用同一估算器，短用户消息不因 protected 分类而记为零。compact 模式继续使用 `messagePolicies` 的策略计数。
- delete mode 只展示当前可选的条目，不做 `allowDelete` 准入判断；实际 delete 仍由 `compression_mark` 的 [Admission 规则](allow-delete.md#admission-规则) 拒绝
- reminder 可附带 delete 模式清单供 compact 与摘要退役两项动作使用；调用输入明确携带相同 `mode` 与 `to`。满足所需跨度时直接复用清单，模式与范围不足时再请求 inspect。

compact 模式的 token 数据来自消息级策略；delete 模式复用当前投影文本计数，都不从 mark tree 反推大小：

1. `messagePolicies` 持有 canonical 消息的 `tokenCount`。
2. 最终 projected messages 提供当前可见的 protected / compressible / referable 顺序，已被 replacement 接管的 source 不再作为 compressible 返回。
3. `compression_inspect` 按输入 visible-id 范围读取当前可见结构，再按 `mode` 与 `mergeAdjacent` 决定返回逐消息明细、sections / atoms 或 delete 条目清单。
4. scheduler 则用同一批 message token，按 mark tree range 汇总为 `uncompressedMarkedTokenCount` 后再和自动压缩阈值比较。

因此 inspect 明细之和只有在 inspect 范围与当前待压 mark range 完全一致时，才应等于 scheduler 的 `uncompressedMarkedTokenCount`。

## 成功结果与错误结果的区别

- 成功结果：返回合法 `mark id`，表示创建了可重放的 mark intent
- 错误结果：本次调用没有成功创建 mark；它仍留在历史与最终可见世界里，但不进入 mark 覆盖树
- 确定性失败结果在最终投影中会被改写为 `{"ok":false,"errorCode":"...","message":"...","details":{...}}` 格式的结构化 tool result，保留原始错误码、具体失败原因与可定位的失败详情
- 已 accepted 但暂无 pending / result 的 mark 仍是正常悬挂状态，不属于失败结果

### 标记包含冲突

mark 按调用先后重放。compact 可以被 compact 或 delete 完整包含；delete 不能被任何 mark 包含，即 delete 只能作为覆盖树根节点。相同范围按包含处理，由后来的 mark 作为候选父节点。部分交叉继续按重叠冲突拒绝。

后来的 mark 若包住已有 delete，或后来的 delete 严格落在已有 mark 内部，该后来标记被作为 `OVERLAP_CONFLICT` 排除出覆盖树，工具调用的投影返回改写为结构化错误。先有 compact、后有包含它的 delete 仍允许，前提是范围内没有其他 delete。拒绝发生在修改覆盖树之前，不影响已有合法标记及后续选区的判定。

该规则不依赖压缩结果是否存在或替换是否生效，既有历史标记也按同一规则重放。后台只执行合法覆盖树中的标记，因此被拒绝的标记不再调度；原始宿主历史及已存储结果不被改写，替换只消费合法覆盖树上的结果。

## Mark 与 replacement 的关系

mark 是 lookup hint，不是 source of truth：

1. 重放历史中的合法 mark tool 调用
2. 构造当前有效覆盖树
3. 对树上的当前节点按 mark id 去 SQLite 查询结果组
4. 只有存在完整结果组时才替换该范围

## 最小 lookup 结构

当前最小 replacement lookup 结构是：

- mark id
- 原始消息跨度
- 结果组是否完整

命中条件：

1. 节点在覆盖树中仍合法有效
2. 数据库存在该 mark id 对应结果组
3. 结果组完整

## 相关文档

- `allow-delete.md`
- `compaction-lifecycle.md`
- `../operator/compression-mark-usage.md`
