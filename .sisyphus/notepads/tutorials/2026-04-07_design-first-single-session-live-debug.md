## design-first-single-session-live-debug
Date: 2026-04-07

### Use When
用于 `opencode-context-compression` 已经进入真实宿主联调阶段，执行者需要在 OpenCode 真宿主里验证插件行为、解释 repo-owned artifacts、并避免把错误的 session 管理、错误的 ID 体系、错误的配置激活方法或错误的证据边界带进判断时。

### Goal
让后续执行者只靠这份教程，就能恢复当前真实宿主调试的长期有效基线：先读完整 `DESIGN.md`，再用单 agent / 单 fresh session 的方式收集 repo-owned artifacts；明确当前 build-first 入口、真实宿主隔离配置的正确激活方式、`chars / 4` token 口径、`compression_mark` 的真正输入体系、artifact 真值边界，以及 `database is locked` 与 repo-owned compaction lock 的区别，而不需要再翻多份旧 next-plan 才知道这些关键点。

### Mechanism
本项目当前真实宿主调试有五条必须同时成立的真相边界。

第一条是 **design truth**。`DESIGN.md` 是权威契约，尤其要先读清楚 visible id、`compression_mark` 输入、reminder、sidecar、lock、projection，以及真实宿主只能证明什么、不能证明什么。当前设计和实现里，`compression_mark.target.startVisibleMessageID` / `endVisibleMessageID` 要的不是宿主原始 `msg_*`，而是 projection 后的 `protected_*` / `compressible_*` / `referable_*` visible id。

第二条是 **runtime entry truth**。当前真实宿主已经切到 build-first 路径：`.tmp/opencode.context-compression.test.jsonc` 指向的是 `dist/index.js`，而不是 `src/index.ts`。本仓库已经专门建立了 `build`、`test:dist-entry`、`probe:seams` 这条 shipped/build-first 工作流，所以真实宿主结论优先围绕 `dist/` 入口，而不是源码直载假设。

第三条是 **config activation truth**。在这台真实宿主上，`OPENCODE_CONFIG_PATH` 不能把 OpenCode 切到隔离测试配置；`opencode debug config` 已经证明，设了它之后宿主仍会解析默认全局插件列表。因此，真实宿主若要只加载测试插件，必须使用：

- `XDG_CONFIG_HOME=<sandbox-root>`
- `<sandbox-root>/opencode/opencode.jsonc`
- 在真正开跑前，先执行 `XDG_CONFIG_HOME=<sandbox-root> opencode debug config`

只有当输出里的：

- `plugin` 指向本轮期望的插件入口
- `plugin_origins` 指向 sandbox config 目录

时，后面的真实宿主结果才可以被当成这份插件的证据。若这里不对，后续 session 就算存在，也可能完全没有加载本插件。

第四条是 **artifact truth**。真实宿主里真正算数的是 repo-owned artifacts：`logs/runtime-events.jsonl`、`logs/seam-observation.jsonl`、`logs/debug-snapshots/<session>.in.json`、`logs/debug-snapshots/<session>.out.json`、`state/<session>.db`、以及 `locks/<session>.lock`。宿主能回答、session 能创建、模型 reasoning 里出现 `<invoke name="compression_mark">`，都不等于插件逻辑已经真正执行；只有 `tool.execute.before`、tool message/result、pending mark、result group、lock/runtime event 等可恢复 artifact，才能证明 execution path 真的进入了下一层。

第五条是 **session ownership truth**。真实宿主调试时，一个子 agent 只能拥有一个 fresh session，并且只检查这个 session 的 artifacts。不要把同一个 session id 分发给多个子 agent，不要在子 agent 跑的时候由 owner 或别的 agent同时去查它的 DB/log/snapshot，否则像 `database is locked` 这种现象很容易被调试方式本身污染。若必须多 agent 并行，每个 agent 必须自己新开 session，且不得共享 session id。

除此以外，本项目还有八个已经被多轮真实调试反复确认、以后仍然会继续影响判断的长期背景：

