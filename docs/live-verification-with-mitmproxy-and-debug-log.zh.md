# 使用 mitmproxy、调试日志与 sidecar 观察当前 repo-owned 合同的 live verification

这份文档只描述当前已经验证过的 repo-owned 合同，以及真实会话里可以诚实观察到的现象。它不讲迁移历史，也不把旧 host 工具包装成这份插件的证明路径。

## 1. 先说清楚，今天到底能证明什么

当前可重复、已经自动化覆盖的证明边界是：

1. `tests/cutover/runtime-config-precedence.test.ts` 证明仓库自有的 `src/config/runtime-config.json`、`prompts/compaction.md`、日志路径和环境变量优先级契约成立。
2. `tests/cutover/legacy-independence.test.ts` 证明规范插件合同不依赖旧 runtime、旧工具名或旧 provider-side DCP 字段。
3. `tests/cutover/docs-and-notepad-contract.test.ts` 证明 README、中文 README、这份 live verification 指南，以及目标仓库 notepad 记录的是同一份 final repo-owned 合同。
4. `tests/e2e/plugin-loading-and-compaction.test.ts` 与 `tests/e2e/delete-route.test.ts` 证明仓库自有插件入口、`compression_mark`、scheduler seam、keep 与 delete 提交路径在注入 safe transport fixture 时可以稳定工作。

当前**没有**被这份文档声称已经证明的内容：

- 真实会话里，靠宿主当前暴露的 legacy DCP 工具，就已经能为这个插件提供 keep 与 delete 的端到端证明。
- 这个仓库已经自带默认生产 compaction executor transport。

换句话说，真实会话里的 live verification 目前适合确认“插件确实加载了，副作用确实落在 repo-owned 路径里”，而完整 keep 与 delete 成功路径仍以仓库自动化测试为准。

## 2. 当前 repo-owned 路径

做任何 live verification 之前，先对齐你要看的路径：

### 2.1 插件入口与规范资源

- 插件入口：`/root/_/opencode/opencode-context-compression/src/index.ts`
- 规范运行时配置：`/root/_/opencode/opencode-context-compression/src/config/runtime-config.json`
- 规范提示词：`/root/_/opencode/opencode-context-compression/prompts/compaction.md`

### 2.2 仓库自有日志与调试路径

- 运行时日志：`/root/_/opencode/opencode-context-compression/logs/runtime-events.jsonl`
- seam 观测日志：`/root/_/opencode/opencode-context-compression/logs/seam-observation.jsonl`
- 调试快照路径由 `OPENCODE_CONTEXT_COMPRESSION_DEBUG_SNAPSHOT_PATH` 显式控制

### 2.3 会话级状态路径

- 侧车数据库：`state/<session-id>.db`
- 实时锁：`locks/<session-id>.lock`

这些会话级状态默认按插件目录相对路径写入。为了减少判断成本，建议直接在仓库根目录 `/root/_/opencode/opencode-context-compression` 里完成这次 live verification。

### 2.4 mitmproxy

- 监听地址：`127.0.0.1:41641`
- 配置文件：`~/.mitmproxy/config.yaml`

mitmproxy 在这里是辅助观察面，不是替代 SQLite、seam 日志或自动化测试的单一真相源。

## 3. 先跑自动化证明，再看真实会话

在仓库根目录执行：

```bash
npm run typecheck
node --import tsx --test tests/cutover/runtime-config-precedence.test.ts
node --import tsx --test tests/cutover/legacy-independence.test.ts
node --import tsx --test tests/cutover/docs-and-notepad-contract.test.ts
```

如果你还想把 keep 与 delete 的已提交路径一起跑一遍，再加上：

```bash
node --import tsx --test tests/e2e/plugin-loading-and-compaction.test.ts
node --import tsx --test tests/e2e/delete-route.test.ts
```

这里有个关键真相边界必须保留：上述 e2e 成功路径依赖注入的 safe transport fixture。它们证明的是 repo-owned 插件入口、`compression_mark`、scheduler seam、锁语义、SQLite 提交和投射路径成立，不等于仓库已经提供默认生产 executor。

## 4. 真实会话里现在适合观察什么

### 4.1 显式加载插件，并禁用竞争压缩路径

确认 `/root/_/opencode/config/opencode.jsonc` 里显式加载了：

```jsonc
{
  "plugin": [
    "/root/_/opencode/opencode-context-compression/src/index.ts"
  ],
  "compaction": {
    "auto": false,
    "prune": false
  }
}
```

还要确认当前 profile 没有别的 transform 或 compaction 插件在同时改写消息，否则 sidecar、锁、日志和代理流量都可能混线。

