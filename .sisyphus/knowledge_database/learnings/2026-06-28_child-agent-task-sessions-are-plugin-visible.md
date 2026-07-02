## child-agent-task-sessions-are-plugin-visible
Date: 2026-06-28

### Pattern
`task(session_id=...)` 创建和续轮的子 agent 会话会进入 `opencode-context-compression` 的正常插件 seam；主 agent 发给子 agent 的 prompt 会作为该子会话里的文本消息参与投影和调度判断。

### Detail
一次真实子 agent 实验证明：主 agent 创建一个加法 worker 后，用同一个 `session_id` 连续发送 5 道题，目标子会话的 debug snapshot 记录了初始化 prompt、后续 5 次 prompt、子 agent 回复，以及子 agent 执行 `touch "/tmp/<sum>"` 的工具调用。

在 `logs/debug-snapshots/ses_0f35067d7ffehzs9UFVZ4r5Zu6.out.json` 中，owner 发给子 agent 的每个 prompt 都出现在纯 `text` part 中，并带有 visible id 前缀。runtime event 尾部也显示该子 session 多次穿过 `messages.transform`、`chat.params` 与 send gate；因此排查子 agent 行为时，不能假设它绕过本插件或不产生投影状态。

这也给“对子 agent 做对话式执行器”的设计设定了边界：子 agent 每轮 `task` 调用都必须返回一次结果，不能原生挂起等待，也不能直接使用 owner 侧的 `question` tool。若需要多轮澄清，应由主 agent 编排同一 `session_id` 的续轮，并让子 agent 用文本状态返回 `DONE`、`QUESTION` 或 `BLOCKED`。其中 `QUESTION` 只是返回给主 agent 的一段结果，不是对子 agent 的原生暂停机制。

对 `Sisyphus-Junior` 本身的 prompt 分层判断是：不要把“会话模式”默认塞进 system prompt，优先做成 skill 或调用协议模板。`Sisyphus-Junior` 的核心价值是边界清楚、执行收敛；如果 system prompt 默认加入会话模式，会把普通委托也偏向多轮协商，削弱一次性执行器的确定性。只有当所有 `Sisyphus-Junior` 委托都应默认遵守 `DONE` / `QUESTION` / `BLOCKED` 协议时，才考虑把该模式升入 system prompt。

### Applies To
- 子 agent / delegated task session 的 runtime 排查
- `task(session_id=...)` 续轮协议设计
- conversational executor skill / prompt 设计
- 插件 seam、projection、scheduler 与 send gate 的子会话覆盖判断

Tags: #subagent #task-session #runtime #projection #seams #pattern
