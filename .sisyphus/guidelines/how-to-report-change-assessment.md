# 如何汇报改动面评估

## 原则

用户需要的是**决策依据**，不是实现细节。

- 说清楚**核心问题是什么**
- 说清楚**需要改哪些文件**
- 说清楚**为什么要改这些文件**
- 说清楚**风险在哪里**
- 说清楚**最小改动范围**

**不要**：
- 贴代码行号和具体实现逻辑
- 展开每个函数的调用链
- 给出"第一步改这个、第二步改那个"的施工顺序
- 调用子 agent 做深度分析

## 结构模板

```markdown
**改动面评估**

按你的目标：[重述用户目标]

**核心问题**
- [问题 1 的本质]
- [问题 2 的本质]

**需要改的文件（按优先级）**

1. **`path/to/file1.ts`**
   - [为什么要改这个文件]
   - [这个文件在问题链路中的角色]

2. **`path/to/file2.ts`**
   - [为什么要改这个文件]
   - [这个文件在问题链路中的角色]

**改动性质**
- [目标 1]：[改动性质描述]
- [目标 2]：[改动性质描述]

**风险点**
- [风险 1]
- [风险 2]

**最小改动范围**
- 必改：[文件列表]
- 强烈建议：[文件列表]
- 看你原则：[文件列表]
```

## 示例

### 好的汇报

**改动面评估**

按你的两个目标：metadata 完全透传、reasoning 不进 contentText。

**核心问题**
- metadata 在两个地方被裁剪：canonicalization 时只保留 `{id, role}`，transform 输出时统一写死 `agent: "atlas"` 和 `modelID: "projection-replay"`
- reasoning 在 replay 阶段就被合并进 contentText，之后所有依赖 contentText 的地方（visible ID 渲染、分类、压缩输入、token 统计）都会受影响

**需要改的文件（按优先级）**

1. **`src/history/history-replay-reader.ts`**
   - `readCanonicalMessageText()` 目前把 text 和 reasoning 一起拼成 contentText
   - 这是 reasoning 污染的源头

2. **`src/runtime/session-history.ts`**
   - canonicalization 时把 envelope.info 缩成只剩 id/role
   - 对已知 part 类型只保留白名单字段
   - 这是 metadata 丢失的第一道关口

3. **`src/runtime/messages-transform.ts`**
   - transform 输出时统一重建 info，写死 agent/model
   - 对已知 part 类型重建对象，只保留白名单字段
   - 这是 metadata 丢失的第二道关口

4. **`src/token-estimation.ts`**
   - `readEnvelopeText()` 把 reasoning 也算进 token
   - 如果不改，token 统计和 contentText 会不一致

5. **`src/compaction/transport/plugin-client.ts`**
   - `extractContentText()` 把压缩模型返回的 reasoning 也拼进结果
   - 这是独立支线，看你是否要全系统统一

**改动性质**
- reasoning 不进 contentText：逻辑清晰，但会影响所有依赖 contentText 的下游
- metadata 完全透传：需要同时改 canonicalization 和 transform 输出，否则前面保住后面又丢

**风险点**
- 如果 transform 继续统一写 `agent: "atlas"`，那就和"完全透传"冲突；你需要区分 canonical 原消息和 synthetic 消息
- contentText 变短后，所有基于它的测试快照和预期都会变

**最小改动范围**
- 必改：前 3 个文件
- 强烈建议：第 4 个文件
- 看你原则：第 5 个文件

---

### 不好的汇报（避免）

**改动面评估**

我调用了 explore agent 深度分析了代码路径，发现以下问题：

1. `src/runtime/session-history.ts:95` 这里有个 `info: { id: envelope.info.id, role: envelope.info.role }` 的对象字面量，它只保留了两个字段，导致其他字段丢失。我们需要改成 `info: { ...envelope.info }` 来保留所有字段。

2. `src/history/history-replay-reader.ts:199` 的 `readCanonicalMessageText()` 函数里，第 202 行有个 `if (part.type === "text" || part.type === "reasoning")` 的条件判断，这导致 reasoning 被合并进 contentText。我们需要把这个条件改成只检查 `part.type === "text"`。

3. 然后在 `src/runtime/messages-transform.ts:213` 开始的 for 循环里，每个 part 类型都是手工构造的新对象...

[继续展开 10 段实现细节]

**实施步骤**
1. 第一步：修改 `readCanonicalMessageText()`
2. 第二步：修改 `collectReplayableEntries()`
3. 第三步：修改 `projectProjectionToEnvelopes()`
...

---

## 关键区别

| 好的汇报 | 不好的汇报 |
|---------|----------|
| 说"这是 reasoning 污染的源头" | 说"第 202 行有个 if 条件判断" |
| 说"metadata 在两个地方被裁剪" | 说"line 95 有个对象字面量只保留两个字段" |
| 说"需要区分 canonical 和 synthetic 消息" | 说"需要把 agent: 'atlas' 改成条件判断" |
| 按优先级列文件 | 按施工顺序列步骤 |
| 说清楚风险和最小范围 | 展开所有实现细节 |

## 核心要点

1. **用户关心的是"改动面有多大"，不是"怎么改"**
2. **说清楚"为什么要改"比"改哪一行"更重要**
3. **保持高层次抽象，让用户能快速判断代价和风险**
4. **如果用户需要细节，他会追问；不要一次性倾倒所有信息**
