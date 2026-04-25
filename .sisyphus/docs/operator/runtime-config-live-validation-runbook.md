# Runtime Config 实时验证 Runbook（已实现）

## 文档定位

本文档承接旧 `.sisyphus/drafts/2026-04-08_design-aligned-config-validation-runbook.md` 的正式落点。它描述如何在真实宿主中，对当前 runtime configuration surface 做 artifact-driven 验证。

## 适用范围

本 runbook 面向**真实宿主 / live validation**，不是自动化测试计划。

它覆盖当前 runtime config 中最关键的行为面，包括：

- 配置文件选择与 env 覆盖
- reminder 阈值与 cadence
- delete admission gate
- scheduler threshold 与 marked-token threshold 的关系
- compaction lock timeout 与 send-entry gate 释放语义
- prompt 资产有效性与拒绝语义
- prompt provenance 与 model fallback 顺序

## 非协商验证规则

1. **不要用仓库测试代替业务证明**
   - 这里验证的是真实宿主行为，不是仓库内 test green。

2. **以真实 host artifacts 为真相**
   - `opencode export <session-id>`
   - repo-owned runtime log JSONL
   - repo-owned seam observation JSONL
   - repo-owned debug snapshots
   - repo-owned SQLite sidecar
   - repo-owned lock files
   - 必要时 mitmproxy captures

3. **不要从模型 prose 推断工具成功**
   - 对 `compression_mark` 来说，必须有 host-visible tool evidence。

4. **必须使用当前 projected visible IDs**
   - 不允许使用宿主 `msg_*` 或猜测 ID。

5. **不要让实现现状覆盖设计**
   - 若观察结果与当前设计不一致，应记录为 drift / non-conformance。

## 当前建议的验证主题

### 1. Config 文件选择与 env override

验证：

- OpenCode config 目录下的 canonical live config file 是否被正确选中
- field-level env override 是否按优先级覆盖
- 空白 env 值是否被拒绝，而不是被静默当成 unset

### 2. Reminder threshold / cadence / prompt variant

验证：

- `hsoft` / `hhard`
- `softRepeatEveryTokens` / `hardRepeatEveryTokens`
- `allowDelete` 不同场景下 reminder prompt variant 的选择

### 3. Delete admission gate

验证：

- `allowDelete=false` 时 delete 请求被阻止
- `allowDelete=true` 时 delete 请求具备进入路径的资格

### 4. Scheduler threshold vs marked-token threshold

验证：

- `schedulerMarkThreshold`
- `markedTokenAutoCompactionThreshold`

二者不要被混成同一个触发条件。

### 5. Lock timeout 与 send-entry gate

验证：

- `compressing.timeoutSeconds`
- stale lock 的忽略/释放语义
- ordinary send 在 gate 下的等待与恢复边界

### 6. Prompt asset validation

验证：

- reminder prompt 必须是 plain text
- compaction prompt 是 template asset
- 缺文件、空文件、残留 placeholder 时应 fail fast

## 证据要求

每个 live scenario 都应产出：

- case-specific runtime/seam/debug artifacts
- session 级 sidecar / lock 证据
- 成功 / 失败分界说明

## 不应夸大的结论

- 不能把 live-host 中的局部观测直接写成完整 keep/delete 证明
- 不能把 plugin loaded 写成 projection / compaction / lock / delete 全部正确
- 不能把一轮单点成功误写成整个 config surface 已完整验证

## 相关文档

- `compression-mark-usage.md`
- `../architecture/verification-boundary.md`
- `../config/runtime-config-surface.md`
