# 使用 mitmproxy、调试日志、seam probe 与运行时副作用进行 live verification

本文只服务一个目标，确认 `/root/_/opencode/opencode-context-compression/src/index.ts` 这条插件入口在本机真实加载，且它的关键行为和副作用符合仓库当前实现。重点不是讲架构历史，而是让操作员能从配置、日志、SQLite、锁文件、代理观察这五个面，判断这次 live verification 到底过没过。

## 1. 通过标准，先看结论

只有同时满足下面几点，才算这次验证通过：

1. `/root/_/opencode/config/opencode.jsonc` 中明确加载了插件入口，并且重启后的 OpenCode 确实使用了这份配置。
2. `npm run probe:seams` 能写出新的 `logs/seam-observation.jsonl`，并且至少能看到 `chat.params`、`experimental.chat.messages.transform`、`tool.execute.before` 三个 seam。
3. 在真实会话里能看到新的 `state/<session-id>.db`，而且 `host_messages`、`marks`、`compaction_batches`、`replacements` 等表里有本次验证对应的数据。
4. 触发压缩时会出现 `locks/<session-id>.lock`，普通聊天会等待，非压缩工具不会被一刀切阻塞。
5. `route=keep` 和 `route=delete` 都能留下已提交的 replacement 记录，并且投射结果与各自语义一致。
6. 在相同规范历史没有变化时，投射结果重复执行仍然稳定，不会每次都变样。
7. mitmproxy 观察到的传输行为，与 SQLite 和 seam 日志看到的副作用一致，没有把压缩偷偷走成普通 `session.prompt` 污染路径。

只要有任意一项缺失、互相矛盾，或者只能靠猜测补结论，这次验证就应该判定为失败或至少未完成。

## 2. 本机上的真实路径

这次验证会直接用到下面这些真实路径。

### 2.1 OpenCode 配置与插件入口

- 当前真实配置文件：`/root/_/opencode/config/opencode.jsonc`
- 当前插件入口：`/root/_/opencode/opencode-context-compression/src/index.ts`
- seam probe 临时配置：`/root/_/opencode/opencode-context-compression/.tmp/opencode-config/opencode.json`

建议先确认全局配置至少满足下面这两个条件，然后重启 OpenCode：

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

### 2.2 运行时副作用路径

当你把 live verification 的工作目录放在仓库根目录 `/root/_/opencode/opencode-context-compression` 时，最容易观察，所有关键副作用都会集中在这里：

- seam 日志：`/root/_/opencode/opencode-context-compression/logs/seam-observation.jsonl`
- SQLite 侧车：`/root/_/opencode/opencode-context-compression/state/<session-id>.db`
- 实时锁文件：`/root/_/opencode/opencode-context-compression/locks/<session-id>.lock`

一个非常重要的细节：

- `logs/seam-observation.jsonl` 默认跟插件源码仓库走。
- `state/<session-id>.db` 和 `locks/<session-id>.lock` 跟插件运行时拿到的 `ctx.directory` 走。

所以，**如果你在别的项目目录里启动 OpenCode，会话级的 `state/` 和 `locks/` 可能出现在那个项目目录下，而不是这个插件仓库下。**

为了减少判断成本，推荐这次 live verification 直接在仓库根目录里启动 OpenCode。

### 2.3 mitmproxy

- 现成配置文件：`~/.mitmproxy/config.yaml`
- 当前监听地址：`127.0.0.1:41641`
- 当前上游转发：本机 clash

也就是说，这台机器已经把 mitmproxy 当成一个真实可用的观察面，而不是纸上选项。

## 3. 开始前准备

### 3.1 先清掉竞争路径

这个插件假设它是会话里唯一的压缩系统。开始前请确认以下路径没有跟它同时改写提示词或会话历史：

- `opencode-dcp-fork`
- `@tarquinen/opencode-dcp`
- 任何会重写 transcript、注入 replacement、自动总结、自动 prune 的插件
- OpenCode 原生自动压缩，要求 `compaction.auto=false`、`compaction.prune=false`

如果你不先做这一步，后面看到的 replacement、锁恢复、日志内容都可能混线，结论没有参考价值。

### 3.2 不要先删旧文件，先记住时间戳

