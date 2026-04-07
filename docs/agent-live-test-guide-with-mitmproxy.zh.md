# Agent 实测指南：使用 mitmproxy、环境变量与 sidecar 联合验证 `opencode-context-compression`

这份文档面向 **agent / owner / reviewer**，用于在**真实 OpenCode 会话**里对本项目做一次尽可能诚实、可复现、可核查的 live test。

目标不是“只看一眼是否加载了插件”，而是要把以下几件事串起来验证：

1. 通过 **OpenCode 配置文件**显式加载本插件
2. 通过 **环境变量**开启插件调试能力
3. 使用 **mitmproxy 抓包**观察真实会话中的模型请求
4. 生成一个带随机内容的大文件，并测量其 token 数
5. 在**同一个会话**里逐轮、多次命令 AI 读取该文件，逐渐累积可压上下文
6. 联合检查：
   - prompt-visible 消息里是否出现稳定 `msg id`
   - sidecar DB 是否按设计落库并演化
   - logs 是否无报错
   - gate / reminder / replay / replacement / delete admission 等功能是否表现正常

本指南统一规定：

- **真实会话测试固定使用 `big pickle` 模型**
- 整个单会话流程中不切换模型
- 如果要比较别的模型，必须另开新会话，不与本指南主流程混用

`DESIGN.md` 是权威真相源。本指南是**执行手册**，不是设计替代品。

---

## 0. 先说清楚这份指南能证明什么

这份指南适合验证的是：

- 插件确实通过 OpenCode 配置文件加载了
- 插件 sidecar 路径确实按**插件根目录**工作
- `experimental.chat.messages.transform` / `chat.params` / `tool.execute.before` 等 seam 确实活着
- 在真实会话里，消息投影、`msg id`、SQLite sidecar、锁、日志、调试快照等 repo-owned surface 能对得上
- 在真实会话流量里，mitmproxy 能捕到与这些行为相对应的请求窗口

这份指南**不自动声称**以下内容已经被证明：

- 任意 provider / 任意模型下都稳定完成 production-grade compaction
- 所有 delete-style success path 都已经在真实宿主环境中自动完成了最终证明

换句话说，这份指南强调的是：

> **真实环境观测 + 设计边界对齐 + sidecar/log/flow 三方一致性**

而不是“只因为抓到包了，所以功能一定完全正确”。

---

## 1. 前提条件与路径

以下路径按当前仓库默认位置书写。若你的路径不同，请整体替换，但逻辑不变。

### 1.1 插件根目录

```text
/root/_/opencode/opencode-context-compression
```

后文简称：`<plugin-root>`

### 1.2 插件关键路径

- 插件入口：`<plugin-root>/src/index.ts`
- 运行时配置：`<plugin-root>/src/config/runtime-config.jsonc`
- 配置 schema：`<plugin-root>/src/config/runtime-config.schema.json`
- compaction prompt：`<plugin-root>/prompts/compaction.md`

### 1.3 sidecar / logs / debug 路径

按当前 `DESIGN.md`，这些路径都相对于**插件根目录**解析，而不是 OpenCode 启动目录：

- Sidecar DB：`<plugin-root>/state/<session-id>.db`
- Lock：`<plugin-root>/locks/<session-id>.lock`
- Runtime log：`<plugin-root>/logs/runtime-events.jsonl`
- Seam log：`<plugin-root>/logs/seam-observation.jsonl`
- Debug snapshot：由 `OPENCODE_CONTEXT_COMPRESSION_DEBUG_SNAPSHOT_PATH` 控制，若给相对路径，也相对于 `<plugin-root>`

### 1.4 mitmproxy

本指南假定 mitmproxy 监听：

```text
127.0.0.1:41641
```

配置文件示例位置：

```text
~/.mitmproxy/config.yaml
```

---

## 2. 启动前准备

### 2.1 不直接改主配置：复制临时 OpenCode 配置并用环境变量指向它

本指南**不建议直接修改主配置文件**。更安全的做法是：

1. 复制一份临时 OpenCode 配置
2. 在复制出的配置里加上本插件入口
3. 用环境变量让本轮 OpenCode 进程读取这份临时配置

示例步骤：

```bash
cp "/root/_/opencode/config/opencode.jsonc" "/tmp/opencode.context-compression.test.jsonc"
```

