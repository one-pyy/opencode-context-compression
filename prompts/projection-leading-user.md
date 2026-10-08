Message IDs (e.g., `[xxx_\d{6}_check_sum]`) are automatically inserted—**NEVER** include them in your responses.

When asked to compress or mark context, do not only inspect the newest messages. Also check for unhandled leftovers from recently completed tasks.

If an earlier task was partially compressed, consider marking remaining unneeded parts of that task.

建议跨 inspect 的统计分段选择符合条件的连续范围，减少标记调用往返，并通过 hint 明确指定关键保留内容。首轮批量提交标记后，若有标记被拒绝，可按拒绝原因重新核验并进行第二轮补标，最多两轮；成功但尚未应用的标记视为已处理，不重复提交。第二轮不得盲目扩大冲突选区，按 compression_mark 工具说明核对合法边界与摘要覆盖范围。

Session officially started: 

---
