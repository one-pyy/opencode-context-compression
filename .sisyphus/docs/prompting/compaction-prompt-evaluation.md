# Compaction Prompt 评估方法（已实现）

## 文档定位

本文档承接旧 `notepads/learnings/2026-04-12_how-to-eval-compression-prompt.md` 的正式落点，说明如何评估 `prompts/compaction.md` 的压缩质量。

## 核心边界

- `prompts/compaction.md` 是运行时真实使用的 system prompt 资产
- 本文档只描述其评估方法，不替代该 prompt 文件本身

## 核心工具

使用：

- `scripts/eval-prompt.ts`

它会读取真实会话数据、注入 `<opaque slot="Sx">` 标签、调用模型执行压缩，并检查标签保留率与输出质量。

## 运行方式

```bash
EVAL_CONCURRENCY=10 npx ts-node scripts/eval-prompt.ts
```

## 两类评估维度

### 1. 机器指标

- **Success Rate**
  - 检查所有 `<opaque>` 标签是否被保留
- **Compression Rate**
  - 检查输出是否真正被压缩，而不是原样回吐

### 2. 人工抽检

仅靠标签保留率不够，还要检查：

- 是否保留了关键变量名、路径、阈值、命令
- 是否避免大段 JSON regurgitation
- 是否把原始工具调用格式转成自然语言总结

## 重点风险

### 1. Format Regurgitation

如果输出只是大段复制原始 JSON / tool format，说明 prompt 没有实现真正压缩。

### 2. 假高成功率

即使标签都在，但如果输出失去事实细节，仍然是失败压缩。

### 3. 过度压缩

压缩率过高时，需要警惕丢失硬数据。

## 调参方向

- 调整测试样本数
- 调整上下文长度
- 调整 `<opaque>` 注入密度
- 必要时放宽 API timeout 以适应长上下文与 `<analysis>` 输出

## 建议的检查点

- 查看 `logs/eval-successes.json`
- 查看 `logs/eval-failures.json`
- 搜索输出中是否仍有大段原始 JSON

## 相关文档

- `../architecture/system-overview.md`
- `../operator/json-snapshot-trimming.md`