### 4.2 先跑 seam probe，拿最低成本硬证据

```bash
npm run probe:seams
```

预期至少能在 `logs/seam-observation.jsonl` 里看到：

- `chat.params`
- `experimental.chat.messages.transform`
- `tool.execute.before`
- `pluginInit.directory`
- `pluginInit.worktree`

这一步通过，说明插件入口加载和关键 seam 观测是活的。

### 4.3 进入真实会话后，优先确认 sidecar 与 host history 同步

在真实会话里完成至少一轮普通交互后，先看文件系统：

```bash
ls -lt "/root/_/opencode/opencode-context-compression/state"
ls -lt "/root/_/opencode/opencode-context-compression/locks"
```

再看 SQLite：

```bash
sqlite3 "/root/_/opencode/opencode-context-compression/state/<session-id>.db" ".tables"
sqlite3 "/root/_/opencode/opencode-context-compression/state/<session-id>.db" "SELECT host_message_id, canonical_present FROM host_messages ORDER BY first_seen_at_ms DESC LIMIT 10;"
sqlite3 "/root/_/opencode/opencode-context-compression/state/<session-id>.db" "SELECT observed_state, note FROM runtime_gate_audit ORDER BY observed_at_ms DESC LIMIT 10;"
```

现在这个阶段，最值得确认的是：

- 当前会话对应的 sidecar DB 已创建
- `host_messages` 已同步本次真实会话消息
- seam 日志与 SQLite 时间线能对上

这已经足够证明真实插件确实加载，并且 repo-owned sidecar 路径是活的。

### 4.4 锁与网络观察，只能按当前真相边界解释

如果你正在观察锁文件或 mitmproxy，请把结论限制在“观察到了什么”，不要往未证明的成功路径外推。

可接受的当前解释方式：

- `locks/<session-id>.lock` 的出现和消失，可以用来观察实时门控是否活跃
- mitmproxy 可以帮助你确认某个时间窗口里确实发生了与压缩相关的外部模型请求
- 这些外部观察必须和 `logs/seam-observation.jsonl`、`state/<session-id>.db` 一起对齐才有意义

当前不可接受的外推方式：

- 只因为代理里有模型流量，就断言 keep 或 delete 已经通过真实会话证明
- 只因为某个 host tool 返回成功，就断言它走的是这份 repo-owned 插件的最终合同
- 只因为锁文件消失，就断言批次成功完成

## 5. 当前 PASS 和 FAIL 应该怎么判

### 当前可以判 PASS 的内容

满足以下几项，就可以说“当前 repo-owned live surfaces 已通过”：

1. 显式插件入口正确，且 OpenCode 已重启
2. `npm run probe:seams` 写出了新的 `logs/seam-observation.jsonl`
3. seam 日志包含 `chat.params`、`experimental.chat.messages.transform`、`tool.execute.before`
4. 真实会话创建了新的 `state/<session-id>.db`
5. `host_messages` 出现了本次会话对应的新行
6. 上面的 cutover 自动化测试全部通过

### 当前必须判 FAIL 或未完成的内容

出现下面任意一种情况，就不要把结论往前硬推：

- seam probe 没有留下关键 seam
- 真实会话没有 sidecar DB，或者只有空壳没有本次会话痕迹
- 你只能依赖代理流量猜测插件是否真正进入了 repo-owned 逻辑
- 你试图把宿主当前暴露的 legacy DCP 工具当成 keep 或 delete 的证明驱动
- 你试图把“锁没了”直接解释为成功

## 6. mitmproxy 在这里的正确定位

如果系统上还没有正在监听的实例，可以启动：

```bash
mitmproxy --listen-host 127.0.0.1 --listen-port 41641
```

这一步的正确用法是：

1. 先记录一个你即将进行真实会话操作的时间点
2. 再对齐 `logs/seam-observation.jsonl`
3. 最后到 SQLite 里确认同一时间窗口是否真的发生了 sidecar 变化

只有三者对齐，代理观察才有解释力。任何单独一面都不应被当成“完整 keep 与 delete 已在真实会话证明”的依据。

## 7. 这份文档未来什么时候该更新

只有在下面任意一项真的被实现并自动化证明后，才应该扩展这份文档的成功口径：

- 仓库新增了默认生产 compaction executor transport，并有对应自动化证明
- 真实会话存在 repo-owned 的最终执行路径，能在不借助 legacy host 工具的前提下稳定产出 keep 与 delete 结果

在那之前，这份文档的职责就是守住真相边界，不把“插件已加载”误写成“真实会话完整 keep 与 delete 已被证明”。