然后编辑 `/tmp/opencode.context-compression.test.jsonc`，确保包含：

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

最后在启动 OpenCode 前显式设置配置路径环境变量（变量名以你当前 OpenCode 版本/安装方式为准；这里用占位名表示）：

```bash
export OPENCODE_CONFIG_PATH="/tmp/opencode.context-compression.test.jsonc"
```

要求：

- 不直接改主配置
- 本轮测试使用单独的临时配置文件
- 临时配置里显式加载本插件入口
- 禁掉 OpenCode 自带竞争压缩路径
- 不同时加载别的会改 `messages.transform` 的插件

如果你的 OpenCode 版本使用的不是 `OPENCODE_CONFIG_PATH` 这个变量名，而是别的配置环境变量，请替换成你本机实际生效的那个；原则不变：**用环境变量切配置，而不是污染主配置。**

### 2.2 环境变量：开启插件调试能力

至少建议设置这些环境变量：

```bash
export OPENCODE_CONTEXT_COMPRESSION_RUNTIME_CONFIG_PATH="/root/_/opencode/opencode-context-compression/src/config/runtime-config.jsonc"
export OPENCODE_CONTEXT_COMPRESSION_LOG_LEVEL="debug"
export OPENCODE_CONTEXT_COMPRESSION_RUNTIME_LOG_PATH="logs/runtime-events.jsonl"
export OPENCODE_CONTEXT_COMPRESSION_SEAM_LOG="logs/seam-observation.jsonl"
export OPENCODE_CONTEXT_COMPRESSION_DEBUG_SNAPSHOT_PATH="logs/debug-snapshots"
```

说明：

- 这些相对路径最终都会落到 `<plugin-root>` 下
- `LOG_LEVEL=debug` 的目的是让本轮测试尽量可观测
- `DEBUG_SNAPSHOT_PATH` 用来生成 in/out snapshot，便于核对 projection 前后差异

如果你要临时覆盖 delete admission，也可以显式准备不同 runtime config 文件，但**本指南默认不要求在真实会话里主动走 delete 路径**；更关注的是 live verification 的整体链路。

### 2.3 启动 mitmproxy

若系统里还没有 mitmproxy 实例：

```bash
mitmproxy --listen-host 127.0.0.1 --listen-port 41641
```

记录下开始时间，后续要和日志 / DB 时间窗对齐。

### 2.4 清理旧测试痕迹（可选但推荐）

在开始前，建议清空上一轮痕迹，避免误读：

```bash
rm -rf "/root/_/opencode/opencode-context-compression/logs/debug-snapshots"
rm -f "/root/_/opencode/opencode-context-compression/logs/runtime-events.jsonl"
rm -f "/root/_/opencode/opencode-context-compression/logs/seam-observation.jsonl"
mkdir -p "/root/_/opencode/opencode-context-compression/logs/debug-snapshots"
```

不要批量删除整个 `state/`，除非你明确知道自己不会误删其他会话证据。

### 2.5 固定本轮测试模型：`big pickle`

本指南规定真实会话测试统一使用：

```text
big pickle
```

要求：

- 整个测试会话始终使用 `big pickle`
- 不在中途切换到别的模型
- 如果需要做不同模型的对照，请新开会话并单独记录

---

## 3. 先做最低成本活性验证

### 3.1 运行 seam probe

在 `<plugin-root>` 执行：

```bash
npm run probe:seams
```

预期：

- 命令成功返回
- `logs/seam-observation.jsonl` 被重新写出

### 3.2 检查 seam probe 输出

至少确认 seam log 中出现：

- `chat.params`
- `experimental.chat.messages.transform`
- `tool.execute.before`

这一步通过，说明：

- 插件入口可加载
- seam 观测可用
- repo-owned 日志路径工作正常

如果这一步不过，不要继续后面的 live test，先修环境。

---

## 4. 生成随机大文件并测 token

目标：构造一个在同一会话里多轮读取后，明显能累积 context 的真实输入源。

### 4.1 生成随机字符文件

在 `<plugin-root>` 下创建测试文件，例如：

