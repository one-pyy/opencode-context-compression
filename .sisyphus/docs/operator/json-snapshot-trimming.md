# 调试快照 JSON 的安全读取方法（已实现）

## 文档定位

本文档承接旧 `.sisyphus/notepad/trim-json-usage.md` 的正式落点，说明如何在不污染上下文的前提下读取大型 JSON 调试快照。

## 问题

调试输出中的 JSON 快照往往很大，直接整体读取容易造成：

- 上下文污染
- 关键信息淹没
- 调试效率下降

## 推荐方法

使用仓库内脚本：

- `scripts/trim-json.ts`

该脚本可以先截断和提炼结构，再配合 `jq` 做局部观察。

## 运行方式

在仓库根目录执行：

```bash
npx tsx scripts/trim-json.ts <json-file> [max-length] 2>/dev/null | jq '<filter>'
```

## 示例

### 查看前 15 条消息

```bash
npx tsx scripts/trim-json.ts logs/debug-snapshots/ses_xxx.out.json 100 2>/dev/null | jq '.messages[0:15] | .[] | {seq: .info.time.created, id: .info.id, role: .info.role, text: (.parts[0].text // "")}'
```

### 检查某条消息的结构

```bash
npx tsx scripts/trim-json.ts logs/debug-snapshots/ses_xxx.out.json 100 2>/dev/null | jq '.messages[5] | {seq: .info.time.created, parts: [.parts[] | {type: .type}]}'
```

## 适用场景

- 调试 projection 输出
- 查看宿主消息结构
- 只想读局部 message / parts 信息
- 调试日志很大，不适合整体塞入上下文

## 相关文档

- `../architecture/system-overview.md`
- `../prompting/compaction-prompt-evaluation.md`