1. **token 估算口径已经固定为 repo-owned `chars / 4`**。用户已经明确接受 token 估算不精确，只要求真实宿主主链路可调试、可观测、可稳定运行。不要再回到 `tiktoken` / `js-tiktoken` / `js-tiktoken/lite` 的宿主兼容性试错。
2. **tool 可见 ≠ tool 已执行**。模型 reasoning 中出现 `<invoke name="compression_mark">` 只能证明工具对模型可见，不能证明宿主/插件真的派发了工具。
3. **错误的 config 激活方式会制造假阴性**。本轮已有一次 fresh session `ses_297c4f158ffe2fizkKHUvH0uO5`，host session 确实存在，但 repo-owned `runtime-events` / `seam-observation` / snapshots / sidecar 全部缺失；根因不是插件逻辑，而是宿主根本没吃到隔离配置。
4. **经 `XDG_CONFIG_HOME` 修正后，插件已在真实宿主里成功激活**。fresh session `ses_297aaa52fffePzbW8RF2ZlPT9s` 已真实产出 `logs/runtime-events.jsonl`、`logs/seam-observation.jsonl`、`logs/debug-snapshots/*.json`、`state/<session>.db`，说明插件加载、projection seam、tool seam、sidecar 路径都已经在真宿主里活过来了。
5. **新加的调试日志已经在真实宿主落地**。在 `ses_297aaa52fffePzbW8RF2ZlPT9s` 中，`runtime-events.jsonl` 的 `experimental.chat.messages.transform completed` payload 已含 `projectionDebug`；`tool.execute.before completed` payload 已含 `gateDecision`。因此当前如果再遇到 seam 问题，可以先看 repo-owned runtime event，而不是盲猜 projection 内部状态。
6. **当前仍未拿到真实 `compression_mark` 执行证据**。在已经修通激活路径后，真实宿主目前只证明了 `bash` 这类普通工具会进入 `tool.execute.before`，还没有证明 `compression_mark` 真的进了 seam、留下 tool result、进入 replay、或写出 result group。
7. **当前最值得关注的真实窄卡点已经从“插件是否加载”前移到“`compression_mark` 是否真正进入 tool seam”**。激活路径未修通之前，不要对业务逻辑做过深判断；激活路径修通之后，下一步才是围绕 `compression_mark`、mark replay、scheduler、result groups、reminders、locks 等能力做逐层验证。
8. **`database is locked` 更像 SQLite/WAL 访问现象，而不是 design 里的 repo-owned compaction lock**。若 runtime metadata 仍显示 `no active compaction lock`、并且没有 `locks/<session>.lock` artifact，就不要直接把 DB 锁写成 compaction gate 正常工作。

### Responsibilities
- `DESIGN.md` — 先读完整设计，确认 visible id、`compression_mark` 输入、lock 语义、artifact 边界。
- `.tmp/opencode.context-compression.test.jsonc` — 当前真实宿主隔离配置内容样例，已指向 `dist/index.js`；真实运行时要通过 `XDG_CONFIG_HOME` 把它放进 `<sandbox>/opencode/opencode.jsonc` 才会生效。
- `src/config/runtime-config.jsonc` — 当前真实宿主阈值、`allowDelete`、runtime/seam/debug 路径等运行时口径。
- `src/token-estimation.ts` — 当前 token 估算的唯一实现，已改为 repo-owned `chars / 4`。
- `docs/agent-live-test-guide-with-mitmproxy.zh.md` — 真实宿主测试流、固定模型、repo-owned artifact 观察面。
- `logs/runtime-events.jsonl` — 运行时 seam 级证据，尤其看 `chat.params` / `messages.transform` / `tool.execute.before` 是否真的出现，以及 `projectionDebug` / `gateDecision` 是否落出。
- `logs/seam-observation.jsonl` — 观察宿主是否真的触发了对应 seam，并用 `identityFields` 对齐 session / call。
- `logs/debug-snapshots/<session>.in.json|out.json` — 还原单个 session 当前轮真实输入/投影输出，分辨“模型看到了什么”和“插件改写了什么”。
- `state/<session>.db` — 检查 visible id 分配、result groups / fragments 是否真的落盘。
- `locks/<session>.lock` — 仅当真实 compaction gate 进入运行态时才应出现；不要把 SQLite 锁误认成它。