```bash
python3 - <<'PY'
import random
import string
from pathlib import Path

root = Path('/root/_/opencode/opencode-context-compression')
target = root / 'live-runtime-proof' / 'random-payload.txt'
target.parent.mkdir(parents=True, exist_ok=True)

alphabet = string.ascii_letters + string.digits + '     \n'
payload = ''.join(random.choice(alphabet) for _ in range(350000))
target.write_text(payload, encoding='utf-8')
print(target)
print(target.stat().st_size)
PY
```

建议生成足够大的文件，使它在多轮读取后能跨过 reminder / marked-token 相关阈值。

### 4.2 测量该文件 token 数

建议优先使用 **`big pickle` 对应 tokenizer** 做一次粗测；如果本机工具链暂时无法直接按 `big pickle` 计数，也至少要明确记录“这是近似 token 数，不是运行时精确值”。

如果你只能先用仓库现有的 `tiktoken` 做近似测量，可以这样记录一份参考值：

```bash
node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
import { encoding_for_model } from 'tiktoken';

const file = '/root/_/opencode/opencode-context-compression/live-runtime-proof/random-payload.txt';
const text = readFileSync(file, 'utf8');
const enc = encoding_for_model('gpt-4o-mini');
const count = enc.encode(text).length;
enc.free();
console.log(JSON.stringify({ file, chars: text.length, tokens: count }, null, 2));
JS
```

注意：

- 如果这里不是按 `big pickle` 的真实 tokenizer 计数，这个数字只是近似参考
- 它不要求和运行时内部估算完全字节一致
- 但它足以帮助你判断“多读几轮以后是否应触发 reminder / mark / compaction 前置条件”

把这个结果记下来，后面要和日志、抓包和 sidecar 变化一起解释。

---

## 5. 真实会话执行方案

目标：在**同一个会话**里，逐轮、多次让 AI 读取这个随机文件，观察上下文逐渐累积时插件的行为。

### 5.1 用临时配置启动 OpenCode，并固定在单一会话内测试

要求：

- 通过环境变量显式指向临时测试配置
- 当前会话固定使用 **`big pickle`**
- 只用一个 session
- 不要在中途切换 profile / plugin 配置
- 不要在测试过程中替换 runtime config
- 不要在测试过程中切换模型

### 5.2 推荐的多轮提示序列

建议用下面这种逐步加压方式，而不是一上来就“把整文件总结掉”：

#### 第 1 轮：确认基本读取

让 AI：

- 打开并读取 `live-runtime-proof/random-payload.txt`
- 只返回文件头部和尾部各一小段摘要
- 明确要求它不要一次性整体总结

#### 第 2 轮：重复读取，要求不同切片

让 AI：

- 再次读取同一文件
- 改为抽取中间若干区块特征
- 明确要求引用读取到的内容差异

#### 第 3 轮：继续读取并比较不同区域

让 AI：

- 再读该文件
- 比较前半段 / 后半段 / 随机若干窗口的差异

#### 第 4 轮及以后：逐步增加上下文压力

让 AI：

- 多次读取同一文件
- 每轮关注不同窗口
- 每轮都让它基于前一轮结果继续推进，而不是重开新问题

目标不是让模型立刻压缩成功，而是要人为制造：

- 同一会话中多轮真实读取
- 累积越来越多的 file/tool/assistant context
- 让插件有机会展示 reminder、msg id、projection、mark replay、sidecar 运作等行为

---

## 6. 每一轮都要做的观测

每做完 1~2 轮，就做一次下面的联合检查。

### 6.1 抓包：mitmproxy 观察窗口

在 mitmproxy 中记录：

- 当前会话时间窗是否出现模型请求
- 请求数量是否和你的交互轮次大致对应
- 如果有额外压缩相关请求窗口，也要记时间点

注意：

- **抓到流量 ≠ 证明 compaction 成功**
- 抓包只能作为“确实发生了模型交互”的辅助证据

### 6.2 seam 日志

检查：

```bash
grep -nE 'chat.params|experimental.chat.messages.transform|tool.execute.before' \
  "/root/_/opencode/opencode-context-compression/logs/seam-observation.jsonl"
```

看点：

- 每轮是否都有新的 `messages.transform` 记录
- `tool.execute.before` 是否只在工具路径上出现
- `chat.params` 是否仍只是窄 metadata seam，而不是在做 projection 工作

### 6.3 runtime log

检查：

```bash
readlink -f "/root/_/opencode/opencode-context-compression/logs/runtime-events.jsonl"
```

