# Mac 辅助程序原型

研究用的一次性原型，结论和设计见 `docs/research/mac-helper-for-container-agents-20261125.md`。

它是一个带令牌的 MCP 服务器：容器里的 Claude Code 通过它跑命令、截屏、列串口；每次调用先过 `policy.json`（拒绝 / 要人确认 / 放行，默认拒绝），再写一行审计。

```bash
./run_demo.sh              # 自检 + 用 claude -p 走一遍完整链路，记录写到 runs/<时间>/
SKIP_CLAUDE=1 ./run_demo.sh  # 只跑不经过模型的自检
```

在 Mac 上跑同一个脚本，截图就是真屏幕（需要给终端「屏幕录制」权限），`write-flash` 这类命令会弹系统对话框问你。这两段在 Linux 容器里没有运行过。

`runs/20261125-014153/` 是 2026-11-25 在 CoderFleet 容器里的一次完整运行记录。
