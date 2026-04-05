
## 2026-04-06 T1 配置 / Prompt / 资产契约对齐
- 仓库当前没有 `build` script；`npm run build` 失败是脚本面缺失，不是本次 T1 改动引入的运行时错误。当前可执行验证路径为 `npm run typecheck` 与 `npm test`。

## 2026-04-06 T2 公共工具契约切换：compression_mark
- `DESIGN.md` 要求 `mode=delete` 受“当前策略” admission 控制，但仓库当前没有独立、已定版的 delete-policy 真相源或单独配置面；T2 仅在工具实现层保留最小 admission seam，并用 contract test 覆盖拒绝分支，不在本任务内额外创造新的全局 policy 系统。

## 2026-04-06 T2 repair
- README / `readme.zh.md` 的公共契约改写不属于这次 repair 必需范围；验证并不依赖文档更新，因此已回退，避免把 T2 repair 扩成 T8 文档收敛工作。
