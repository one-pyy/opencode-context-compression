# Delete 有效信息提炼实施

## 进度

- M1 核心实现（replay 输入、input-builder、result-group、delete.md）：已完成（90 个测试通过，生产构建通过）
- M2 手工授权与 recall 边界：已完成（33 个测试通过，其中 recall 新增 10 个；skill 已软链接到用户级搜索目录）
- M3 真实模型质量验收：进行中（复测遇 envelope 缺非空 `plan` / `compression_output`；ASR 两项遗漏待按纠正记录复核）
- M4 provider 模型限制元数据核查：未开始
- M5 提示词修订后复测：未开始

## 有效契约

- `.sisyphus/docs/compaction/allow-delete.md`：共同规则、目标与保留标准、输入选择、输出与替换、主 agent 与本地文档职责。
- `.sisyphus/docs/config/prompt-assets.md`：Delete Prompt 契约、硬约束。
- `.sisyphus/docs/config/runtime-config-surface.md`：模式对应的提示词、Token 计数服务、Env 覆盖。
- `.sisyphus/docs/compaction/compaction-lifecycle.md`：覆盖树规则、渲染算法、结果组原则、不可压缩占位块。
- `.sisyphus/docs/architecture/verification-boundary.md`：Delete 目标验收。
- `.sisyphus/docs/projection/projection-rules.md`：Replacement 渲染；`.sisyphus/docs/compaction/recall-tool-contract.md`：定位逻辑。

## 已实现与已验证

`src/compaction/replay-run-input.ts` 从结构化结果组选取最外层有效表示，delete 消费已应用 compact 摘要与未覆盖原文，拒绝切割摘要片段，检查系统角色；普通 compact 通过 opaque 与 `preservedFragments` 原样传递已有摘要。应用状态以后台执行器冻结的当前显示结果集合为准，独立调用时使用持久 applied 标记。

`prompts/delete.md` 定义有效信息提炼与公共 JSON envelope。配置新增 `deletePromptPath` 及环境覆盖，缺失/空资产报错。`input-builder.ts` 传递 hint，delete 不加 opaque 包装。工具说明与 delete reminder 已同步。`runner/result-group.ts` 保留 compact 摘要的来源位置；delete 仍使用既有整组提交与投影。

默认 direct LLM transport 使用模型限制检查实际组装的 delete 输入；计数失败时保守估算，元数据不足时依赖服务端容量校验。其精度与自定义 transport 边界见正式 Docs。备用 `plugin-client` 仅有导出，当前源码无运行时调用方，未为其扩建预算系统。

新增测试：

- `tests/architecture/delete-effective-input.test.ts`：7 个混合输入、范围、用户/系统、提示词缺失、compact 透传和失败保留测试。
- `tests/architecture/delete-input-budget.test.ts`：3 个预算来源、边界及计数失败测试。
- `tests/architecture/delete-prompt-config.test.ts`：2 个独立提示词、配置覆盖及错误处理测试。

最近验证命令：`node --import tsx --test --test-reporter=dot tests/architecture/*.test.ts tests/cutover/*.test.ts tests/e2e/compaction/input-builder-contract.test.ts tests/e2e/compaction/model-fallback-order.test.ts tests/e2e/interfaces/prompt-resolution.test.ts tests/e2e/interfaces/projection-replay-contract.test.ts tests/e2e/recovery/delete-admission-matrix.test.ts tests/e2e/database/result-group-atomicity.test.ts`，90 个测试通过。生产 `npm run build` 与 `git diff --check` 通过，核心源码及新增测试的文件级 LSP 无错误。

Oracle 两阶段静态审查未提出确认缺陷。其备用 transport 预算疑问经 owner 查证只涉及当前未调用入口，未采纳为实现修复；不另建空审查报告。审查会话为 `ses_f5a3eb4b3ffe0W2naankRAhgDc`。

## 手工授权与 recall 边界

正式契约见 `.sisyphus/docs/compaction/allow-delete.md` 的“用户授权”、`recall-tool-contract.md` 的“删除边界”和 `config/prompt-assets.md` 的“手工整理 Skill”。

`skills/context-retire/SKILL.md` 面向主会话助手，负责文件留存、选区、用户确认和工具调用；后台模型负责整理替换内容。主助手按项目既定规范留存文件，再说明可删范围、推荐删除的部分及依据，等待用户确认实际范围后才执行 delete。mark 工具说明与两份 delete-allowed reminder 已约束显式 skill 授权；所有自动提醒均引导 compact。配置键、四个资产路径和内部 kind 保持兼容。授权是模型行为约束，API 仍只用 allowDelete 做能力准入。

