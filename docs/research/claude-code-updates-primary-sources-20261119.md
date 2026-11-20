# Claude Code 官方更新与 CoderFleet 接入判断 · 2026-11-19

调研截至 **2026-11-19 America/Los_Angeles**；实际核对时间为 2026-11-20 06:34 UTC，即洛杉矶 11 月 19 日 22:34。只读取官方资料与本地基线并新增本文；未升级镜像、修改配置、操作服务或会话，也未调用真实模型。

**最值得先做的是为 SDK 自带 CLI 建立升级验收，随后产品化 dynamic workflows 和隔离的后台执行。** 11 月新增功能中，Code Mode 很醒目，但它明确不支持 CoderFleet 调度采用的 `-p`/Agent SDK。后台 agent、worktree、`/loop` 等多数早于本次基线，不能当成这周才发布的能力。

## 证据与当前基线

- [2026-11-12 本仓库验收记录](claude-sdk-capability-acceptance-20261112.md)固定 **Python SDK 0.2.180 / bundled CLI 2.1.321**，已经接入工具批准、增量输出、运行中控制、后台 ID/停止、Hooks/Skills/plugins/MCP 配置、原生会话与文件检查点。记录明确没有真实覆盖长时间后台 agent 和各 OS sandbox。本报告不把这些既有能力再报为新缺口。
- [Dockerfile](../../coderfleet/data/Dockerfile)使用 Ubuntu 24.04、Node 22、多架构 amd64/arm64、非 root `byclaw`，设置每账号的 `CLAUDE_CONFIG_DIR`；全局 CLI 使用未固定版本的 `npm install -g @anthropic-ai/claude-code`，SDK 则安装在独立 venv 并带自己的 CLI。**全局 npm 包、SDK wheel 内 CLI 和实际运行容器是三项独立版本事实**；本文未读取运行容器版本。
- 在线核对时，[npm 官方 registry 的 latest](https://registry.npmjs.org/@anthropic-ai/claude-code/latest)与 [Anthropic GitHub 最新 release](https://github.com/anthropics/claude-code/releases/tag/v2.1.329)均为 **2.1.329**。npm 包要求 Node `>=22.0.0`，列有 Linux x64/arm64 及 musl 原生包，符合本镜像的平台方向；仍需独立验证安装与实际执行路径。
- 版本发布时间取自 [Anthropic 仓库 GitHub Releases API](https://api.github.com/repos/anthropics/claude-code/releases?per_page=10)的 `published_at`，行为说明取自对应 release 与当前官方文档。当前文档会滚动更新；“现在文档支持”不等于“2.1.321 已实际验收”。没有官方最小版本或首发日的项会明确标为未查明。

## 基线之后真正发生的增量

以下为已发布且不晚于本次截止日的相关版本。时间均为 2026 年，UTC 与洛杉矶（PST，UTC−8）分别列出，避免把 UTC 的 11 月 19 日误写成本地 11 月 19 日。

| CLI | GitHub published_at（UTC） | 洛杉矶时间 | 对本项目重要的增量 |
| --- | --- | --- | --- |
| [2.1.321](https://github.com/anthropics/claude-code/releases/tag/v2.1.321) | 11-09 19:22:30 | 11-09 11:22:30 | 本地验收基线；不是当前官方最新版 |
| [2.1.322](https://github.com/anthropics/claude-code/releases/tag/v2.1.322) | 11-10 02:29:43 | 11-09 18:29:43 | Vertex fast mode；与当前核心接入优先级较低 |
| [2.1.323](https://github.com/anthropics/claude-code/releases/tag/v2.1.323) | 11-12 22:12:13 | 11-12 14:12:13 | Code Mode 首发；插件 CLI 版本约束；`-p`/SDK 长 Hook 每 30 秒心跳 |
| [2.1.325](https://github.com/anthropics/claude-code/releases/tag/v2.1.325) | 11-13 20:40:01 | 11-13 12:40:01 | zstd 响应解码安全修复；第三方网关压缩与异常退出后续聊修复 |
| [2.1.326](https://github.com/anthropics/claude-code/releases/tag/v2.1.326) | 11-16 22:11:05 | 11-16 14:11:05 | 后台会话网关/登录继承修复、会话恢复与 MCP 并发结果修复；Remote Control 经代理改用 CONNECT |
| [2.1.327](https://github.com/anthropics/claude-code/releases/tag/v2.1.327) | 11-17 23:17:45 | 11-17 15:17:45 | headless UUID 重送后恢复丢消息修复；`-p` 启动模型设置请求最多等 10 秒；MCP JSON 可从 stdin 读取 |
| [2.1.328](https://github.com/anthropics/claude-code/releases/tag/v2.1.328) | 11-19 01:14:04 | 11-18 17:14:04 | SDK interrupt 与 Send now 语义修复、流超时配置生效、MCP Hook fail-closed；增加禁止 deferred tool 自动恢复的开关 |
| [2.1.329](https://github.com/anthropics/claude-code/releases/tag/v2.1.329) | 11-19 22:14:41 | 11-19 14:14:41 | 后台 stop/resume 竞态、MCP 重连/卸载、headless rewind/fork 竞态，以及长 SDK 会话内存改进 |

## 七项最有价值的接入方向

### 1. 先升级真正执行 SDK Task 的运行时，再验证已有控制语义

这轮更新直接覆盖 CoderFleet 已有功能的薄弱交错，而非只增加菜单：2.1.327 修复进程被杀后以同 UUID 重送导致 headless 恢复丢消息；2.1.328 修复 SDK interrupt 后仍告诉模型后台 agent 在跑，以及 Send now 把已停止的 WebSearch 误报成“无结果”；2.1.329 修复 agent 恢复过程中停止仍继续运行、模型变更后排队消息与 headless rewind/fork 的竞态。[2.1.327](https://github.com/anthropics/claude-code/releases/tag/v2.1.327)、[2.1.328](https://github.com/anthropics/claude-code/releases/tag/v2.1.328)、[2.1.329](https://github.com/anthropics/claude-code/releases/tag/v2.1.329)

**接入判断：最高优先级。** 先找到包含目标 CLI 的官方 SDK wheel，固定 SDK 与 CLI 配对；更新全局 npm CLI不能代替它。验收应重放“运行中补充→中断→后台结果到达→模型变更→分叉/恢复”交错，并检查最终回执与持久化，而不是只测 `--version`。这是工程建议；本文未宣称现有生产环境已复现这些上游问题。

### 2. Dynamic workflows：当前基线已够，可直接做受控产品入口

这项是 **2026-05-28 / CLI 2.1.154** 发布的旧能力，当前已 GA；官方 Python cookbook 明确最低 **SDK 0.2.90（bundled CLI ≥2.1.154）**。它让 Claude 生成可保存、重跑的 JavaScript 编排，后台运行大量 subagents。CLI、`-p` 与 SDK 都有路径；付费计划和 API/Bedrock/Google/Foundry 可用，Pro 需在 `/config` 开启。[发布文章](https://claude.com/resources/articles/introducing-dynamic-workflows-in-claude-code)、[2.1.154](https://github.com/anthropics/claude-code/releases/tag/v2.1.154)、[官方 Python cookbook](https://platform.claude.com/cookbook/claude-agent-sdk-08-dynamic-workflows)

**接入判断：最值得扩展的工作流能力。** 作为单个 CoderFleet Task 内的执行方式，复用现有后台消息、通用审批、用量和日志，不应冒充 CoderFleet 的跨 Task DAG。已有 SDK 和通用权限回调可以承载 `Workflow`，缺的是有界预设、原生进度归属和专项验收，而非基本执行能力。`Workflow` 调用可走 `canUseTool`、allow rule 或 Hook 审批。SDK 中只靠提示词写 `ultracode` 不可靠：官方限定该关键字为人类输入，SDK 需把真实键盘输入标为 `origin: {kind: "human"}`；`-p`、自动定时、webhook 或未标来源的 SDK 输入不因此自动启用。非交互/SDK 不享有交互终端的“配额重置后自动继续”等待。接入前应验证当前 Python SDK 的来源字段/启动路径，而不是伪造输入来源。[Workflow 启动与权限](https://code.claude.com/docs/en/workflows#where-the-keyword-works)、[配额等待限制](https://code.claude.com/docs/en/workflows#when-a-run-hits-your-usage-limit)

### 3. 后台 session 与 worktree：先分清执行所有者，再提供并行隔离

Agent view 是 **2026-05-11 / 2.1.139** 发布、至今仍为 research preview 的独立后台会话管理器。`claude --bg`、`claude agents --json`、`claude logs/attach/stop` 让终端用户管理无终端附着的完整会话；它有自己的 per-user supervisor，生命周期超出启动 shell。**`--bg` 与 `-p` 明确互斥**，它不等于 SDK Task 内的后台 subagent。[2.1.139](https://github.com/anthropics/claude-code/releases/tag/v2.1.139)、[Agent view](https://code.claude.com/docs/en/agent-view)、[Headless 模式](https://code.claude.com/docs/en/headless#basic-usage)

worktree 的 CLI `-p --worktree` 有官方支持；agent 定义的 `isolation: worktree` 与 `WorktreeCreate/Remove` Hooks 于 **2026-02-20 / 2.1.50** 加入。它们隔离文件修改，同时共享 Git 历史；Hook 中 `CLAUDE_PROJECT_DIR` 仍是初始项目根，输入 JSON 的 `cwd` 才跟随 worktree。[2.1.50](https://github.com/anthropics/claude-code/releases/tag/v2.1.50)、[Worktrees](https://code.claude.com/docs/en/worktrees)

**接入判断：优先验证现有 Task 的 worktree 与子 agent 隔离，不把 Task 转交给不可见 daemon。** 若以后支持 agent view，应显式记录 supervisor/job/session/worktree 所有权、进程恢复和清理，禁止两个调度器同时拥有同一执行。项目依赖、Git ignored 文件和挂载路径需单独准备；不能仅由“会话已 fork”推断文件隔离。后台会话的代理/CA/mTLS 设置需来自账号 settings 或 managed settings，不能只依靠先启动 supervisor 的某个 shell；已运行 supervisor 不会自动获得后来的启动配置。[后台网络配置](https://code.claude.com/docs/en/network-config#apply-network-settings-to-background-agents)

### 4. MCP 长任务：有原生 SDK 路径，但不是所有 MCP 调用都能持久后台运行

当前官方文档把 server-side MCP tasks 标为 **public beta，CLI ≥2.1.304**；2.1.304 发布于 **2026-10-19 21:34:39 UTC（LA 14:34:39）**。服务端任务可以在 CLI 退出后继续，并在恢复原会话后重新跟踪；普通慢 MCP 调用超过阈值后移入后台则不能跨退出保存。[MCP tasks](https://code.claude.com/docs/en/mcp#mcp-tasks-that-run-on-the-server)、[2.1.304](https://github.com/anthropics/claude-code/releases/tag/v2.1.304)

**接入判断：适合构建、导出、远程评审等外部耗时工具，需小范围验收。** 必须是支持 tasks 的服务端、2026-07-28 协议、主会话调用、可用的 feature flags；SDK/stream-json 还需 `CLAUDE_AUTO_BACKGROUND_TASKS=1`，保持输入开启，并保持相关后台开关允许。一次性 `-p "prompt"` 不支持。非交互任务请求用户输入时会被取消，不走 SDK `onElicitation`；关闭 Task 输入不能假报远端任务已停止，取消也不保证服务器没有完成副作用。[完整前提与生命周期](https://code.claude.com/docs/en/mcp#what-a-call-needs-to-become-an-mcp-task)

当前 CoderFleet [主服务依赖](../../pyproject.toml)仍固定为 `mcp==1.12.4`，[平台 MCP](../../coderfleet/server/platform_mcp.py)为普通 FastMCP request tools，尚未接入这个 tasks 协议；这是对当前代码的只读核对结果。客户端 CLI 更新不会自动把这些服务端工具变成原生 MCP tasks。主服务的 FastAPI/Starlette/SSE 兼容约束也不应因 SDK 侧升级被一并浮动。

### 5. Hooks、Skills、plugins：新增的是可靠交付与版本约束，不是基本加载能力

基线已有这些扩展。值得补的增量是：2.1.323 的 `plugin.json` `engines["claude-code"]` 兼容范围和 TS Hook 校验、`-p`/SDK 长 Hook 心跳；2.1.328 的 `mcp_tool` Hook `onFailure: "block"`、`CLAUDE_CODE_DISABLE_DEFERRED_TOOL_RESUME`，以及插件 `network.hosts` 声明；2.1.329 的 headless 插件卸载后 MCP 连接清理修复。[2.1.323](https://github.com/anthropics/claude-code/releases/tag/v2.1.323)、[2.1.328](https://github.com/anthropics/claude-code/releases/tag/v2.1.328)、[2.1.329](https://github.com/anthropics/claude-code/releases/tag/v2.1.329)

**接入判断：将扩展包作为可复现环境交付。** 为项目级插件增加版本兼容检查、`claude plugin validate --strict`、已加载/失败的可见状态与有限 reload 验证，复用现有配置快照。`network.hosts` 仅声明外联，不会自行允许或禁止网络；不能把 manifest 当成防火墙。`onFailure: block` 是失败行为契约，需区分 SDK Python Hook callback 与 CLI command/HTTP/MCP Hook 的各自支持，不把 CLI 新字段存在当成当前 Python 类型已接入。[Manifest](https://code.claude.com/docs/en/plugins/manifest-reference#fields)、[Hook reference](https://code.claude.com/docs/en/hooks)、[Plugin CLI](https://code.claude.com/docs/en/plugins/cli-reference)

### 6. 长会话：压缩与历史恢复值得继续验收，历史列表不是完整上下文

2.1.325 修复第三方网关反复 context length error、异常退出后近期消息丢失；2.1.326/327 继续修复异常结束、内存不足和重送 UUID 后的恢复；2.1.328 修复自动压缩复用旧 system prompt；2.1.329 改善包含截图/大工具结果的 SDK 恢复与闲置内存。[2.1.325](https://github.com/anthropics/claude-code/releases/tag/v2.1.325)、[2.1.326](https://github.com/anthropics/claude-code/releases/tag/v2.1.326)、[2.1.327](https://github.com/anthropics/claude-code/releases/tag/v2.1.327)、[2.1.328](https://github.com/anthropics/claude-code/releases/tag/v2.1.328)、[2.1.329](https://github.com/anthropics/claude-code/releases/tag/v2.1.329)

**接入判断：强化现有原生会话、上下文读数与检查点入口。** 压缩后恢复使用摘要、保留的未压缩消息及新消息，不会重新加载摘要覆盖的全部 transcript；中断工具不会因 resume 自动重放。根 CLAUDE.md、部分技能/规则会按官方机制重载，早前 Hook 注入的上下文通常会被摘要化，需要在 `SessionStart` 的 `compact` 事件重新提供关键约束。UI 应区分 transcript 历史、模型当前上下文和文件恢复能力。[Sessions](https://code.claude.com/docs/en/sessions#what-a-resumed-session-restores)、[Compaction](https://code.claude.com/docs/en/context-window#what-survives-compaction)

### 7. 远程、移动和定时：可做入口扩展，运行边界必须保留

Remote Control 的 CLI 子命令在 **2026-02-24 01:40:58 UTC（LA 02-23 17:40:58）/ 2.1.51** 已存在，允许浏览器/iOS/Android 操作仍在本机执行的会话。当前要求 claude.ai 订阅，API key 不支持；Team/Enterprise 还需组织开启与相应角色。自定义 `ANTHROPIC_BASE_URL`、第三方 provider、关闭 feature flags 等会阻止它。标准 `HTTPS_PROXY` 外联代理不等于自定义模型端点，但自 2.1.326 起代理必须允许 CONNECT。[2.1.51](https://github.com/anthropics/claude-code/releases/tag/v2.1.51)、[Remote Control requirements](https://code.claude.com/docs/en/remote-control#requirements)、[2.1.326](https://github.com/anthropics/claude-code/releases/tag/v2.1.326)

Cloud sessions 则在 Anthropic 或企业 self-hosted 环境运行，`--cloud`/`--teleport` 是另一条执行路径；官方于 **2025-10-20** 首发 web，并在原文注明 **2026-09-23 GA**。它不能直接视为沿用 CoderFleet 当前容器、账号挂载和 relay。[官方发布与 GA 注记](https://claude.com/resources/articles/claude-code-on-the-web)、[Cloud execution](https://code.claude.com/docs/en/claude-code-on-the-web)

`/loop` 于 **2026-03-07 00:12:46 UTC（LA 03-06 16:12:46）/ 2.1.71** 加入，是会话内计时；只有进程运行且空闲时触发，错过多次仅补一次，有 7 天到期与恢复例外。cloud scheduled tasks 是独立 research preview，可由时间/API/GitHub 触发，需要订阅与组织权限；Desktop scheduled tasks 又是本机应用功能。`/goal` 则是 **2.1.139 / 2026-05-11** 的跨轮完成条件，不是定时器，模型判断完成也不能替代 CoderFleet 验收。[2.1.71](https://github.com/anthropics/claude-code/releases/tag/v2.1.71)、[Session scheduling](https://code.claude.com/docs/en/scheduled-tasks)、[Cloud scheduling](https://code.claude.com/docs/en/routines)、[Goal](https://code.claude.com/docs/en/goal)

**接入判断：保留 CoderFleet scheduler/Workflow 为持久执行所有者，优先复用现有移动控制入口。** 原生 Remote Control 可作为具备资格账号的可选接入，需核对 session 归属及双端审批竞态。Channels 是持续 MCP 推送的 research preview，要求 Anthropic 认证，Team/Enterprise 需显式启用；官方 Telegram/Discord 插件需 Bun，iMessage 限 macOS；不应直接取代现有 Telegram bridge。当前 Channels 与 cloud schedules 文档没有给出完整最低 CLI 版本或首发日期，本文不补猜。[Channels](https://code.claude.com/docs/en/channels)、[Feature availability](https://code.claude.com/docs/en/feature-availability)

## 明确排除或限制的“新功能”

| 能力 | 官方边界 | 对 CoderFleet 的判断 |
| --- | --- | --- |
| Code Mode，2.1.323 / 2026-11-12 首发 | experimental、默认关闭，要求 native build、受支持的当前模型与官方直连账号；仅交互式终端，不支持 `-p`/SDK、VS Code panel、Desktop、cloud；不能转入 background session 或使用 Remote Control | 不列为 scheduler SDK 新能力；只可在未来单独评估交互终端体验。[官方要求](https://code.claude.com/docs/en/code-mode#requirements) |
| Agent teams，2.1.32 / 2026-02-05 首发 | experimental、需 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`；teammate spawning 限交互会话，`-p`/SDK 中命名 agent 仍是普通 subagent；in-process teammates 不随 `/resume` 恢复 | 不能靠加一个 env 就获得 SDK 多会话团队。[首发](https://github.com/anthropics/claude-code/releases/tag/v2.1.32)、[当前限制](https://code.claude.com/docs/en/agent-teams#enable-agent-teams) |
| Agent view daemon | research preview；有独立 supervisor/状态目录；`--bg` 不接受 `-p` | SDK 原生后台 subagent 与 daemon sessions 分别管理，不能共享一个“后台任务”布尔字段。[Agent view](https://code.claude.com/docs/en/agent-view)、[Headless](https://code.claude.com/docs/en/headless) |
| `--bare` 加速 | 会跳过自动发现的 Hooks、Skills、plugins、MCP、CLAUDE.md、auto memory；不使用 subscription OAuth，背景任务关闭 | 不是当前丰富扩展环境的无损加速开关；未来 `-p` 默认变化要单独处理。[官方行为](https://code.claude.com/docs/en/headless#start-faster-with-bare-mode) |
| Desktop UI 专属调度、模拟器、computer use | UI、运行平台与账号资格有各自限制；Linux Docker 中存在 CLI 不等于有桌面 GUI | 不从产品页面宣传推导 SDK 接口；以具体文档/类型/真实隔离验收为准。[Platforms](https://code.claude.com/docs/en/platforms) |

## 容器、relay、proxy 与权限的具体适配要求

1. **保持双版本可追溯。** 镜像构建产物同时记录全局 CLI、SDK 版本和 SDK 实际 executable 的 CLI 版本；分别验证 amd64/arm64 安装。本次看到的 npm `latest` 是版本证据，不是升级授权。
2. **保持账号外层隔离。** Hook、本地 MCP、LSP 和 plugins 能启动进程；Claude Bash sandbox只覆盖 shell 命令，不能代替整个容器隔离。Linux/WSL2 依赖 bubblewrap/socat；本 Dockerfile 未显式安装这两项。nested Docker 的 `enableWeakerNestedSandbox` 会降低内部隔离，不能把配置解析成功当成 sandbox 真正生效。[Sandbox 边界与 Linux 依赖](https://code.claude.com/docs/en/sandboxing)
3. **验证代理链而非仅检查变量存在。** 官方支持 HTTP/HTTPS proxy，不支持 SOCKS。2.1.323 后组织设置/策略请求不再使用仅 `ALL_PROXY` 的配置，应提供正确 `HTTPS_PROXY`；2.1.327 修复 `-p` 启动在代理模型设置请求处卡死；2.1.328 修复 `CLAUDE_STREAM_IDLE_TIMEOUT_MS` 未延长网关/custom base URL/provider 的五分钟连接上限。保持 relay 网络约束，测 HTTP CONNECT、TLS/CA、流式静默超时和 MCP reconnect。[官方网络配置](https://code.claude.com/docs/en/network-config)、[2.1.323](https://github.com/anthropics/claude-code/releases/tag/v2.1.323)、[2.1.327](https://github.com/anthropics/claude-code/releases/tag/v2.1.327)、[2.1.328](https://github.com/anthropics/claude-code/releases/tag/v2.1.328)
4. **保留明确权限模式。** `auto` 是分类器审批，`dontAsk` 是需要提示时拒绝，`bypassPermissions` 又是另一模式；不可随 CLI 交互默认变化重写现有 Task 的语义。2.1.328 扩大部分 provider 的 auto mode，但不证明所有模型/账号/网关可用。文件工具与 shell sandbox是不同边界；`blockWritesOutsideWorkingDirectories` 不限制 MCP/Hook 或任意 shell 写入。[Permission modes](https://code.claude.com/docs/en/permission-modes)、[2.1.328](https://github.com/anthropics/claude-code/releases/tag/v2.1.328)
5. **检查挂载与生命周期。** worktree、scheduled-task 状态、session/transcript、daemon socket/roster 和账号配置需要各自归属；本机 socket、Linux sandbox 内 localhost、Docker relay 地址不是同一网络空间。后台 job 未结束前不得清理工作目录；升级退出对远端 MCP task 的副作用状态应明确保留为未知或待跟踪。[Worktrees](https://code.claude.com/docs/en/worktrees)、[Linux localhost](https://code.claude.com/docs/en/sandboxing#a-command-fails-to-reach-a-server-on-localhost)、[MCP task 生命周期](https://code.claude.com/docs/en/mcp#exit-clear-or-resume-while-an-mcp-task-runs)

## 下一轮验收建议与本次证据边界

建议的首个可交付切片是 **固定新版 SDK/bundled CLI 的隔离镜像 + 既有功能回归**；其次是单目录、受预算与审批约束的 native dynamic workflow；再评估 worktree 与外部 MCP task。独立 daemon、Remote Control 和 cloud scheduling 涉及额外的所有权/账号边界，排在其后。

首轮应覆盖：中断时后台 agent 恢复竞态；运行中人工补充与长 WebSearch；model change 后 fork/rewind；压缩前后人工输入不丢失；同 UUID 重送后的恢复；长 Hook 心跳和失败关闭；MCP 长断线/取消/未知结果；代理静默超时；worktree 文件与账号状态不串用。所有这些都是**待执行验收**，本文只证明官方契约及适配理由。

已完成的是官方网页、GitHub release/API 与 npm 元数据核对，以及上述两份本地基线阅读。未读取凭据、安装新版、构建镜像、重启容器、改变生产会话或做真实模型/网络路径验收。上游 release 标明修复，不证明 CoderFleet 已有相同故障，也不证明更新后适配自动成立。本文只新增研究文档，验证以 Markdown 内容检查和 diff check 为界。
