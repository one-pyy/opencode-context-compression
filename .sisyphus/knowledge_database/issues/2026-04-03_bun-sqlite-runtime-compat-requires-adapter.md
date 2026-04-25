## bun-sqlite-runtime-compat-requires-adapter
Date: 2026-04-03

### Symptom
真实 `opencode run` 加载 context-compression 插件时，SQLite sidecar 初始化可能在 Bun-flavored runtime 下失败，典型错误包括：

- `Could not resolve: "node:sqlite". Maybe you need to "bun install"?`
- `error: No such built-in module: node:sqlite`
- `SQLiteError: NOT NULL constraint failed: state_schema_migrations.applied_at_ms`

### Trigger Conditions
当插件在真实 OpenCode 运行时中进入 state layer，并且宿主执行环境不像普通 Node 那样暴露 `node:sqlite` 时触发。即使 module 顶层不再静态导入 `node:sqlite`，运行时实际执行数据库路径时仍会暴露该兼容问题。

### Resolution
state layer 必须通过本地 SQLite runtime adapter 访问数据库：优先尝试 `node:sqlite`，失败时回退到 `bun:sqlite`，并规范化 Bun SQLite 的 named parameter map，把 bare key 同步成 `:key` 形式。

该问题的关键不是换一个 import 写法，而是承认插件运行时可能是 Bun-flavored environment，并把数据库最小接口收敛到 adapter 契约上。

Tags: #runtime #sqlite #bun #trap #compatibility