推荐这样做，而不是直接删 `state/`、`locks/`、`logs/`：

```bash
ls -lt "/root/_/opencode/opencode-context-compression/logs" "/root/_/opencode/opencode-context-compression/state" "/root/_/opencode/opencode-context-compression/locks"
```

理由很简单：

- 旧文件本身可能就是上一次失败的证据。
- 这次验证更应该靠“新时间戳、新 session-id、新 replacement 行”来定位当前运行，而不是靠先清空现场。

### 3.3 推荐先做一轮仓库基线检查

这不是 live verification 的主体，但能先排除明显坏状态：

```bash
npm run typecheck
node --import tsx --test tests/e2e/**/*.test.ts
```

如果这里已经失败，先不要把后面的 live 现象全部归咎于代理、锁或配置。

## 4. 两条主路径，别混用结论

这份验证指南里有两条主路径，结论不能混着算。

### 路径 A，直接插件验证

目标是确认真实插件在真实 OpenCode 会话里有副作用。

你要看的是：

- 会不会创建 sidecar DB
- 会不会写锁文件
- 会不会留下 marks、batches、replacements
- 普通聊天、工具调用、投射结果是否符合当前实现

### 路径 B，mitmproxy 辅助观察

目标不是替代 SQLite 和 seam 日志，而是补一层“这个压缩请求到底有没有污染普通会话传输”的外部观察。

你要看的是：

- 触发压缩时有没有真实的上游模型请求
- 这个请求是否只对应压缩行为，而不是额外制造一个普通用户消息
- 观察结果是否和 seam 日志、SQLite 状态一致

## 5. seam probe，先拿到最便宜的硬证据

`npm run probe:seams` 是这次验证里最快、最稳的一步。它会：

1. 在 `.tmp/opencode-config/` 下写一份临时配置
2. 显式加载 `/root/_/opencode/opencode-context-compression/src/index.ts`
3. 跑一个最小的 `opencode run`
4. 把 seam 观测写到 `logs/seam-observation.jsonl`

执行命令：

```bash
cd /root/_/opencode/opencode-context-compression
npm run probe:seams
```

如需自定义 probe 提示词，可以这样传：

```bash
cd /root/_/opencode/opencode-context-compression
npm run probe:seams -- "Use the read tool on README.md, then reply with exactly OK."
```

检查命令：

```bash
grep -n '"seam":"chat.params"' "/root/_/opencode/opencode-context-compression/logs/seam-observation.jsonl"
grep -n '"seam":"experimental.chat.messages.transform"' "/root/_/opencode/opencode-context-compression/logs/seam-observation.jsonl"
grep -n '"seam":"tool.execute.before"' "/root/_/opencode/opencode-context-compression/logs/seam-observation.jsonl"
grep -n 'pluginInit.directory' "/root/_/opencode/opencode-context-compression/logs/seam-observation.jsonl"
grep -n 'pluginInit.worktree' "/root/_/opencode/opencode-context-compression/logs/seam-observation.jsonl"
```

这一步的预期观察：

- 至少出现一次 `chat.params`
- 至少出现一次 `experimental.chat.messages.transform`
- 至少出现一次 `tool.execute.before`
- `pluginInit.directory` 和 `pluginInit.worktree` 指向你这次实际验证的目录，推荐就是仓库根目录

如果连这一步都拿不到，后面的 live 结果就很难判定是插件未加载，还是只是在错误工作目录里运行。

## 6. 真实会话里的必看副作用

### 6.1 如何找到当前 session-id

在真实 OpenCode 会话里发出第一条请求后，优先用文件系统找当前 session：

```bash
ls -lt "/root/_/opencode/opencode-context-compression/state"
ls -lt "/root/_/opencode/opencode-context-compression/locks"
```

通常最新生成或最近更新时间的 `<session-id>.db`、`<session-id>.lock` 就是本次验证会话。

如果当下没有锁文件，仍然可以先从 DB 文件定位 session，然后在 SQLite 里看最近的批次和 replacement。

### 6.2 先确认 SQLite 侧车确实存在