recall 依据持久 applied 记录和本次实际渲染的结果集合检查 delete 覆盖；相交时整段返回 RANGE_RETIRED，compact 范围保持可回查。投影构建器传入实际渲染消息，避免未被采用的结果被误判为生效。宿主档案及其他文本副本不被物理擦除。

验证：`node --import tsx --test --test-reporter=dot tests/architecture/recall-retired-range.test.ts tests/architecture/delete-effective-input.test.ts tests/architecture/02-token-thresholds.test.ts tests/e2e/interfaces/reminder-artifact-behavior.test.ts tests/e2e/interfaces/prompt-resolution.test.ts tests/e2e/interfaces/projection-replay-contract.test.ts`，33 个测试通过，其中新增 recall 测试 10 个；四个实现/测试文件的 LSP 无错误，差异检查和生产构建通过，20 个本地文档链接及 skill 元数据通过结构检查。用户选择以 owner 差异检查验收，Oracle 调用中止，未产生独立审查结论。

用户级 `/root/.config/opencode/skills/context-retire` 已软链接到仓库的 `skills/context-retire` 目录。链接指向及读取正文已核对；尚未验证宿主重新加载后的自动发现。用户也可明确指定仓库 skill 文件要求执行。

## 剩余工作与验证限制

最新提示词按“删去被覆盖内容，再无丢失整理当前有效信息”工作，详细资料由本地文件承载。质量判定以 `.sisyphus/tmp/delete-log-eval/adjudication-correction.md` 为纠正入口：无声标记约束的是 ASR 模型，60 秒超时的最终适用性尚未核实，两者未进入正文不足以证明实质遗漏，也不能据此宣告通过。原始评测材料保留在 `second-session/` 与 `final-state-report.md` 所列位置；代理样本仍有响应格式校验失败。用户要求“无疏漏再 commit push”的条件尚未获得完整证据。

评测入口支持 `DELETE_EVAL_SESSION`、`DELETE_EVAL_START`、`DELETE_EVAL_END` 和隔离输出目录。下一步先核查被引用文件是否完整承载有效契约，再确定是否需要修订提示词；不按已撤回的缺陷判定继续改写。

1. 复测已修订的 `prompts/delete.md` → verify: 第三轮已确认 `## 用户相关信息` 为第一段且保留“不会抓取 Google、主要绕过小网站”，但仍把“轮换 IP 抓取任务”“防接口风控”推导为用户用途；详见 `.sisyphus/tmp/delete-log-eval/rerun2-report.md`。随后加入来源标签规则，两次重试均因 `CompactionTransportMalformedPayloadError` 返回 envelope 缺少非空 `plan` / `compression_output`，详见 `.sisyphus/tmp/delete-log-eval/rerun3/error.json` 与 `rerun4/error.json`；来源标签规则尚未完成真实模型验证。
2. 检查目标 provider 的模型限制元数据与实际超限响应 → verify: 小预算拒绝不写入结果、不展开全量原文；缺少元数据时明确保留服务端兜底边界。不要改变宿主真实会话或全局开关来构造测试。
3. 针对复测报告中的用途边界、助手断言和证据来源问题修订 `prompts/delete.md`，再复用冻结输入复测；全部质量项通过后同步唯一实施状态章节，并把文件名由 `_未完成` 改为 `_已完成`；失败时继续记录具体反例并修复相关路径。

全量测试不能声明通过。`shopt -s globstar; node --import tsx --test --test-reporter=dot tests/**/*.test.ts` 曾得到 10 个失败：output-validation 的错误文本预期，result-group-read-model 的两项固定数据库残留，compression-mark-contract 的旧错误文本，plugin-hooks-contract 的行数断言，safe-transport-contract 的两项旧响应格式，transport-timeout-recovery 的旧编号格式，session-history-debug-contract 的序号，shipped-runtime-regressions 的 gate 日志预期。对应解析、历史、投影、数据库及测试源码与恢复基线一致；没有为获得绿灯改写断言。尚未在独立基线副本上复跑整个套件。

全量 `npm run typecheck` 仍报告 `bun:test` 类型缺失、`09-hook-inplace-mutation.test.ts` 的 fixture 类型问题及 `build-first-entry.test.ts` 的 dist 声明缺失。生产构建不受影响。原先未启用 globstar 的命令仅执行 architecture/cutover，不可当作全量测试证据。

## 恢复边界

当前可恢复基线为已推送提交 `4c764d4028dbcb643dbaddc02fc33e6b25b34e57`，提交不代表真实模型质量验收通过。本任务恢复检查点已在正式提交成功后移除。后续代码修改按新的未提交工作区间建立恢复边界；任务文件已移至 `.sisyphus/tasks/`，评测材料仍位于忽略的 tmp 目录，不属于远端交付。
