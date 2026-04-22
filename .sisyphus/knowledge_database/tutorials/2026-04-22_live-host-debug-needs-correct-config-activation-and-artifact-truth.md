## live-host-debug-needs-correct-config-activation-and-artifact-truth
Date: 2026-04-22

### Use When
当任务进入真实宿主联调，需要验证插件是否真的加载、artifact 是否真实产出、以及工具调用是否真的进入执行面时使用。

### Mechanism
真实宿主调试最容易错在四件事：

1. 配置根本没有正确激活
2. 用宿主原始 `msg_*` 当作 `compression_mark` 的 visible id 输入
3. 把“模型说要调工具”误当成“工具已执行”
4. 把 SQLite/WAL 锁误当成 repo-owned compaction lock

因此 live-host 调试必须优先相信 repo-owned artifacts，而不是语言层表象。

### Steps
1. 先确认正确的隔离配置激活方式，避免用错 config path
2. 只在 fresh session 上调试，并保持 session ownership 单一
3. 优先看 repo-owned artifacts：runtime logs、seam logs、snapshots、sidecar DB、lock file
4. 若要强制 `compression_mark`，先从当前 projection 输出中取 visible ids，而不是直接使用宿主原始 `msg_*`

### Result
执行者不会再把“session 存在”“模型 reasoning 里出现 tool 名字”“database is locked”等弱信号误写成插件执行成功，而会按 artifact truth 判断真正发生了什么。

Tags: #live-debug #artifacts #verification #workflow