```bash
sqlite3 "/root/_/opencode/opencode-context-compression/state/<session-id>.db" ".tables"
sqlite3 "/root/_/opencode/opencode-context-compression/state/<session-id>.db" "SELECT host_message_id, canonical_present FROM host_messages ORDER BY first_seen_at_ms DESC LIMIT 10;"
sqlite3 "/root/_/opencode/opencode-context-compression/state/<session-id>.db" "SELECT mark_id, route, status FROM marks ORDER BY created_at_ms DESC LIMIT 10;"
sqlite3 "/root/_/opencode/opencode-context-compression/state/<session-id>.db" "SELECT batch_id, status, frozen_at_ms FROM compaction_batches ORDER BY frozen_at_ms DESC LIMIT 10;"
sqlite3 "/root/_/opencode/opencode-context-compression/state/<session-id>.db" "SELECT replacement_id, route, status, COALESCE(content_text, '') FROM replacements ORDER BY committed_at_ms DESC LIMIT 10;"
sqlite3 "/root/_/opencode/opencode-context-compression/state/<session-id>.db" "SELECT observed_state, note FROM runtime_gate_audit ORDER BY observed_at_ms DESC LIMIT 10;"
```

至少应该能看到这些关键表中的大部分：

- `host_messages`
- `source_snapshots`
- `marks`
- `compaction_batches`
- `compaction_jobs`
- `compaction_job_attempts`
- `replacements`
- `replacement_mark_links`
- `runtime_gate_audit`

如果 DB 根本没创建，或者只有空壳表但没有本次会话对应的行，就不要继续往下推“可能只是代理没抓到”。这更像插件根本没进入真实逻辑。

### 6.3 观察实时锁

触发一次实际压缩时，观察锁文件：

```bash
ls -lt "/root/_/opencode/opencode-context-compression/locks"
grep -n '"status": "running"' "/root/_/opencode/opencode-context-compression/locks/<session-id>.lock"
```

还要配合 SQLite 一起看：

```bash
sqlite3 "/root/_/opencode/opencode-context-compression/state/<session-id>.db" "SELECT batch_id, status, frozen_at_ms FROM compaction_batches ORDER BY frozen_at_ms DESC LIMIT 5;"
sqlite3 "/root/_/opencode/opencode-context-compression/state/<session-id>.db" "SELECT observed_state, started_at_ms, settled_at_ms, note FROM runtime_gate_audit ORDER BY observed_at_ms DESC LIMIT 10;"
```

正确理解方式是：

- 锁文件存在且 `status=running`，表示压缩正在进行
- 终态写进 SQLite 后，锁文件会被移除
- **不能**把“锁没了”直接解释成成功，必须再看对应 batch 的终态

如果锁消失了，但 SQLite 里对应批次仍然是 `running` 或 `frozen`，应该按“手动清除或异常恢复”处理，而不是判成成功。

## 7. 用 mitmproxy 观察传输，不替代内部状态

如果 mitmproxy 还没跑起来，先起它。若系统上已经有一个实例在监听 `127.0.0.1:41641`，复用现有实例即可，不要强行再开第二个：

```bash
mitmproxy --listen-host 127.0.0.1 --listen-port 41641
```

这台机器已有 `~/.mitmproxy/config.yaml`，当前默认会继续转发到本机 clash。你这次主要拿它做两件事：

1. 观察压缩触发时是否真的有外部模型请求
2. 观察这个请求是否和普通会话发送路径混在一起

### mitmproxy 观察时应该盯什么

- 触发压缩的那一刻，应该能看到与模型提供方相关的流量
- 同一时间窗口里，SQLite 里的 `compaction_jobs`、`compaction_job_attempts`、`replacements` 应该同步变化
- 普通聊天不应该因为压缩本身多出一个额外的普通 `role=user` 会话消息副作用

这部分不能只靠肉眼看代理。要把代理时间点和下面这些内部面一起对：

- `logs/seam-observation.jsonl`
- `state/<session-id>.db`
- `locks/<session-id>.lock`

如果 mitmproxy 看到了网络，但 DB 不动、锁不出现、seam 日志没有相应事件，那更像是别的流量，不应算本插件的压缩证据。

## 8. 九项检查清单

下面九项是这次 live verification 的主清单。每一项都包含要做什么、看什么、什么算 PASS、什么算 FAIL。

