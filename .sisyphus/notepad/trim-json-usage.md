# JSON Log 读取最佳实践

## 问题
直接读取大型 JSON debug snapshot 会污染上下文窗口。

## 解决方案
使用 `/root/_/opencode/opencode-context-compression/scripts/trim-json.ts` 工具。

## 用法
```bash
cd /root/_/opencode/opencode-context-compression
npx tsx scripts/trim-json.ts <json-file> [max-length] 2>/dev/null | jq '<filter>'
```

## 示例
```bash
# 读取前 15 条消息
npx tsx scripts/trim-json.ts logs/debug-snapshots/ses_xxx.out.json 100 2>/dev/null | jq '.messages[0:15] | .[] | {seq: .info.time.created, id: .info.id, role: .info.role, text: (.parts[0].text // "")}'

# 检查消息结构
npx tsx scripts/trim-json.ts logs/debug-snapshots/ses_xxx.out.json 100 2>/dev/null | jq '.messages[5] | {seq: .info.time.created, parts: [.parts[] | {type: .type}]}'
```

## 注意
- 总是使用 `2>/dev/null` 抑制统计信息
- 使用 `jq` 进一步过滤输出
- 默认 max-length 是 150，建议使用 100
