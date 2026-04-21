# opencode-context-compression — Docs Index

Project: /root/_/opencode/opencode-context-compression
Purpose: 记录 DCP / context-compression 子项目的当前实现参考与目标设计文档。

## Summary

当前文档重点覆盖 DCP / context-compression 的 runtime 主契约与目标生命周期模型。现状上，canonical host history、SQLite sidecar、projection / scheduling 分层已存在；但 durable reminder、mark 闭环和 compaction 后 cleanup 仍未完全收敛。若任务涉及 runtime hook 行为、projection 语义或生命周期缺口，应先读本目录。

---

## DCP

[dcp/lifecycle-and-runtime-contract.md] — DCP 生命周期与当前 runtime 主契约
