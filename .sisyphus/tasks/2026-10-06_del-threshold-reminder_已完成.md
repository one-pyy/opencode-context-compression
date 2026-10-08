# 摘要阈值与退役提醒

## 进度

- M1 契约：已完成（用户确认仅在 soft/hard 提醒时按 del 切换，取消用户授权门槛）
- M2 计数与提醒：已完成（35 个相关测试通过，面板复用和实际 inspect 参数已验证）
- M3 提示词与工具：已完成（区分 compact 原文与 delete 摘要，条件加载 skill，自主用途判断）
- M4 文档与验收：已完成（构建与 65 个相关测试通过；16 个修改文件无语言服务错误；静态审查无实质问题）

## 已确认决策

1. `reminder.hdelete` 默认 60000；只有既有 soft/hard 提醒产生且 `del > hdelete` 时，追加退役指令并附带 delete inspect。
2. del 只计当前可见、已应用的 compact 摘要。先计算，提醒与面板复用同一结果；摘要本身不产生提醒。
3. 保留 soft/hard 的阈值、重复节奏、类型和锚点。compact 处理未压缩原文；自动 delete 检查不再用于后续工作的已压缩摘要。
4. 主助手此前未加载 `context-retire` 时再加载；不要求用户授权或逐段确认。仍有效的信息先留存并核对，不确定、活跃或尚需原文判断的内容保留。
5. `allowDelete` 继续作为能力开关，不自行开启。通用后台 delete 提示词的混合输入能力不变。
6. delete inspect 按当前实际可见文本计数：摘要、用户正文与未压缩文本；总数汇总条目。每条文本预计算结果供清单使用，摘要合计供提醒与面板复用。compact 清单保留原有策略口径。

## 契约入口

- `.sisyphus/docs/compaction/reminder-system.md`：提醒计数、触发与附带清单。
- `.sisyphus/docs/compaction/allow-delete.md`：删除准入与有效信息保留。
- `.sisyphus/docs/config/runtime-config-surface.md`：配置字段与默认值。
- `.sisyphus/docs/config/prompt-assets.md`：提示词与 skill 的职责。

## 实施与验证

1. 增加配置、预计算摘要 token 与面板复用 → verify：边界与复用测试，现有统计调度测试。
2. 追加退役正文、切换附带 inspect 参数与结果 → verify：60000 不切换、60001 切换、无 soft/hard 则无提醒、allowDelete=false 不切换。
3. 更新 skill、工具描述和提示词 → verify：语义审查，条件加载、用途判断、完整片段和无重复选区。
4. 同步受影响文档 → verify：任务差异与链接检查。
5. 验证实现 → verify：相关测试、类型检查、构建与只读静态审查。

## 恢复与证据边界

恢复点：`refs/checkpoints/summary-retirement-reminder/2026-10-06_recovery_3eb8c55d2fe5`。工作区已有计数与运行观察改动，保留其归属；本次不提交、不回退无关内容。

确定性测试验证触发与接线；真实模型是否遵循提醒、delete 输出是否完整保留有效信息，需要独立的真实会话质量验收。

全项目类型检查仍有 6 个既有诊断，本任务新增的夹具问题已修复。详情见 `.sisyphus/tmp/optimizations/2026-10-06_project-typecheck-baseline.md`。配置加载确认现有 live 配置默认取得 `hdelete=60000` 与仓库退役提示词，未改写 live 配置；安装的 skill 链接指向仓库资产。构建产物已更新，运行中的插件和启动时工具说明需重新加载后使用新规则。

后续计数修订：delete inspect 使用预计算的当前可见文本大小，摘要不再报被替代原文大小，短用户正文不再固定为零。soft/hard 提示词采用用户指定正文，退役追加正文仅保留条件加载与两个动作，清单说明集中在 skill。补齐 `history-replay-reader.ts` 中 inspect mode 的传递，实际调用与附带清单一致性断言通过。生产构建和 35 个相关回归检查通过，源码语言服务无错误；最终端到端测试夹具的语言服务两次超时，改用编译器检查与实际执行验证，详情见 `.sisyphus/tmp/optimizations/2026-10-06_lsp-fresh-diagnostics-timeout.md`。