### 1. 显式插件加载

**怎么做**

- 打开 `/root/_/opencode/config/opencode.jsonc`
- 确认 `plugin` 数组包含 `/root/_/opencode/opencode-context-compression/src/index.ts`
- 确认 `compaction.auto=false`、`compaction.prune=false`
- 修改后重启 OpenCode

**重点观察**

- seam probe 能工作
- 真实会话能生成 sidecar DB 或 seam 记录

**PASS**

- 配置中存在明确插件入口
- 重启后 probe 和真实会话都能看到插件副作用

**FAIL**

- 入口缺失、路径不是这份本地检出、改完没重启、或者只有配置改动但没有任何运行时痕迹

### 2. seam / debug logging

**怎么做**

- 在仓库根目录运行 `npm run probe:seams`
- 必要时，用下面的方式把真实交互会话也写到同一份 seam 日志里：

```bash
cd /root/_/opencode/opencode-context-compression
OPENCODE_CONTEXT_COMPRESSION_SEAM_LOG="/root/_/opencode/opencode-context-compression/logs/seam-observation.jsonl" opencode
```

**重点观察**

- `chat.params`
- `experimental.chat.messages.transform`
- `tool.execute.before`
- `pluginInit.directory`
- `pluginInit.worktree`

**PASS**

- `logs/seam-observation.jsonl` 有新内容
- 三个关键 seam 都出现
- 目录字段与实际验证目录一致

**FAIL**

- 日志文件没更新
- 只出现部分 seam
- 目录字段指向错误目录，或者 JSON 内容明显被截断、无法解析

### 3. sidecar DB 创建与检查

**怎么做**

- 在真实会话里完成至少一轮普通交互
- 找到最新的 `state/<session-id>.db`
- 用 `sqlite3` 查看关键表和最近记录

**重点观察**

- `host_messages` 是否同步
- `marks`、`compaction_batches`、`replacements` 是否随着操作增长
- `runtime_gate_audit` 是否留下锁观察记录

**PASS**

- 当前会话对应的 DB 被创建
- `host_messages` 有本次会话消息
- 后续压缩动作能留下对应 marks、batches、replacements

**FAIL**

- 没有 DB
- DB 只有旧数据，没有本次会话痕迹
- 压缩完成后关键表仍然没有任何新增行

### 4. live lock 行为

**怎么做**

- 触发一次真正的压缩
- 同时观察 `locks/<session-id>.lock` 与 `compaction_batches`

**重点观察**

- 压缩期间锁文件是否存在
- 锁消失后，SQLite 里对应批次是什么终态

**PASS**

- 压缩期间存在 `locks/<session-id>.lock`
- 普通聊天等待这个锁
- 终态落进 SQLite 后锁才消失
- 锁消失后可用 `compaction_batches.status` 判断成功或失败

**FAIL**

- 压缩期间没有锁
- 普通聊天完全不等待
- 锁消失就被误判成成功，但 SQLite 仍然是 `running` 或 `frozen`
- 锁长期残留且没有对应终态

### 5. 确定性投射

**怎么做**

- 先在真实会话中完成一次 `route=keep` 压缩
- 在不新增源消息的前提下，重复查看同一段上下文两次
- 再用仓库内置证明补一刀：

```bash
cd /root/_/opencode/opencode-context-compression
node --import tsx --test tests/e2e/plugin-loading-and-projection.test.ts
```

**重点观察**

- 同一规范历史下，第二次投射结果是否与第一次一致
- 已提交 replacement 是否稳定作为可见 referable 块出现

**PASS**

- 真实会话里重复读取同一段上下文时结果稳定
- `tests/e2e/plugin-loading-and-projection.test.ts` 通过

**FAIL**

- 不加新消息也会重复改写可见结果
- 同一 replacement 在两次投射中内容或位置漂移
- e2e 测试失败

### 6. `route=keep`

**怎么做**

- 在真实会话中选一段可压缩消息
- 使用你当前 profile 暴露的 mark 工具把它标成 `route=keep`
- 执行压缩
- 然后检查 SQLite：

