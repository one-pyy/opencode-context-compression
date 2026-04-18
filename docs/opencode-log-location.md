# OpenCode 日志位置

## 主日志目录

```
/root/.local/share/opencode/log/
```

## 日志文件命名规则

格式：`YYYY-MM-DDTHHMISS.log`

例如：`2026-04-17T155035.log`

## 查看日志

```bash
# 查看最新日志
ls -lht /root/.local/share/opencode/log/ | head -5

# 查看当前运行的 OpenCode 进程打开的日志文件
lsof -p $(pgrep opencode | head -1) 2>/dev/null | grep -E '\.log|\.jsonl'

# 搜索特定会话
grep -i "ses_xxx" /root/.local/share/opencode/log/*.log

# 查看错误
grep -E "error|ERROR|fail|FAIL" /root/.local/share/opencode/log/2026-04-17T*.log | tail -50

# 实时监控最新日志
tail -f /root/.local/share/opencode/log/$(ls -t /root/.local/share/opencode/log/ | head -1)
```

## 日志级别

- INFO: 正常操作
- WARN: 警告（不影响功能）
- ERROR: 错误（可能影响功能）

## 常见日志模式

### 会话创建
```
service=session id=ses_xxx slug=xxx version=xxx created
```

### 消息处理
```
service=session.processor sessionID=ses_xxx messageID=msg_xxx process
```

### LLM 调用
```
service=llm providerID=xxx modelID=xxx sessionID=ses_xxx stream
```

### 插件加载
```
service=plugin path=xxx loading plugin
```

### 插件错误
```
service=plugin path=xxx error=xxx failed to load
```

## 数据库位置

```
/root/.local/share/opencode/opencode.db
```

## 会话数据库位置

插件的会话数据库通常在插件目录下的 `state/` 目录：

```
/root/_/opencode/opencode-context-compression/state/ses_xxx.db
```
