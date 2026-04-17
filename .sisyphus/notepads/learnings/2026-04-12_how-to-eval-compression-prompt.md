# 教程：如何测试与评估 Compaction Prompt 的压缩质量

**日期:** 2026-04-12
**上下文:** 在调整 `prompts/compaction.md` 时，如何利用测试脚本量化和定性地评估大模型的压缩质量。

## 1. 核心评估工具：`scripts/eval-prompt.ts`
该脚本会自动读取真实的会话数据，在其中随机注入 `<opaque slot="Sx">` 标签，发送给 LLM 进行压缩，并最终验证标签的存活率和压缩质量。

**运行方式：**
```bash
EVAL_CONCURRENCY=10 npx ts-node scripts/eval-prompt.ts
```

## 2. 评估的两个维度

测试 Prompt 质量不能只看“是否跑通”，需要结合**机器指标**和**人工抽检**两个维度：

### A. 机器硬指标 (Quantitative)
脚本会自动输出以下硬指标：
- **Success Rate (成功率)**：LLM 输出的压缩文本中，是否 100% 保留了注入的所有 `<opaque>` 标签。
  - **避坑指南**：早期脚本要求标签必须严格按原始时间线顺序出现。但这过于严苛（模型可能会在总结时进行逻辑归类）。目前的脚本已改为**全局顺序无关校验**，只要标签存在即算成功。
- **Compression Rate (压缩率)**：`(输出长度 / 输入长度) * 100%`。
  - **过低（> 50%）**：说明模型在“偷懒”，发生了**格式退化（Format Regurgitation）**，即直接把原始的 JSON 工具调用（如 `[Tool Use: read] {...}`）原样照抄出来，而不是进行归纳总结。
  - **过高（< 5%）**：需要警惕是否丢失了硬数据（如文件名、行号等）。

### B. 人工质量抽检 (Qualitative)
**千万不要盲目追求 100% 的成功率！** 即使标签全在，如果模型写出“这里是一些工具调用”，那也是一次彻底失败的压缩。

每次修改 Prompt 后，务必去查看 `logs/eval-successes.json` 文件，进行人工走查：
1. **检查“Zero Data Loss”**：模型是否提取出了具体的变量名、环境配置（如 `OPENCODE_CONTEXT_COMPRESSION_`）、阈值数字（如 `20000`）和测试命令？
2. **检查自然语言流畅度**：模型是否将繁杂的 `[Tool Use: ...]` 转化为了流畅的描述（例如：“Searched alternative directory”, “Refined search”）？
3. **检查对约束的服从**：比如我们在 Prompt 中加入了 `NO JSON REGURGITATION` 规则，就需要去日志中 `grep` 看看输出里是否还有成块的 JSON 代码。

## 3. 测试调优参数

在调试 `eval-prompt.ts` 时，你可以根据需求修改代码中的参数：
- **测试样本量**：修改 `generateEvalCases(conversations, 20)` 来控制跑多少个 Case。日常快速验证可设为 20，全量回归设为 50-100。
- **上下文长度**：修改 `Math.floor(Math.random() * 60) + 20`。
  - 测试**深度压缩能力**（去噪能力）：可以把上限调高到 100+ 条消息。你会发现长上下文往往能压出 `< 10%` 的惊人压缩率。
  - 测试**高密度约束能力**（不丢标签）：调短消息数量（如 10 条），但密集注入 5-8 个标签，观察模型在局促空间下如何连接这些标签（通常会出现“迷宫寻宝”式的流水账，这属于正确行为）。
- **API 超时配置**：长上下文生成 `<analysis>` 块需要较多时间，运行时如果出现 fetch failed，可在调用工具时增加 timeout 限制。

## 4. 常见问题排查 (Troubleshooting)

- **Failed 且 Missing Slots**：去 `logs/eval-failures.json` 看。通常是因为模型为了“总结”，觉得某两段代码逻辑重复，就擅自把其中的 `<opaque>` 块给丢弃了。这时需要在 Prompt 中继续加强“FATAL ERROR”的警告。
- **压缩率居高不下**：检查是否出现了 `Format Regurgitation`。如果有，请在 Prompt 的 `Anti-Over-Compression` 章节中强化 `DO NOT regurgitate or copy the raw JSON tool formats` 规则。