然后查看内容，重点找：

- error
- exception
- malformed
- replay
- lock
- result group / fragment 相关事件

要求：

- **不能有未解释的 runtime error**
- 若有 warning / recoverable event，要记录时间点并与会话操作对齐

### 6.4 debug snapshot

检查目录：

```bash
ls -lt "/root/_/opencode/opencode-context-compression/logs/debug-snapshots"
```

看点：

- 是否出现 `<session-id>.in.json`
- 是否出现 `<session-id>.out.json`
- 同一轮输入输出是否能对应上 projection 前后变化

### 6.5 sidecar DB

先拿到 session id，然后检查：

```bash
sqlite3 "/root/_/opencode/opencode-context-compression/state/<session-id>.db" ".tables"
sqlite3 "/root/_/opencode/opencode-context-compression/state/<session-id>.db" "SELECT * FROM schema_meta;"
sqlite3 "/root/_/opencode/opencode-context-compression/state/<session-id>.db" "SELECT canonical_id, visible_seq, assigned_visible_id FROM visible_sequence_allocations ORDER BY visible_seq LIMIT 20;"
sqlite3 "/root/_/opencode/opencode-context-compression/state/<session-id>.db" "SELECT mark_id, mode, source_start_seq, source_end_seq, fragment_count, execution_mode, created_at, committed_at FROM result_groups ORDER BY created_at DESC LIMIT 20;"
sqlite3 "/root/_/opencode/opencode-context-compression/state/<session-id>.db" "SELECT mark_id, fragment_index, source_start_seq, source_end_seq, replacement_text FROM result_fragments ORDER BY mark_id, fragment_index LIMIT 20;"
```

要求：

- schema 正常
- visible id 映射正常递增
- result group / fragment 只有在真实成功提交后才出现
- 不应出现“半截 fragment”或破碎组

### 6.6 lock 文件

检查：

```bash
ls -lt "/root/_/opencode/opencode-context-compression/locks"
```

如果某个时窗里看到 lock：

- 记录创建与消失时间
- 对齐 mitmproxy / seam log / runtime log / DB 时间窗

注意：

- **lock 消失 ≠ 一定成功**
- 只能说明 gate 生命周期发生了变化

---

## 7. 本次测试必须逐项核验的功能 checklist

下面是本项目当前应核验的功能清单。建议打印或拷贝到 notepad，逐项打勾。

### 7.1 插件加载与路径

- [ ] 没有直接修改主配置文件
- [ ] 已复制并使用临时 OpenCode 配置文件
- [ ] 启动 OpenCode 的环境变量确实指向该临时配置
- [ ] 临时配置文件显式加载了 `<plugin-root>/src/index.ts`
- [ ] 当前真实会话固定使用 `big pickle`
- [ ] 没有并行启用竞争的 transform / compaction 插件
- [ ] sidecar DB 写到了 `<plugin-root>/state/`
- [ ] lock 写到了 `<plugin-root>/locks/`
- [ ] runtime/seam/debug 日志都写到了 `<plugin-root>/logs/`
- [ ] 没有任何 sidecar 路径落到 OpenCode 启动目录或当前 shell cwd

### 7.2 seam 活性

- [ ] `npm run probe:seams` 成功
- [ ] `seam-observation.jsonl` 中出现 `chat.params`
- [ ] `seam-observation.jsonl` 中出现 `experimental.chat.messages.transform`
- [ ] `seam-observation.jsonl` 中出现 `tool.execute.before`

### 7.3 msg id / visible id

- [ ] 普通消息进入 prompt-visible 世界时有稳定 msg id / visible id 前缀
- [ ] tool 结果前面也能看到自己的 msg id
- [ ] 同一会话多轮 replay 后，已有消息的 visible id 保持稳定
- [ ] 没有出现散乱重编号或 visible id 抖动

### 7.4 host history / replay / 错误调用语义

- [ ] `compression_mark` 成功调用会留下可重放的 mark 结果
- [ ] `compression_mark` 失败调用不会进入 mark replay
- [ ] 失败的 `compression_mark` 结果仍作为普通可见 tool 消息保留
- [ ] replay 没有把错误调用静默吞掉

### 7.5 reminder

