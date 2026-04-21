# opencode-context-compression — Knowledge Database Index

Project: /root/_/opencode/opencode-context-compression
Purpose: 记录 context-compression / DCP 子项目的 durable 设计决策、问题、规律与教程。

---

## Summary

这个子项目目前最重要的稳定知识有三类：

- 当前 clean-slate 设计采用 host history + SQLite sidecar + derived reminder/mark/compaction gating 的架构。
- 目标生命周期已经比较清晰，但当前运行时仍落后于该目标模型，尤其是在 durable reminder / mark / cleanup 语义上。
- DCP 相关知识必须区分“设计契约/当前实现参考”和“运行时问题/规律”；前者进 docs，后者进 knowledge database。

## Decisions

[decisions/2026-04-19_dcp-runtime-uses-sidecar-gated-compaction-and-derived-reminders.md] — DCP clean-slate 运行时采用 sidecar、显式 compaction gates 与受控 send gate #dcp #architecture #runtime

## Issues

## Learnings

## Tutorials

## Problems

[problems/2026-04-19_dcp-current-runtime-still-trails-target-lifecycle.md] — 当前 DCP 运行时仍落后于目标生命周期模型 #dcp #lifecycle #gap
