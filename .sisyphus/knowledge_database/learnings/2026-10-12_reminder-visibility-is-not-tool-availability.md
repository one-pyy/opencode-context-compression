## 提醒结果可见不代表工具可调用
Date: 2026-10-12

### 规律

压缩插件参与子会话投影、展示检查清单、或者历史里出现工具结果，都不能证明当前模型拿到了压缩工具定义。插件注册、投影提醒与宿主权限筛选是不同的边界。

### 机制

- `src/runtime/plugin-hooks.ts` 的 `createContextCompressionHooks()` 同时注册 `compression_mark`、`compression_inspect`、`compression_recall` 与提醒工具，注册没有针对模型或探索角色的条件。
- `src/runtime/messages-transform.ts` 的 `projectProjectionToEnvelopes()` 将带有 `reminderToolName` 的投影消息直接包装为 `status: "completed"` 的工具结果。提醒以及随附检查清单可以由插件生成，不要求模型先执行对应工具。
- `.sisyphus/docs/compaction/reminder-system.md` 的“模型可见承载形态”规定提醒与紧随其后的检查以完整工具调用/结果对承载。
- `src/runtime/cpmark-reminder.ts` 在统计越过阈值时继承最新用户消息的 `agent`、`model`、`variant` 和 `tools`，但没有检查角色与会话合并后的 `compression_mark` 权限。保留原工具设置并不等于确认标记工具可用。

因此，默认限制插件工具的探索角色仍可能收到压缩指令和自动检查结果，却无法执行标记。这是提醒与可执行能力脱节的集成风险，不能通过调整端点、提示内容或重试格式解决。

### 真实证据与限制

本机 OpenCode `1.18.35` 的测试子会话 `ses_ecfc5c095ffegUaoZbI3TKAocO` 先使用 DeepSeek，再通过 `T1` 续用为 GPT；角色一直为 `explore`。两次真实请求都只有相同的 11 个工具，没有三个压缩工具。插件状态库和运行日志存在，确认该子会话进入投影；标记调用数为零。

证据定位：`state/ses_ecfc5c095ffegUaoZbI3TKAocO.db` 与 `logs/runtime-events.jsonl`；Plexus `config/plexus/data/plexus.db` 的 `debug_logs` 中 2026-10-12 13:08:12 UTC 和 13:12:54 UTC 的请求。只读核对脚本：`/tmp/opencode/scripts/inspect-explore-request-tools_2026-10-12_132019_7omc.py`。

这证明工具定义缺失发生在模型请求之前，不能证明用户最初报告的那次检查是主动调用：其会话编号未提供。自动投影的检查结果是“检查可见、标记不可用”的一个明确机制，不应把该可能解释升级为已复核的原会话事实。

### 排查与处理

先核查原始模型请求中的 `tools`，再区分宿主 `part` 表中的真实工具调用和仅在投影中出现的提醒结果。工具尚未暴露时，插件内部标记参数校验、范围校验及模型格式重试都不在故障链上。

本次没有修复。工具放行应在角色权限归属方处理；提醒能力检查是压缩插件侧可单独评估的改进，不应擅自扩大角色权限。相关宿主同名探索角色权限继承结论见 OMO 子项目知识库的 `learnings/2026-10-12_explore-native-permission-inheritance.md`。

### 适用范围

所有对子会话注入工具形态提醒的场景，尤其是宿主角色默认拒绝第三方工具、投影仍持续工作的情形。

Tags: #permissions #reminder #projection #subagent #trap #pattern