- [ ] 随着多轮读取累积，可压上下文变多时，reminder 行为符合预期
- [ ] `allowDelete=false` 时 reminder 文案是 compact-only 风格
- [ ] `allowDelete=true` 时 reminder 文案会切换到 delete-allowed 风格（若本轮做了对应配置测试）
- [ ] reminder 位置与当前可见历史累积大体一致

### 7.6 send-entry gate / lock

- [ ] 若出现 active compaction gate，普通对话会在 `messages.transform` 入口前等待
- [ ] 等待会在成功、终态失败、超时或手工清锁后结束
- [ ] lock 文件生命周期和日志/抓包时间窗能对上
- [ ] 非相关工具路径不会被错误阻塞

### 7.7 scheduler

- [ ] scheduler readiness 不是按 mark 数量，而是按未压原始 token 达阈值判断
- [ ] `schedulerMarkThreshold` 没有重新主导调度语义
- [ ] queued marks / frozen batch snapshot 的行为与日志能对齐

### 7.8 compaction / replacement

- [ ] 成功结果只以 result group / fragments 形式进入 sidecar
- [ ] replacement 生效后，会接管原始 source span
- [ ] 已消费的 mark tool 调用会从 projection 中消失
- [ ] 父结果组存在时，gap 会优先显示子结果而不是错误回退原文
- [ ] delete-style 结果会呈现 delete notice，而不是 referable compact 块（如果本轮做 delete 测试）

### 7.9 sidecar DB 正确性

- [ ] `schema_meta` 正常
- [ ] `visible_sequence_allocations` 正常递增
- [ ] `result_groups` 只在成功提交后出现
- [ ] `result_fragments` 没有半成品 / fragment 数不一致问题
- [ ] 没有发现 sidecar 被当作第二套 transcript 使用的迹象

### 7.10 日志与报错

- [ ] `runtime-events.jsonl` 中没有未解释错误
- [ ] `seam-observation.jsonl` 没有明显异常时序
- [ ] debug snapshot in/out 可以对齐本轮操作
- [ ] 若出现 recoverable error，已能通过日志明确解释其来源

### 7.11 抓包与解释边界

- [ ] mitmproxy 能看到与你操作对应的模型请求窗口
- [ ] 抓包时间窗与 seam log / runtime log / DB 变化能对齐
- [ ] 没有把“抓到包”误解释成“所有语义都已被证明”

---

## 8. 建议的实际执行记录模板

建议你在测试时按下面格式做一份现场记录：

```text
会话 ID：<session-id>
开始时间：<timestamp>
测试模型：big pickle
随机文件路径：<path>
字符数：<chars>
估算 token 数：<tokens>

第 1 轮：<做了什么>
- mitmproxy：<看到什么>
- seam log：<看到什么>
- runtime log：<看到什么>
- DB：<看到什么>
- lock：<看到什么>

第 2 轮：...

最终 checklist：
- [x] / [ ] ...
```

---

## 9. PASS / FAIL 判定

### 可以判 PASS 的最低条件

- [ ] 插件入口正确加载
- [ ] sidecar / lock / logs 路径都落在插件根目录
- [ ] seam probe 通过
- [ ] 单会话多轮读取真实发生
- [ ] 抓包、日志、DB 三方能在关键时间窗对齐
- [ ] `msg id` / visible id 行为正常
- [ ] sidecar DB 结构和运行状态正常
- [ ] 没有未解释 runtime error

### 必须判 FAIL 或“未完成”的情况

- [ ] 插件未真正加载
- [ ] sidecar 路径写错到 OpenCode 启动目录 / cwd
- [ ] seam log 不全
- [ ] 只能依赖抓包猜测插件行为，没有 DB / log 对齐
- [ ] visible id / msg id 行为异常
- [ ] DB 不落库、落半成品、或结构错乱
- [ ] logs 有未解释报错

---

## 10. 备注

这份指南是给 agent 执行真实环境测试用的，因此故意把“看什么”“怎么记”“怎么判”拆得很细。真正重要的是：

> **不要让任何单一观察面（只有抓包、只有日志、只有 DB、只有感觉）替代联合证据。**

对本项目来说，可信的 live verification 一定是：

- OpenCode 会话行为
- mitmproxy 抓包
- seam / runtime / debug 日志
- sidecar DB / lock 文件

这几条线同时对得上，结论才站得住。