```bash
sqlite3 "/root/_/opencode/opencode-context-compression/state/<session-id>.db" "SELECT mark_id, route, status FROM marks ORDER BY created_at_ms DESC LIMIT 10;"
sqlite3 "/root/_/opencode/opencode-context-compression/state/<session-id>.db" "SELECT route, status, COALESCE(content_text, '') FROM replacements ORDER BY committed_at_ms DESC LIMIT 10;"
sqlite3 "/root/_/opencode/opencode-context-compression/state/<session-id>.db" "SELECT replacement_id, mark_id, link_kind FROM replacement_mark_links ORDER BY created_at_ms DESC LIMIT 10;"
```

**重点观察**

- `marks.route='keep'`
- `replacements.route='keep'` 且 `status='committed'`
- 原源跨度在投射里被 referable survivor 取代，而不是彻底消失

**PASS**

- mark 最终变成 `consumed`
- replacement 成功提交
- 可见输出保留一个压缩后的 referable 块

**FAIL**

- mark 长期停在 `active`
- replacement 没提交
- 结果既没留下 referable 块，也没有合理失败记录

### 7. `route=delete`

**怎么做**

- 重复上一项，但把目标路由改成 `route=delete`
- 再运行仓库证明：

```bash
cd /root/_/opencode/opencode-context-compression
node --import tsx --test tests/e2e/delete-route.test.ts
```

再检查 SQLite：

```bash
sqlite3 "/root/_/opencode/opencode-context-compression/state/<session-id>.db" "SELECT route, status, COALESCE(content_text, '') FROM replacements ORDER BY committed_at_ms DESC LIMIT 10;"
sqlite3 "/root/_/opencode/opencode-context-compression/state/<session-id>.db" "SELECT snapshot_kind, route, source_count FROM source_snapshots ORDER BY created_at_ms DESC LIMIT 10;"
```

**重点观察**

- `route=delete` 仍然走同一套 replacement 框架，而不是旁路删除
- 投射结果是极简 delete notice，而不是 keep 风格的 survivor summary

**PASS**

- replacement 被记录为 `route='delete'`、`status='committed'`
- `source_snapshots` 同时能看到 `mark` 和 `replacement` 两类快照
- 可见投射里原源跨度被删除，只剩极简 delete notice
- `tests/e2e/delete-route.test.ts` 通过

**FAIL**

- delete 结果没有进入 replacement 表
- delete 走出一条完全不同、不可追踪的副路径
- 结果既不是极简 delete notice，也不是清晰失败

### 8. send-entry 等待与 tool bypass

**怎么做**

- 在一个活跃压缩仍持有锁的窗口里，同时做三件事：
  1. 发送一条普通聊天消息
  2. 运行一个普通非压缩工具，例如 `read`
  3. 尝试 `compression_mark`，并确认仓库自有的内部压缩执行不会作为公共工具暴露

当前实现里，允许走 bypass 的公共标记工具默认名是：

- `compression_mark`

当前实现里，活跃锁期间只应阻塞仓库内部压缩执行：

- `compression_run_internal`

必要时可以直接查批次成员是否冻结：

```bash
sqlite3 "/root/_/opencode/opencode-context-compression/state/<session-id>.db" "SELECT batch_id, member_index, mark_id FROM compaction_batch_marks ORDER BY batch_id DESC, member_index ASC LIMIT 20;"
sqlite3 "/root/_/opencode/opencode-context-compression/state/<session-id>.db" "SELECT mark_id, status FROM marks ORDER BY created_at_ms DESC LIMIT 20;"
```

**重点观察**

- 普通聊天应等待
- 非压缩工具应继续可用
- `compression_mark` 可以登记新 mark，但不应把晚到 mark 塞进已经冻结的 batch
- 仓库内部压缩执行在活跃锁期间应被挡住，且不应作为公共工具暴露

**PASS**

- 普通聊天直到批次终态后才恢复
- `read` 这类非压缩工具仍可执行
- 新增 mark 出现在 `marks` 表里，但不会回写进已冻结的 `compaction_batch_marks`
- 内部压缩执行在锁期间被拒绝

**FAIL**

- 普通聊天直接穿过活跃锁
- 非压缩工具也被全部锁死
- 晚到 mark 混入了旧批次
- 内部压缩执行在活跃锁期间还能继续跑

