## current-runtime-still-trails-target-lifecycle
Date: 2026-03-31
Last Updated: 2026-04-03

### Symptom
当前运行时在若干关键点上仍未达到目标生命周期模型，导致系统在局部行为上可用，但整体仍偏离目标的 reminder → mark → compaction → cleanup 流。

### Trigger Conditions
当把现有 runtime 与完整生命周期参考对照时，这些缺口会暴露出来：

- durable reminder 仍容易退化为 transform-time projection，而不是稳定历史事件
- mark 语义、marked-token accounting 与 compaction readiness 之间仍存在实现落差
- 成功 compaction 后，对 reminder/mark/tool artifacts 的 cleanup 语义尚未完全闭合
- 当前实现更接近“局部可见性修补”，而不是完整生命周期收敛

### Resolution
UNRESOLVED

当前应把这个问题当作子项目的长期基线问题，而不是单次调试缺陷。后续工作需要同时参考当前 docs 中的运行时设计文档与生命周期相关语义，并逐步把缺口收敛到可验证的实现语义。

### Additional Observations

**2026-04-03**: 旧 `opencode-context-compression-live-verification-mark-gap` 进一步收敛了 live verification 的真实边界：当时真实会话已能证明插件加载、seam 日志、sidecar 创建与 host message sync，但不能通过宿主暴露的旧 `dcp_mark_for_compaction` / `dcp_execute_compaction` 工具证明新 sidecar pipeline 的 keep/delete 路径。

这不是 operator 操作错误，而是入口集成缺口：旧工具依赖的 runtime inventory/cache 与新 plugin flow 不同，无法作为新插件 mark / compaction / replacement / lock 的证明驱动。后续若要宣称真实会话完整证明 keep/delete，必须有 plugin-owned real-session mark/execute 工具，或一个 host-integrated scheduler/entry path 能自然写入 `marks`、`compaction_batches`、`replacements` 与 `locks`。

**2026-03-31**: 旧 lifecycle reference 曾把 durable reminder、AI-issued mark、marked-token threshold、artifact cleanup 与 `smallUserMessageThreshold` 放在同一个目标模型里。当前 docs 已保留 `smallUserMessageThreshold`、effective prompt set 与 durable history 分离、mark/replacement cleanup 等语义，但 reminder 已收敛为从 canonical history 派生的 projection artifact，而不是写入宿主长期历史的 synthetic message。维护时不能把旧 durable-reminder 目标误读成当前实现契约。

**2026-03-29**: 旧 tool-triggered auto-consume 经验表明，仅缓存 message-id inventory 不足以在同一轮构造 replacement；需要 full message snapshots 或从 canonical history replay 得到等价 source span。当前 replay-first / host-history-first 设计应保留这个教训：mark 是 lookup hint，真正输入必须可从 canonical source 重建。

**2026-03-29**: 旧问题 `dcp-backend-context-has-no-consumer` 与 `dcp-provider-prefix-ids-ignore-visiblemessageid` 后来被 provider seam 消费链与 visible-id 解析顺序修正或 supersede。它们仍有历史价值：当判断 compaction 是否真的 model-visible 时，不能只看 runtime 侧输出了 side-channel context，必须确认最终 provider/projection seam 实际消费了它。

**2026-03-29**: 旧 validator 对短 protected text 的 normalized leakage 检查存在盲点：少于阈值的短用户消息可能被空白变体泄漏却通过验证。当前设计继续把短用户消息设为 protected，因此任何 compaction validator 都必须把“短 protected leakage”当成高优先级失败模式，而不是只保护长文本。

Tags: #runtime #lifecycle #gap #architecture
