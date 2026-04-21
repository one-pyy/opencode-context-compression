## dcp-current-runtime-still-trails-target-lifecycle
Date: 2026-04-19

### Symptom
当前 DCP 运行时在若干关键点上仍未达到目标生命周期模型，导致系统在局部行为上可用，但整体仍偏离目标的 reminder → mark → compaction → cleanup 流。

### Trigger Conditions
当把现有 runtime 与完整生命周期参考对照时，这些缺口会暴露出来：

- durable reminder 仍容易退化为 transform-time projection，而不是稳定历史事件
- mark 语义、marked-token accounting 与 compaction readiness 之间仍存在实现落差
- 成功 compaction 后，对 reminder/mark/tool artifacts 的 cleanup 语义尚未完全闭合
- 当前实现更接近“局部可见性修补”，而不是完整生命周期收敛

### Resolution
UNRESOLVED

当前应把这个问题当作子项目的长期基线问题，而不是单次调试缺陷。后续工作需要同时参考当前运行时设计文档与生命周期 reference，并逐步把缺口收敛到可验证的实现语义。

Tags: #dcp #lifecycle #gap #architecture