### 9. 传输观察与非污染检查

**怎么做**

- 保持 mitmproxy 监听 `127.0.0.1:41641`
- 触发一次真实压缩
- 同时观察 mitmproxy、`logs/seam-observation.jsonl` 和 SQLite

**重点观察**

- 是否存在与压缩时间点匹配的模型流量
- 压缩是否表现为插件拥有的独立调用，而不是普通 `session.prompt` / `session.prompt_async` 造成的额外会话污染
- 是否出现额外普通用户消息、副作用权限变更、共享 busy loop 复用等坏迹象

**PASS**

- mitmproxy 能看到与压缩时点对应的请求
- SQLite 同时出现对应的 `compaction_jobs`、`compaction_job_attempts`、`replacements`
- 没有证据表明压缩请求偷偷制造普通 `role=user` 会话消息
- 没有证据表明压缩依赖共享 session busy state 才能完成

**FAIL**

- 代理里有流量，但内部没有任何 compaction 记录
- 压缩看起来走成了普通会话 prompt 流程
- 压缩期间出现额外普通用户消息、权限变更污染、共享 session loop 复用导致的异常

## 9. 建议的执行顺序

如果你想把时间花在最可能出结论的步骤上，照这个顺序走：

1. 检查 `/root/_/opencode/config/opencode.jsonc`
2. 禁用竞争压缩路径并重启 OpenCode
3. 在仓库根目录执行 `npm run probe:seams`
4. 验证 `logs/seam-observation.jsonl`
5. 在仓库根目录启动真实 OpenCode 会话
6. 发出第一条普通请求，定位当前 `state/<session-id>.db`
7. 触发一次 `route=keep`
8. 观察 `locks/<session-id>.lock`、`compaction_batches`、`replacements`
9. 在 mitmproxy 中对齐一次网络观察
10. 再做一次 `route=delete`
11. 最后专门验证 send-entry wait / tool bypass

## 10. 什么时候直接判定有问题

出现下面任意一种情况，就应该停止“乐观解释”：

- 全局配置里根本没有显式插件入口
- seam probe 成功返回，但 `logs/seam-observation.jsonl` 没有三条关键 seam
- 真实会话里没有新的 `state/<session-id>.db`
- 压缩触发了，但完全不出现锁文件
- 锁文件消失后，对应批次仍停在 `running` 或 `frozen`
- `route=keep` / `route=delete` 都没有留下 committed replacement
- 同一规范历史在重复投射时持续漂移
- 普通聊天不等待活跃锁，或者非压缩工具被一起锁死
- mitmproxy 看到的是普通会话污染，而不是与 SQLite 相匹配的独立压缩调用

## 11. 什么时候可以收工

你可以把这次验证记为通过，当且仅当下面这份简表全部满足：

- 配置路径对，入口路径对，OpenCode 已重启
- seam probe 成功，且关键 seam 齐全
- sidecar DB 能创建并持续更新
- live lock 行为和 batch 终态一致
- `route=keep` 验证通过
- `route=delete` 验证通过
- 相同规范历史下投射稳定
- send-entry wait / tool bypass 行为正确
- mitmproxy 外部观察与内部状态完全对得上

## 12. 最后两个容易误判的点

### 12.1 不要把 nested `opencode run` 当成自动化金标准

这个仓库已经验证过，**在 Node 测试 harness 里嵌套启动 `opencode run`，并不是稳定的自动化插件加载证明路径。**

对这份仓库来说：

- `npm run probe:seams` 适合拿 seam 证据
- `tests/e2e/*.test.ts` 适合拿稳定的自动化证明
- 真正的 live verification 仍然应该看真实会话、副作用和代理观察

不要因为某个嵌套 CLI 试验偶发没出日志，就立刻推翻插件本身。

### 12.2 “锁没了”不等于“成功了”

当前实现会先把批次终态写进 SQLite，再移除锁文件。真正可靠的成功判断顺序是：

1. 先看锁是否结束
2. 再用锁的 `startedAtMs` 对应的 batch 去 SQLite 找终态
3. 只有 `compaction_batches.status='succeeded'` 才能判成功

如果只看锁文件是否消失，很容易把失败、手动清锁、异常恢复都看成成功。
