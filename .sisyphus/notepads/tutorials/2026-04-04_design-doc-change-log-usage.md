## design-doc-change-log-usage
Date: 2026-04-04

### Use When
用于后续根据 `DESIGN.md` 改代码、改配置或改测试，但又不能把设计文档误读成“当前代码已经全部做到”时。

### Goal
让后续执行者先区分：哪些是当前仓库中已经观察到的事实，哪些只是这轮新拍板的目标设计，避免把目标设计错当实现现状。

### Mechanism
本项目当前在插件根目录维护两类主文档：

- `DESIGN.md` —— 目标设计与当前统一后的权威契约
- `DESIGN-CHANGELOG.zh.md` —— 本轮相对当前版本/既有文档新增或重定义的改动项清单，并明确区分“已观察到”与“目标设计（可能尚未实现）”

后续实现者在动手前应先读 `DESIGN-CHANGELOG.zh.md`，再决定哪些项需要直接实现、哪些项需要先核对当前代码。

### Responsibilities
- `DESIGN.md` — 给出目标设计、术语定义、模块边界、配置契约
- `DESIGN-CHANGELOG.zh.md` — 标明哪些设计项是本轮新定的、哪些未必已在当前版本中落地
- `.sisyphus/notepads/decisions/*.md` — 保存更细粒度的设计澄清，供追溯来源与冲突裁定

### How To Apply Changes
- For 改代码前的核对：先读 `DESIGN-CHANGELOG.zh.md`，把 C 类（目标设计、可能未实现）逐项列成实现清单
- For 改配置前的核对：不要只看 `DESIGN.md` 的字段表，要同时看 changelog 里哪些字段是新拍板、哪些旧字段已废弃
- For 改测试前的核对：先判断测试是在验证“现状”还是“目标设计”；不要因为 `DESIGN.md` 更新，就假定旧测试立即失效或新行为立即已存在

### Commands
- `read DESIGN.md` — 了解目标设计全貌
- `read DESIGN-CHANGELOG.zh.md` — 了解这轮相对当前版本的改动项
- `grep "allowDelete|softRepeatEveryTokens|hardRepeatEveryTokens" DESIGN.md DESIGN-CHANGELOG.zh.md` — 快速定位本轮重定义的核心设计词

### Result
- 后续实现者不会再把 `DESIGN.md` 误当“当前代码现状说明书”
- 新拍板设计和已观察到的现状会被分层阅读
- 改代码时更容易按优先级拆分“先实现什么、先核对什么”

### Notes
- 这份 changelog 的价值在于“区分目标设计与现状”，不是替代 `DESIGN.md`
- 如果后续又发生新一轮设计收敛，优先追加更新 changelog，再决定是否同步重写设计正文
