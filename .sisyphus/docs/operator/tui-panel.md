# TUI 面板（已实现）

## 文档定位

记录压缩插件自带的 TUI 侧栏面板：它显示什么、数据从哪来、如何启用。

## 是什么

`src/tui.tsx` 是压缩插件的 TUI 入口。它与服务端入口 `src/index.ts` 同属一个包，是两个入口（一个模块不能同时导出 `server` 和 `tui`）。它在右侧栏 `sidebar_content` 注册两个独立区块：

- `cache` / `tools`：最近 N 轮 prompt cache 命中率、每轮工具调用数柱状图，注册 `order: 60`，紧随 visual-cache（`order: 55`）之后。
- `Compression`：三档 token，注册 `order: 110`，排在内置 `context` 面板（`order: 100`）之后。

四档 token（灰字）按「当前请求内容还能对它做什么」划分：

- `fixed`（不可压）：保护类（`system` / 短用户消息）+ `delete` 类 mark 的替换文本
- `del`（可delete）：`compact` 压缩后的摘要（referable result-group）
- `comp`（可压）：未被已应用 mark 覆盖、仍留在请求里的可压消息（text + tool）
- `think`（可压消息的 reasoning）：上述可压消息里的 reasoning token，单独显示

四者之和 = 当前实际请求内容。

`cache` / `tools` 原为独立的 `opencode-cache-spark` / `opencode-tool-spark` 插件，现已合并进本入口，不再单独注册。

## 数据通道

服务端在 `experimental.chat.messages.transform` 末尾，把当前 projection 汇总成三档 token，原子写入：

```text
<plugin-root>/state/<session-id>.stats.json
```

字段：`protectedTokenCount`、`deletableTokenCount`、`compressibleTokenCount`、`reasoningTokenCount`、`updatedAt`。计算口径（`src/runtime/compression-stats.ts`）：

- `protectedTokenCount` = 保护类 canonical 消息 token + `delete` 类 result-group 替换文本 token
- `deletableTokenCount` = `compact` 类 result-group（`visibleKind=referable`）摘要 token
- `compressibleTokenCount` = 仍留在投影里的可压 canonical 消息 token（`policy.tokenCount`，含工具输入/输出）
- `reasoningTokenCount` = 上述可压消息里的 reasoning token（单独一行显示，不并入 comp）

token 估算：可压 canonical 用 `policy.tokenCount`（插件自己的口径，含工具输入/输出，**不含 reasoning**）；reasoning 用 `estimateReasoningTokens` 单独估算；保护类与摘要文本用 `estimateTextTokensWithService`（服务不可用时退回字符近似 `ceil(len/4)`）。该函数为 async，估算器可注入（测试用字符近似，避免依赖服务）。

TUI 侧按 session 读取该文件；文件不存在时显示 `no data`。写入用临时文件 + rename，避免读到半写内容。

## 启用

`~/.config/opencode/tui.json` 的 `plugin` 数组加入本入口（通过 `~/.config/opencode/plugins/` 下的符号链接）：

```json
["./plugins/context-compression-tui.tsx", { "cacheBuckets": 20, "toolBuckets": 20 }]
```

服务端入口仍留在 `opencode.jsonc` 的 `plugin` 数组。改动后需重启 OpenCode。

## 边界

- 面板只读 `state/*.stats.json`，不参与压缩决策。
- 服务端未加载时无 stats 文件，面板显示 `no data`。
- 每 session 一个 stats 文件，随每次 transform 覆盖。