### How To Apply Changes
- For 真实宿主验证前：先读完整 `DESIGN.md`，尤其确认 `compression_mark.target.*VisibleMessageID` 要的是 visible id，不是宿主 `msg_*`；同时确认当前 live path 是 build-first 的 `dist/index.js`。
- For host config 激活：不要假设 `OPENCODE_CONFIG_PATH` 会在当前宿主生效。必须用 `XDG_CONFIG_HOME=<sandbox-root>`，把隔离配置写到 `<sandbox-root>/opencode/opencode.jsonc`，再用 `XDG_CONFIG_HOME=<sandbox-root> opencode debug config` 验证 `plugin` 与 `plugin_origins`。如果输出里仍是默认全局插件集，就说明你还没进入隔离测试环境。
- For session 管理：要求子 agent 自己创建唯一 fresh session，并在最终回报中明确写出 session id；不要把旧 session id 预先塞给多个 agent。
- For artifact 判读：先区分“工具可见”与“工具执行”。模型 reasoning 里出现 `<invoke name="compression_mark">` 只能证明可见；只有 seam/runtime/sidecar artifact 才能证明执行。
- For tool-call prompt 设计：若要强迫 `compression_mark` 执行，先从当前 `.out.json` 中提取真正的 visible ids，再把这些 visible ids 作为 `startVisibleMessageID` / `endVisibleMessageID` 输入。不要直接把宿主 `msg_*` 塞进去。
- For reminder / compaction / result-group 验证：先承认这些都依赖真实 tool execution。若 `compression_mark` 还没真正进入 `tool.execute.before`，就不要跳着去宣称 reminder、pending marks、result_groups 或 lock lifecycle 已失败。
- For token/阈值判断：使用当前 accepted 口径 `chars / 4`，并把 `hsoft=30000`、`hhard=70000`、`markedTokenAutoCompactionThreshold=20000` 当作 live-host 阈值背景，而不是重新引入 tokenizer 兼容层试验。
- For 锁问题判读：先区分 SQLite/WAL 锁与 repo-owned `locks/<session>.lock`。没有 `locks/` artifact、runtime 又显示 `no active compaction lock` 时，不要直接把 `database is locked` 写成 design 里的 compaction gate。
- For 修改前沟通：若 live run 暴露实现问题，先向用户说明“问题是什么、与 `DESIGN.md` 哪条不匹配、最小改动面在哪”，得到确认后再改。

### Commands
- `read DESIGN.md` — 真正的设计基线，不可跳过。
- `read .tmp/opencode.context-compression.test.jsonc` — 确认真实宿主当前加载的是 build 产物而不是源码入口。
- `read src/config/runtime-config.jsonc` — 确认当前 live 宿主阈值、`allowDelete`、artifact 路径等运行时口径。
- `read docs/agent-live-test-guide-with-mitmproxy.zh.md` — 真实宿主证据面与隔离环境口径。
- `XDG_CONFIG_HOME="<sandbox-root>" opencode debug config` — 先验证真实宿主是否真的加载了隔离插件配置，而不是默认全局配置。
- `grep "tool.execute.before|compression_mark|projectionDebug|gateDecision|no active compaction lock" logs/runtime-events.jsonl logs/seam-observation.jsonl` — 快速区分“工具执行到了哪一层”，以及当前 projection / gate 调试信息是否已落库。
- `read logs/debug-snapshots/<session>.in.json` 与 `read ...out.json` — 对照模型输入和 projection 输出。
- `sqlite3 "file:state/<session>.db?mode=ro" ...` — 只在 owner 需要离线看单个 session sidecar 时，用只读方式减少额外锁干扰。

### Result
- 后续执行者不会再把“host session 存在”误当成“插件已真实加载”；会先用 `opencode debug config` 验证 sandbox config 是否真的生效。
- 后续执行者会直接知道当前 live-host 入口是 `dist/index.js`、artifact 路径是 repo-owned `logs/` / `state/` / `locks/`、token 估算口径已经固定为 `chars / 4`，而且隔离宿主配置必须通过 `XDG_CONFIG_HOME` 显式激活后才可信。
- 真实宿主结论会明确区分：插件 active、工具可见、工具实际执行、mark 已重放、result group 已提交、lock 真正出现，这几个层次不会再混写。
- 真实宿主中如果 `messages.transform` 和 `tool.execute.before` 已出现，则优先先读 `runtime-events.jsonl` 的 `projectionDebug` / `gateDecision`，而不是再猜 projection 内部状态。
- `database is locked` 这类问题会先被判定为 SQLite/WAL 访问现象还是 repo-owned compaction lock，而不是在证据不足时随意归因。

### Notes
- 这份教程的核心不是“如何多跑几轮”，而是“如何不把错误的 session 管理、错误的 ID 体系、错误的配置激活方法、和错误的证据解释带进 live 调试”。
- `compression_mark` 的真正输入必须来自当前 projected visible world，而不是宿主 transcript 原始 `info.id`。这点在真实宿主联调中尤其容易被忽略。
- 真实宿主能回答，不等于插件成功；模型在 reasoning 里说它要调用工具，也不等于工具真的执行。
- fresh session `ses_297c4f158ffe2fizkKHUvH0uO5` 只能被当成“错误激活方式导致的假样本”，不能再拿它证明业务逻辑失败。
- fresh session `ses_297aaa52fffePzbW8RF2ZlPT9s` 已证明：正确的 `XDG_CONFIG_HOME` sandbox 激活后，repo-owned runtime logs、seam logs、snapshots、sidecar DB、`projectionDebug` 与 `gateDecision` 都会真实出现；因此后续调试焦点已经前移到 `compression_mark` 与后续功能链本身。
