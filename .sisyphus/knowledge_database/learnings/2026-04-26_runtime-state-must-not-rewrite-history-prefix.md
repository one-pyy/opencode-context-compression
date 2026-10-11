# Runtime state must not rewrite history prefix
Date: 2026-04-26

### Pattern

已写入宿主历史的 prompt-visible 前缀必须保持幂等；运行时生命周期状态不能动态回写旧 tool result。

### Detail

`compression_mark` 的工具结果一旦以 `ok:true` 写入历史，后续 projection 不应因为 pending、result group、executor 状态暂时缺失而把同一个 tool part 改写成 `ok:false`。这些状态会随 seam 顺序、调度延迟、后台执行进度变化；如果把它们投影回旧消息，同一段早期 transcript 会在不同轮次出现 `ok:true → ok:false → ok:true` 或被 replacement 删除的漂移。

这种漂移会破坏 provider 的 exact-prefix cache，因为缓存依赖早期请求字节稳定。确定性错误仍可改写为 `ok:false`，例如非法参数、可见 ID 范围冲突或 from/to 无法解析；这些错误不依赖运行时生命周期，不会随 pending/result 状态反复变化。

运行时状态应进入 sidecar、日志或稳定 notice，而不是回写旧 tool result。

### Applies To

适用于 projection、tool result materialization、scheduler / executor 状态展示，以及任何可能改变已写入历史前缀的运行时派生信息。

Tags: #projection #cache #tool-result #runtime #trap

### Additional Observations

**2026-10-11**：全局统计也可能造成同类前缀漂移。自动 reminder 每次重建时，如果以完整投影的摘要总量选择早期 inspect 的 compact/delete 模式，后续摘要跨过阈值会反改旧提醒正文、工具参数和清单，即使该位置之前的消息没有变化。

局部 artifact 应只使用其锚点之前的累计数据。完整摘要总量仍用于面板；每条提醒用相同预计算摘要值的前缀合计判断。稳定标识本身不能保护缓存，还需比较实际 materialized 工具调用与结果对是否保持一致。

回归入口：`tests/architecture/reminder-retirement.test.ts` 检查阈值严格比较与提醒对象稳定；`tests/e2e/interfaces/reminder-artifact-behavior.test.ts` 检查后段摘要应用前后的完整宿主消息前缀。摘要 replacement 本身改变该前缀仍是独立的预期变化。
