# CoderFleet 接入 Google Antigravity CLI 调研

日期为 2026-11-23。调研覆盖官方文档、ACP 规范、当前工作树和本机已安装 CLI 的帮助与版本检查。

## 接入结论

交互会话建议使用 `agy acp`。Google 提供 ACP v1 的 stdio JSON-RPC 服务，客户端可展示流式回复、工具状态、文件 diff 和审批请求，也能恢复会话和取消当前轮次。Headless 适合做连通性检查和独立批任务，需要人工确认的工具在该模式下可能被跳过，即便进程退出码为 0。 [Google ACP 客户端指南](https://antigravity.google/docs/ide/extensions/acp/) · [Google Headless 文档](https://antigravity.google/docs/cli/headless/)

## 上游版本与部署

- 官方变更记录显示，ACP 从 **1.5.0**（11 月 4 日）起提供。**1.5.1** 修复了取消、恢复和迟到通知的行为。**1.5.8** 增加 ACP 上下文窗口用量更新。**1.5.9** 修复 ACP 登录回退、错误详情和 diff 问题。建议首轮验证锁定官方页面列出的最新 CLI **1.5.12**（11 月 19 日），把版本和握手能力一起记录在验收结果中。 [Google 发布记录](https://antigravity.google/docs/changelog)
- Google 提供 macOS、Linux 和 Windows 安装方式。macOS/Linux 默认可执行文件在 `~/.local/bin/agy`。进程启动时可以配置绝对路径，避免服务进程与交互 shell 的 PATH 差异。部署探针可运行 `agy --version` 和 `agy acp --help`，登录状态需要用 ACP 请求进一步验证。 [Google 安装指南](https://antigravity.google/docs/getting-started?tab=cli#download-and-install) · [Google ACP 快速开始](https://antigravity.google/docs/cli/acp/)
- 可评估 ACP 项目的 Python SDK `agent-client-protocol`。该包提供异步 transport 和生成的协议模型。PyPI 的 1.0.0 支持 Python 3.10 至 3.15，与本仓库最低版本 3.10 相符。还需检查传递依赖、ACP v1 客户端 API 和对 Google 实际消息的解析容错。 [ACP Python SDK](https://agentclientprotocol.com/libraries/python) · [PyPI 版本元数据](https://pypi.org/project/agent-client-protocol/1.0.0/) · [仓库 Python 版本](../../pyproject.toml)

## ACP 可用能力和接入约束

| 能力 | 协议与适配建议 |
| --- | --- |
| 建连 | 以项目目录为工作目录启动 `agy acp`。stdout/stdin 是 UTF-8、换行分帧的双向 JSON-RPC，stderr 独立消费。先 `initialize`，再 `session/new`，按握手结果启用能力。 [Google ACP 客户端指南](https://antigravity.google/docs/ide/extensions/acp/#other-clients) · [ACP transport](https://agentclientprotocol.com/protocol/v1/transports) · [ACP 初始化](https://agentclientprotocol.com/protocol/v1/initialization) |
| 对话与工具 | `session/prompt` 发起轮次，`session/update` 推送回复、思考、工具状态和其他会话更新。用原请求的 JSON-RPC 响应和 `stopReason` 判定轮次终结。Google 文档还列出 diff、图像、嵌入文件、提问表单、运行中追加提示和自动标题。首轮可以只开放文本、工具状态、审批和取消，再用真实进程确认其余事件。 [ACP Prompt Turn](https://agentclientprotocol.com/protocol/v1/prompt-turn) · [Google ACP 客户端指南](https://antigravity.google/docs/ide/extensions/acp/#work-with-the-agent) |
| 审批与取消 | `session/request_permission` 是 agent 发给客户端的请求，需要对应 RPC 响应。按 agent 提供的选项回传 ID，轮次取消时结束待响应的审批。发 `session/cancel` 后继续消费该轮更新，等待 prompt 返回 `cancelled`。可用独立的进程超时处理无响应。 [ACP Tool Calls](https://agentclientprotocol.com/protocol/v1/tool-calls) · [ACP Prompt Turn](https://agentclientprotocol.com/protocol/v1/prompt-turn#cancellation) |
| 会话恢复 | Google 文档列出加载、恢复、列表和关闭。保存 ACP `sessionId` 以及对应运行范围，并以绝对 `cwd` 调用生命周期方法。已有本地聊天记录时优先使用 agent 宣告的 `session/resume`，其响应前不会回放历史。`session/load` 的历史回放需要和当前轮次流分开处理。 [Google ACP 客户端指南](https://antigravity.google/docs/ide/extensions/acp/#sessions) · [ACP Session Setup](https://agentclientprotocol.com/protocol/v1/session-setup) |
| 模型与用量 | 优先采用会话实际返回的模型、思考级别和模式选项，用 `session/set_config_option` 更新支持的配置。Google ACP 指南仍列出第三方模型客户端名单，1.5.1 变更记录称已开放账号可用模型给所有 ACP 客户端，因此以真实会话返回值为准。ACP `usage_update` 的 `used/size` 表示上下文窗口占用，可选 `cost` 表示累计费用，适配时分别于每轮 token 用量处理。 [Google 模型选项](https://antigravity.google/docs/ide/extensions/acp/#models-and-thinking-level) · [Google 发布记录](https://antigravity.google/docs/changelog) · [ACP 会话配置](https://agentclientprotocol.com/protocol/v1/session-config-options) · [ACP 用量更新](https://agentclientprotocol.com/protocol/v1/prompt-turn#session-usage-updates) |

## 认证和执行边界

- **本机登录。** `agy acp` 可以复用交互式 `agy` 的缓存凭证，也可以由运行用户执行 `agy acp --login`。缺少凭证时，Google 文档给出的 ACP 错误是 `-32000` 和 `Authentication required`。在 CoderFleet 中应结合错误内容判别授权状态，避免把这类通用服务错误码单独视为登录失败。 [Google ACP 认证](https://antigravity.google/docs/ide/extensions/acp/#authentication)
- **容器认证。** ACP 文档支持 `gemini-api-key` 读取 `GEMINI_API_KEY`，以及 `agent-platform` 使用 ADC 和项目、区域设置。通用 CLI 指南则给出了 `modelProvider: "gemini"` 搭配 API key，以及通过 `AGY_ADC_AUTH=true` 启用 ADC 的配置方式。按接入模式分别验证，凭证仅注入实际执行进程。在容器实验中应验证登录持久化、凭证缺失和过期错误。 [Google ACP 认证](https://antigravity.google/docs/ide/extensions/acp/#authentication) · [Google 通用认证指南](https://antigravity.google/docs/install?tab=cli)
- **工具与隔离。** Google 的权限规则可能直接放行或拒绝动作，ACP 审批只覆盖 agent 实际发给客户端的请求。ACP 的 `cwd` 是协议声明的工作目录，命令隔离取决于实际沙箱。Google 说明，禁用非特权 user namespace 的部分 Linux 容器会使 `--sandbox` 无效，Auto 模式也不可用。真实 Docker 验收应确认容器权限、挂载、执行模式以及审批是否按预期生效。建议先用会要求审批的配置验证端到端，并保留 CoderFleet 的容器边界。 [Google ACP 权限](https://antigravity.google/docs/ide/extensions/acp/#permissions) · [Google CLI 沙箱](https://antigravity.google/docs/sandbox/?tab=cli) · [ACP 工作目录](https://agentclientprotocol.com/protocol/v1/session-setup#working-directory)
- **MCP。** 初次握手可传空 `mcpServers` 验证基础路径。Google 文档说明，由客户端配置的 HTTP MCP server 需要 `--process-per-session`。工作区内发现的 MCP、插件和已有个人 CLI 的用户配置需要独立验证，容器运行配置可用独立的持久化范围。 [Google ACP 参数](https://antigravity.google/docs/ide/extensions/acp/#flags) · [ACP Session Setup](https://agentclientprotocol.com/protocol/v1/session-setup)

## Headless 的用途

- 单轮 `agy -p ... --output-format stream-json` 通过 stdout 输出 `init`、增量 `step_update` 和 `result`，诊断走 stderr。组合进程退出状态与 `result.status` 捕获失败。需要审批的动作可能被软拒绝，命令仍返回 0。1.5.7 之后，未配置模式时 `agy -p` 会在支持的环境中使用 Auto，自动化任务宜明确固定经验证的执行模式。 [Google Headless 文档](https://antigravity.google/docs/cli/headless/)
- 每轮新进程可通过 `--conversation <id>` 恢复；基于同一进程的连续轮次可用 `--input-format stream-json --output-format stream-json`，输入只支持文本，逐轮产生结果，部分计数按会话累计。在多用户或并发环境中，建议保存明确 ID，不使用 `--continue` 指向最新会话。 [Google Headless 会话文档](https://antigravity.google/docs/cli/headless/#continue-a-conversation) · [Google Headless stdin 文档](https://antigravity.google/docs/cli/headless/#stream-prompts-from-stdin)

## CoderFleet 落点与实施顺序

**建议采用容器优先、ACP 为交互主路径。** 用 Headless 做早期连通性验证。生产接入第一版就把会话续聊和工具审批跑通，这两项直接影响项目聊天的使用方式。调研基于当前 `codex/sdk-message-experience` 工作树，其中已有进行中的 Claude SDK 修改。

| 层 | 现有落点 | Antigravity 接入 |
| --- | --- | --- |
| 账号与安装 | [account_type_registry.py](../../coderfleet/account_type_registry.py)、[compose.py](../../coderfleet/compose.py)、[Dockerfile](../../coderfleet/data/Dockerfile)、[login_cmd.py](../../coderfleet/login_cmd.py) | 注册 `TYPE=antigravity`、二进制 `agy`，沿用账号配置、镜像、CLI 和 Web 创建流程。镜像固定通过验收的版本，确认 Linux amd64/arm64 的官方分发及校验方式。确定登录态、配置、会话数据的实际落盘位置后，再定挂载范围。 |
| 进程与日志 | [runtime.py](../../coderfleet/server/runtime.py)、[scheduler.py](../../coderfleet/server/scheduler.py)、[sdk_process.py](../../coderfleet/server/sdk_process.py) | 在账号容器内启动每 Task 一个 ACP worker。现有 `ContainerRuntime` 的外层进程接口主要用于出流，且合并 stderr。由 worker 直接持有 `agy acp` 的三路管道，分开解析协议和诊断，对外写完整行事件，保留现有 Task 生命周期、取消和日志恢复路径。Claude SDK worker 提供已实现的生命周期和控制回执参考。 |
| 会话 | [models.py](../../coderfleet/server/models.py)、[scheduler.py](../../coderfleet/server/scheduler.py) | 初始化后在新建 session 的响应中取得 ID，随首个会话事件写入 `Task/Conversation.native_session_id`。后续 Task 在同一账号和工作区以该 ID 恢复，再发送 prompt；沿用 Conversation 串行队列。恢复失败明确报错，避免继续到错误的会话。 |
| 工具审批和取消 | [main.py](../../coderfleet/server/main.py)、[task_cmds.py](../../coderfleet/task_cmds.py)、[sdk_process.py](../../coderfleet/server/sdk_process.py) | 交互首版显式选用服务端提供的 `default` 模式。把 ACP 权限请求映射到已有 Task 审批卡和 CLI 操作，保存请求与选项 ID。批准、拒绝、超时及取消都要关闭待审批状态。先请求原生取消，再确认进程组已收尾后释放队列。ACP worker 的状态与 Claude 专属 SDK 字段保持各自语义。 |
| 展示与统计 | [log_parser.py](../../coderfleet/server/log_parser.py)、[renderer.js](../../coderfleet/server/static/js/renderer.js) | 将文本增量、工具调用、工具结果、错误和结束原因映射到 CoderFleet 的日志与流式渲染。独立验证 Workflow 最终文本的提取，避免把增量文本和最终快照各记一份。ACP 首版只展示实测可得的模型和用量字段；上下文占用与每 Task token 用量是两种数据。 |

运行路径为 **CLI / Web → Task scheduler → 账号容器内 ACP worker → `agy acp`**。worker 的请求与响应可持续到 Task 终止。真实 CLI 在一个 prompt 返回后仍可能收到后台更新；交互首版的验收范围宜限制到单个前台 turn，确认权限请求结清、session 关闭及子进程清理后再提交任务终态。后台延续、插话、附件和原生表单可在实测相应能力后开放。 [Google ACP 指南](https://antigravity.google/docs/ide/extensions/acp/)、[Google 版本记录](https://antigravity.google/docs/changelog)

### 验收切片

1. **固定版本和运行环境。** 在隔离账号容器中验证 `agy --version`、`agy help acp` 和 ACP 初始化；使用临时项目及单独的测试账号环境。先用 Gemini API key 验证连通性和两轮续聊，再用 Google OAuth 验证订阅账号路径，包括冷容器、重建容器后的登录和会话恢复。CLI 能找到二进制、成功初始化、成功调用模型分别记录。用两套账号验证 session、凭据、缓存和 relay 出口的隔离。 [Google 认证文档](https://antigravity.google/docs/install/)、[Google ACP 指南](https://antigravity.google/docs/ide/extensions/acp/)
2. **跑通产品入口。** CLI 与 Web 各跑一次新会话和显式续聊；观察增量输出、工具事件和最终结果。用相同的安全测试操作分别验证批准、拒绝和等待中取消。验证账号未认证、无效 session ID、配额错误、进程退出及服务重启时，任务状态与 UI 一致，运行结果不明时不自动重放 prompt。先用协议 fixture 覆盖可重复的边缘情况，再跑固定版本的真实容器验收。 [ACP 会话规范](https://agentclientprotocol.com/protocol/v1/session-setup)、[ACP Prompt Turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)
3. **按实测扩展。** 先确定项目 `auto` 与 Antigravity 各模式的产品语义，再开放调度任务的自动执行；Antigravity 的 `auto` 仍可能触发审批。宿主机运行单独验收。当前本地凭据目录逻辑只区分 Codex 和 Claude，且本地进程继承宿主环境。要检查 keyring、HOME 与凭据环境变量的隔离，及本地代理是否确实生效，再开放 `runtime=local`。 [Google 执行模式](https://antigravity.google/docs/cli/modes/)、[CoderFleet 本地运行调研](local-execution-mode.md)、[当前调度器](../../coderfleet/server/scheduler.py)

### 本机实测边界

本机 PATH 解析到 `~/.local/bin/agy`，`agy --version` 返回 `1.1.5`，`agy help acp` 返回未知子命令，通用帮助也没有列出结构化输出相关 flag。当前执行环境访问官方 installer 时 DNS 解析失败，访问 OrbStack Docker socket 时被拒绝。此次确认了现有版本的命令边界，模型调用、OAuth、容器续聊、权限和 relay 仍待用固定版本实测。


### 实现版本

初始版本候选为 `1.5.12`。实现时从 Google 官方安装脚本定位到发布清单，amd64 和 arm64 都提供了 `1.5.15` 的版本化下载地址及 SHA-512，因此镜像和 worker 均固定在 `1.5.15`。 [amd64 发布清单](https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64.json) · [arm64 发布清单](https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_arm64.json)


Linux arm64 发布包通过 SHA-512 校验。在断网的 Ubuntu 22.04 临时容器中，实测 `agy --version`、ACP v1 初始化、用测试占位值选择 Gemini API key 认证方式、显式设置默认审批模式，以及创建、关闭并恢复空会话。容器未挂载真实凭据或项目，真实 OAuth、模型调用、已有聊天内容的续聊和 relay 出口仍待联网验收。
