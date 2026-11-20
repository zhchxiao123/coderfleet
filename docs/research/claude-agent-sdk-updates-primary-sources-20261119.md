# Claude Agent SDK 最新能力与 CoderFleet 增量机会 · 2026-11-19

研究日期按 America/Los_Angeles（PST）；本轮检索到 2026-11-19 晚间。只读取仓库与官方公开资料，下载公开包及源码作静态比对；没有安装 SDK、执行下载的代码、调用模型、改动源码/配置/服务/容器或读取真实会话。本文中的“可用”表示公开发行包/API 存在，不表示已经在 CoderFleet 完成真实验收。

## 结论

截至本轮检索，最新 Python 发行包为 **`claude-agent-sdk==0.2.186`，捆绑 CLI `2.1.329`**；TypeScript 为 **`@anthropic-ai/claude-agent-sdk@0.3.329`**，同样对应 CLI `2.1.329`。Python 包仍标记 Development Status Alpha。当前仓库安装器固定 **0.2.180 / 2.1.321**，不是最新版。[PyPI 元数据](https://pypi.org/pypi/claude-agent-sdk/json)、[Python 固定版本](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.186/pyproject.toml)、[捆绑 CLI 版本](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.186/src/claude_agent_sdk/_cli_version.py)、[npm 元数据](https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk)

**建议继续以 Python worker 为主，先评估小版本升级及运行可靠性，再决定是否需要 TypeScript 侧车。** 0.2.180→0.2.186 有真实 Python 改动：消息 UUID 关联、`client_app`、权限更新序列化及 settings+sandbox 加载失败处理；并非只换 CLI。另一方面，很多“新功能”在现有 [能力对照](claude-agent-sdk-capability-coverage-20261111.md) 与 [11 月 12 日验收记录](claude-sdk-capability-acceptance-20261112.md) 中已经接入，不能再作为全新缺口。此建议是基于下述官方 API 与当前适配代码的工程判断。[固定版本完整差异](https://github.com/anthropics/claude-agent-sdk-python/compare/v0.2.180...v0.2.186)

## 1. 版本、日期与证据口径

### Python 0.2.180 之后

时间取 PyPI 该版本最早上传文件，UTC 精确到秒；其通常比 GitHub Release 建立时间早几分钟。CLI 对应关系由固定 tag 的 `_cli_version.py` 变更核对。

| Python SDK | PyPI 首次上传 UTC | 洛杉矶当地时间 | 捆绑 CLI | 相对前版的主要关注点 |
|---|---|---|---|---|
| 0.2.180 | 2026-11-09 20:07:56 | 11-09 12:07:56 | 2.1.321 | 现有项目固定基线 |
| 0.2.181 | 2026-11-12 23:09:43 | 11-12 15:09:43 | 2.1.323 | `client_app`；settings+sandbox 无法安全合并时失败；CLI 版本检测及 Windows CLI 查找调整 |
| 0.2.182 | 2026-11-13 21:38:23 | 11-13 13:38:23 | 2.1.325 | CLI 行为修复；注意 sandbox 自动允许默认行为变化 |
| 0.2.183 | 2026-11-16 23:03:37 | 11-16 15:03:37 | 2.1.326 | 三种消息类型新增用户消息 UUID 关联 |
| 0.2.184 | 2026-11-18 00:29:52 | **11-17** 16:29:52 | 2.1.327 | `PermissionUpdate` 发给 CLI 的形状修复 |
| 0.2.185 | 2026-11-19 02:11:55 | **11-18** 18:11:55 | 2.1.328 | CLI 中断、后台 Agent、deferred tool 等行为更新 |
| 0.2.186 | 2026-11-19 23:00:29 | 11-19 15:00:29 | 2.1.329 | CLI 内存、插件 MCP 生命周期、配置警告等更新 |

来源：[PyPI 发布文件元数据](https://pypi.org/pypi/claude-agent-sdk/json)、[GitHub Releases](https://github.com/anthropics/claude-agent-sdk-python/releases)、[21 个提交的固定 tag 比对](https://github.com/anthropics/claude-agent-sdk-python/compare/v0.2.180...v0.2.186)。本轮所见 0.2.186 的 5 个平台 wheel 与 sdist 均未 yanked；Python 要求 `>=3.10`。

TypeScript npm 的 `latest` 与 `next` 均为 0.3.329；npm 上传时间 **2026-11-19 18:42:14.426 UTC / 10:42:14 PST**，GitHub Release 是 **22:14:51 UTC / 14:14:51 PST**。`package.json` 的 `claudeCodeVersion` 是 `2.1.329`，Node 要求 `>=18.14.0`。npm 发布时间与 GitHub Release 时间不同，不应混为一个“发布日期”。[npm 元数据](https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk)、[TypeScript v0.3.329 Release](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.329)

### 为什么不能只看 CHANGELOG 或最新网页

本轮固定 `v0.2.186/CHANGELOG.md` 顶部仍停在 0.2.178；它没有完整列出 181–186 的变化。相反，tag diff 含新选项、新字段及行为修复。官方 TypeScript 参考页也尚未列出已在 0.3.325 发布并进入 0.3.329 包声明的 `archiveSession`。因此以下顺序优先：**发行元数据 → 固定 tag/发行包声明 → 官方 guide → 动态参考页**；网页缺条目不能证明包里没有，协议类型存在也不能证明存在公共方法。[Python Changelog 固定快照](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.186/CHANGELOG.md)、[Python tag diff](https://github.com/anthropics/claude-agent-sdk-python/compare/v0.2.180...v0.2.186)、[TS v0.3.325 发布记录](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.325)

## 2. Python 真正新增的内容

### 2.1 消息关联：0.2.183 起

`AssistantMessage`、`StreamEvent`、`ResultMessage` 新增：

```python
user_message_uuid: str | None = None
user_message_uuids: list[str] | None = None
```

这可以把结果与用户发送的消息关联。调用方需要用 async iterable 发送带顶层 `uuid` 的消息字典；普通字符串 prompt 不带 UUID。每条消息应使用新 UUID，CLI 可能跳过见过的 UUID。`origin` 只说明谁启动该 turn；用户插话可能被一个后台通知启动的 turn 吸收，所以不能据此断言“此结果没有回答用户”。[引入提交 #1505](https://github.com/anthropics/claude-agent-sdk-python/commit/4720d367f7db9d5df8a166c74d7f36a538ac8c34)、[ResultMessage 固定定义](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.186/src/claude_agent_sdk/types.py#L1798)

边界：`user_message_uuids` 最多保留 64 项；缺席不一定代表未吸收。错误结果也可能携带 UUID，仍须检查 `is_error` 与 `terminal_reason`。`receive_response()` 到第一个 `ResultMessage` 就结束，持续后台会话应使用 `receive_messages()` 并做消息归属判断。[固定字段契约](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.186/src/claude_agent_sdk/types.py#L1394)

**本项目覆盖判断：** worker 已用 `receive_messages()` 持续读取，并由原始 transport 透传事件；“改成持续读取”不是已证实缺口。下一步应核对每条 mailbox 插话是否有稳定唯一 UUID，以及 UI/Task 的 delivered、answered、interrupted 状态是否使用上述关联字段。升级 typed 字段本身不会自动完成产品状态机。[当前 worker](../../coderfleet/data/scripts/coderfleet_claude_sdk_worker.py)

### 2.2 权限记忆的序列化修复：0.2.184 起

`PermissionUpdate.to_dict()` 的签名不变，但行为变化：`destination=None` 现在发为 `session`；全工具规则省略 `ruleContent`，不再发 `null`；各更新类型缺必要字段会抛 `ValueError`。`PermissionResultAllow.updated_permissions` 中任一更新无法转换时，SDK 不发送整批更新并写 warning，**本次 tool allow 仍生效**。应把“本次允许成功”与“记住规则成功”分开。[修复提交 #1502](https://github.com/anthropics/claude-agent-sdk-python/commit/8ed58affbee28a201bb5aeb34afcd513415acac5)、[权限更新源码](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.186/src/claude_agent_sdk/types.py#L148)、[控制响应序列化](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.186/src/claude_agent_sdk/_internal/query.py#L118)

本项目已有工具/计划批准及修改输入，但升级验收应增加“allow once / remember / 无效规则警告 / 权限收紧后再请求”的独立证据，不能从旧版批准测试推定规则持久化全部有效。

### 2.3 `client_app` 与配置加载：0.2.181 起

`ClaudeAgentOptions.client_app: str | None = None` 用于 API 请求中的应用标识，并覆盖 `env` 中的 `CLAUDE_AGENT_SDK_CLIENT_APP`；空字符串表示不发标识。源码特别说明：自动从安装 distribution 推导的机制有 CLI 隔离门槛，**本轮没有已发行 CLI 满足自动推导条件**；不要承诺升级后自动出现 CoderFleet 标识。这是请求标识，不是终端用户审计 ID。[引入提交 #1432](https://github.com/anthropics/claude-agent-sdk-python/commit/38eec2b9474bd486c7bbe3d1554110a6afdaed9a)、[固定字段说明](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.186/src/claude_agent_sdk/types.py#L2902)

同时，配置了 `sandbox` 时，`settings` 文件无法读取/解析/合并会失败，不再只记录错误后丢掉原 settings。相对路径按 `cwd` 解析。已有配置快照需在升级前静态核对；之前被忽略的坏路径可能在升级后成为显式启动失败。[配置合并修复 #1426](https://github.com/anthropics/claude-agent-sdk-python/commit/6b1927e5126a27cfe8727edb2a389b1b94e2a480)、[固定 settings 契约](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.186/src/claude_agent_sdk/types.py#L2564)

## 3. 重点能力的公开 API 与边界

### 3.1 会话查询、编辑、恢复与压缩

以下 Python helpers 已经在 0.2.180 基线存在，0.2.186 继续提供；离线查询/元数据修改不需要模型 turn。`directory` 默认可能跨项目搜索，因此应用仍须自行绑定账号、项目与 session ID。[固定导出列表](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.186/src/claude_agent_sdk/__init__.py#L41)

| 目的 | Python 0.2.186 公开签名/入口 | 可用性与本项目覆盖 |
|---|---|---|
| 查询会话 | `list_sessions(directory=None, limit=None, offset=0, include_worktrees=True) -> list[SDKSessionInfo]`；`get_session_info(session_id, directory=None) -> SDKSessionInfo | None` | 已接入账号/工作区约束；默认包含同仓库 worktrees |
| 历史消息 | `get_session_messages(session_id, directory=None, limit=None, offset=0) -> list[SessionMessage]` | 返回 user/assistant；没有 TS 的 `includeSystemMessages` 参数 |
| 子 Agent 历史 | `list_subagents(session_id, directory=None) -> list[str]`；`get_subagent_messages(session_id, agent_id, directory=None, limit=None, offset=0)` | 已有产品入口；这是 transcript 检索，不是运行中子 Agent 控制 |
| 标题、标签 | `rename_session(session_id, title, directory=None) -> None`；`tag_session(session_id, tag: str | None, directory=None) -> None` | 追加元数据；已接入。rename 不是重写用户消息 |
| 分叉/删除 | `fork_session(session_id, directory=None, up_to_message_id=None, title=None) -> ForkSessionResult`；`delete_session(session_id, directory=None) -> None` | fork 不复制文件恢复历史；delete 是硬删除；现有产品另有归档引用约束 |
| 恢复/从旧位置分支 | `ClaudeAgentOptions(resume=..., fork_session=..., resume_session_at=..., resume_drops_turn=...)` | Python 有公共配置字段；项目已有 resume/fork，具体截断防丢 turn 选项未列入通用 JSON schema，不能宣称全暴露 |
| 原生 archive/unarchive | Python 无对应函数；TS `archiveSession(sessionId, options?)` / `unarchiveSession(...) -> Promise<void>` | TS 0.3.325 新增，支持本地 session archive，`sessionStore` 选项会被拒绝；不是 Python 升级自动获得 |
| 改写/回退对话、compact | 两语言当前公共 client/Query 方法没有任意 transcript edit、`rewindConversation()` 或 `compact()` | 部分 CLI 控制协议有相关类型/行为；`/compact` 可经命令 prompt 派发，但应按当前会话可用命令探测，且可能调用模型。`verbatim_prompts=True` 会关闭 slash-command dispatch |

查询签名来源：[sessions.py](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.186/src/claude_agent_sdk/_internal/sessions.py#L680)；修改签名与语义：[session_mutations.py](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.186/src/claude_agent_sdk/_internal/session_mutations.py#L53)；恢复与 verbatim 配置：[types.py](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.186/src/claude_agent_sdk/types.py#L2674)；TS archive：[0.3.325 Release](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.325)、[0.3.329 npm 包](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.329.tgz)；公共方法与命令结果：[TS 参考](https://code.claude.com/docs/en/agent-sdk/typescript#query-object)。

`resume_drops_turn` 会在截断范围包含不属于指定 turn 的排队消息或任务通知时拒绝恢复；不能把这个确定性拒绝当作瞬时错误无穷重试。`fork_session()` 只分叉历史，多个会话仍可能编辑同一目录；当前 CoderFleet 对临时工作区及文件恢复的更严格规则应保留。[恢复字段源码](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.186/src/claude_agent_sdk/types.py#L2712)、[会话 guide](https://code.claude.com/docs/en/agent-sdk/sessions)

### 3.2 后台 Agent、插话、监控与生命周期

Python `ClaudeSDKClient` 的公共控制方法在 180→186 **完全相同**：本轮下载的两个固定 tag `client.py` SHA-256 都为 `980f956d963338b39f4fd5224e69594eb513bfda37e5b215cf94bb0499ea047c`。主要入口是：

```python
async def query(self, prompt: str | AsyncIterable[dict[str, Any]], session_id: str = "default") -> None
async def interrupt(self) -> None
async def stop_task(self, task_id: str) -> None
async def set_model(self, model: str | None = None) -> None
async def set_permission_mode(self, mode: PermissionMode) -> None
```

`interrupt()` 的 Python 返回值仍是 `None`，没有 TS 的 typed interrupt receipt；底层协议存在收据不等于 Python 公共方法返回收据。中断当前响应后，应读到中断结果再发送下一条指令。它不撤销已经完成的工具副作用。[固定客户端](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.186/src/claude_agent_sdk/client.py#L272)、[流式输入与中断](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)

| 能力 | Python 公共 API | TS / CLI 边界 |
|---|---|---|
| 子 Agent 定义/后台运行 | `AgentDefinition(..., background=True, maxTurns=..., permissionMode=..., effort=...)` | 定义本身不是启动/终止 API；由主 Agent 使用 Agent 工具调用。不是 CoderFleet scheduler 的 Task |
| 后台停止 | `stop_task(task_id)` | 接受原生 `task_started` 的 ID，不能用 CoderFleet Task ID |
| 运行状态 | `TaskStartedMessage`、`TaskProgressMessage`、`TaskNotificationMessage`、`TaskUpdatedMessage`；Stop/SubagentStop 的 `background_tasks` | terminal 状态有时只发 `task_updated`，不能只等 notification 才删除活跃 ID |
| 将前台工具改为后台 | Python 无公共方法 | TS `backgroundTasks(toolUseId?: string): Promise<boolean>`；0.2.139 起。它是“转后台”，不是“列出后台列表” |
| 单独 steer/resume 子 Agent | Python/TS 均无独立公开 `steer_task()` 方法 | 官方方案是恢复父 session，在 prompt 中让模型继续指定 agentId；属于模型介导行为，不是确定性交付控制 |
| 监控外部事件 | 可让模型调用内置 `Monitor` 工具 | `command` 每 stdout 行，或 `ws` 每文本帧作为事件；有截止时间，不是永久调度服务；不是 `client.monitor()` |

来源：[Python 后台消息与终态契约](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.186/src/claude_agent_sdk/types.py#L1620)、[Python stop_task](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.186/src/claude_agent_sdk/client.py#L443)、[TS backgroundTasks](https://code.claude.com/docs/en/agent-sdk/typescript#backgroundtasks)、[子 Agent 恢复方案](https://code.claude.com/docs/en/agent-sdk/subagents#resume-subagents)、[Monitor 输入/输出](https://code.claude.com/docs/en/agent-sdk/python#monitor)。

**升级相关 CLI 修复需回归：** 2.1.327 修复等待 `canUseTool` 超过 30 秒后模型误判后台 Agent 仍在运行；2.1.328 修复中断后模型仍声称后台 Agent 在运行；2.1.329 改善 idle/长会话内存。它们随捆绑 CLI 进入 Python，但本轮没有真实后台验收，不能承诺 CoderFleet 已受益。[TS/CLI 2.1.327 记录](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.327)、[2.1.328 记录](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.328)、[2.1.329 记录](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.329)

### 3.3 流式内容、thinking、Hook

现有 `include_partial_messages`、`forward_subagent_text`、`ThinkingBlock` 与增量流仍可用，已经接入产品。需要补充的参数机会是 **`thinking.display`**：Python 类型支持 `"summarized" | "omitted"`，适用于 adaptive/enabled 配置；较新模型可能默认省略 thinking 文本。现有 `coderfleet_sdk_features.py` 的严格 schema 没有接收 `display`，即便升级 SDK 也仍会拒绝该键。允许显示的是模型提供的摘要，并非保证完整内部推理。[Python ThinkingConfig 固定定义](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.186/src/claude_agent_sdk/types.py#L2251)、[现有参数 schema](../../coderfleet/data/scripts/coderfleet_sdk_features.py)

**Python 0.2.186 的 `HookEvent` 仍恰好是 10 类：** `PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`UserPromptSubmit`、`Stop`、`SubagentStop`、`PreCompact`、`Notification`、`SubagentStart`、`PermissionRequest`。本项目的 `HOOK_EVENTS` 与此匹配。`include_hook_events` 是输出 Hook 生命周期事件的开关，不能新增可注册的 Python callback 事件；`SessionStart`/`Setup` 事件可能始终输出。[Python HookEvent](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.186/src/claude_agent_sdk/types.py#L324)、[include_hook_events 字段](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.186/src/claude_agent_sdk/types.py#L2664)

`SessionStart/End`、`PostCompact`、`TaskCreated/Completed`、`Elicitation/Result`、`PermissionDenied`、模型切换与文件变化等 callback 仍为 TS 能力。Python 虽导出部分这些事件的 *output* TypedDict，也不能据此宣称有完整注册接口。SessionStart/End 可用 settings 内 shell hooks，属于不同执行面。`HookMatcher(on_failure="block")` 已在 0.2.177 加入，**不是此次升级新增**；现有扩展工厂可使用，但 Stop 类事件并不因它而阻止退出。[官方 Hook 对照表](https://code.claude.com/docs/en/agent-sdk/hooks#available-hooks)、[Python HookMatcher](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.186/src/claude_agent_sdk/types.py#L880)

### 3.4 MCP runtime、认证、elicitation

Python 已有公开方法：`get_mcp_status() -> McpStatusResponse`、`reconnect_mcp_server(server_name) -> None`、`toggle_mcp_server(server_name, enabled) -> None`；本项目已经接入。TS 额外有 `setMcpServers(servers) -> Promise<McpSetServersResult>`、`setMcpPermissionModeOverride(serverName, "default" | "auto" | null)`、alpha `readMcpResource(serverName, uri)`。Python 当前没有对应公共方法，不能仅新增控制操作名称就算接入。[Python client](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.186/src/claude_agent_sdk/client.py#L395)、[TS MCP 控制](https://code.claude.com/docs/en/agent-sdk/typescript#query-object)

认证方面，两个 SDK 都可用 stdio server `env` 或 HTTP/SSE `headers` 传凭据；**SDK 不负责打开浏览器或完成交互 OAuth**。`needs-auth`/`failed` 需要由宿主完成登录并提供 token，不能把“重连”当成“自动认证”。[官方 MCP OAuth 边界](https://code.claude.com/docs/en/agent-sdk/mcp#oauth2-authentication)

TS 有 `Options.onElicitation?: OnElicitation`，回调接收请求及 `{signal, requestId}`，返回 `Promise<ElicitationResult | null>`；Python 无此 options 字段，也无 Elicitation callback Hook。尤其 Python 进程内 SDK MCP server 只转发 tools/resources/prompts 等客户端请求，服务器发起的 sampling、elicitation、roots、logging、progress **尚不转发**。完整 MCP 双向交互不能因能注册自定义工具就算通过。[TS 0.3.329 发行包声明](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.329.tgz)、[Python MCP server 的明确限制](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.186/src/claude_agent_sdk/types.py#L933)

### 3.5 工具审批与 AskUserQuestion

两者都通过 Python `can_use_tool(tool_name, input_data, context) -> Awaitable[PermissionResult]`；正常批准/拒绝与修改输入已接入。`AskUserQuestion` 需要保留原 `questions`，把问题文本映射到选择标签或自由文本，放入 `PermissionResultAllow(updated_input=...)` 的 `answers`。它与普通聊天追问、MCP elicitation 是三种入口。[用户输入 guide](https://code.claude.com/docs/en/agent-sdk/user-input)

必须保留的语义：`allowed_tools` 是自动批准规则，不是工具可见性列表；已被权限模式/规则放行的调用不会经过 `can_use_tool`。要检查所有调用，应使用 `PreToolUse`。Python `ToolPermissionContext.signal` 仍为预留；TS 则有真实 `AbortSignal`，且有 Python 未公开的 `suppressAlwaysAllowRule` 等提示。TS `toolConfig.askUserQuestion.previewFormat` 支持 Markdown/HTML 选择预览，Python 无相应 typed options。[Python 权限类型](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.186/src/claude_agent_sdk/types.py#L260)、[TS 用户输入预览与权限提示](https://code.claude.com/docs/en/agent-sdk/user-input#option-previews-typescript)

`PreToolUse` 的 `defer` 可把待执行工具写入会话后退出，适合进程无法无限等人工答复的场景；它不是普通 deny。CLI 2.1.328 又新增 `CLAUDE_CODE_DISABLE_DEFERRED_TOOL_RESUME` 以阻止 resume/continue 自动执行被 defer 的工具。若考虑宿主审批恢复，应专项验证“谁批准、何时恢复、恢复是否重复执行”，不沿用普通待回复卡片的成功结论。[defer 说明](https://code.claude.com/docs/en/agent-sdk/user-input)、[2.1.328 发布记录](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.328)

### 3.6 sandbox、policy、context 与共享状态

| 能力 | Python 当前边界 | CoderFleet 取舍 |
|---|---|---|
| Bash sandbox | Python 类型有 enabled、network、excludedCommands 等；没有 TS 的 `filesystem`、`failIfUnavailable`、`strictAllowlist` typed 字段 | 当前 JSON schema 同样较窄；可评估有明确验证的配置入口，不能从类型字段推断各 OS 强隔离 |
| 受管 policy | `settings` 是 flag 层配置，`setting_sources` 控制 user/project/local；Python 没有 TS `managedSettings` options | 不把普通 settings 当不可覆盖组织策略；账号/认证/代理边界继续由 Runtime/container 管理 |
| 精确上下文 | `get_context_usage() -> ContextUsageResponse` | 已接入；比根据字符串估 token 更合适。模型允许窗口、auto-compact buffer 是不同值 |
| prompt snapshot | `SystemPromptPreset/Custom.snapshot`，以及 preset 的 `exclude_dynamic_sections` | 已有参数入口；改 prompt 可能要等 compact/new session 才生效，`snapshot=False` 才逐请求重建 |
| transcript 存储 | `SessionStore`、`session_store_flush`、`load_timeout_ms`；本地文件优先，缺失时可从 Store materialize | 已有 SQLite 及工厂；它共享历史存储，不自动同步执行状态、文件内容、认证或分布式锁 |
| 子 Agent 状态/上下文 | `AgentDefinition.memory`、tools、skills、mcpServers 等；普通子 Agent 不继承完整父对话，fork 子 Agent 会复制对话 | 不是跨账号共享上下文方案；Agent 仍在当前 worker 权限与文件边界内 |

来源：[Python options/类型](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.186/src/claude_agent_sdk/types.py)、[配置来源与优先级](https://code.claude.com/docs/en/agent-sdk/configuration)、[SessionStore guide](https://code.claude.com/docs/en/agent-sdk/session-storage)、[子 Agent 继承规则](https://code.claude.com/docs/en/agent-sdk/subagents#what-subagents-inherit)、[TS sandbox](https://code.claude.com/docs/en/agent-sdk/typescript#sandbox-configuration)。

**默认值存在文档漂移：** Python `SandboxSettings` 注释仍说 `autoAllowBashIfSandboxed` 默认 True；CLI 2.1.325 的发布记录改为只有显式 True 才自动允许，TS 参考标该新默认从 0.3.324 起。升级验收应显式设置并观察真实审批行为，不依赖旧 Python 注释。`allowManagedDomainsOnly` 即使在 Python TypedDict 中存在，也只有置于 managed settings 才有相应 managed 语义。[旧 Python 注释](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.186/src/claude_agent_sdk/types.py#L1206)、[CLI 2.1.325 行为变化](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.325)、[当前 sandbox 参考](https://code.claude.com/docs/en/agent-sdk/typescript#sandbox-configuration)

SessionStore 与 `enable_file_checkpointing=True` 在 0.2.186 仍被 client 明确拒绝；文件恢复不回退对话，也不恢复所有 Bash、子 Agent 或外部副作用。已有产品边界不因版本升级放宽。[固定 client 配置验证](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.186/src/claude_agent_sdk/client.py#L113)

### 3.7 成本、预算、telemetry、fast、effort、结构化输出

| 主题 | Python API / 机制 | 重点边界 |
|---|---|---|
| 预算 | `max_turns`、`max_budget_usd`；`task_budget={"total": N}` | token task budget 走 `task-budgets-2026-03-13` beta，不等同宿主费用硬限额；上述选项已接入 |
| 成本 | `ResultMessage.total_cost_usd`、`model_usage`、`usage` | `total_cost_usd/model_usage` 是累计估计，streaming 取最新，不逐 turn 相加；resume 可能带历史累计，cap 只算本次支出；不是账单 |
| telemetry | CLI 通过环境变量导出 OTLP；Python `[otel]` 额外依赖可传 active W3C trace context | tracing 仍需 enhanced telemetry beta；本项目没有任意 env 用户入口，不能承诺已有端到端审计导出 |
| effort/thinking | `effort: Literal["low","medium","high","xhigh","max"]`；adaptive/enabled/disabled thinking | 参数已接入；具体模型/组织允许的 effort 应看初始化 model info，旧 docstring 的模型表不能作为当前全部支持清单 |
| Fast mode | Python 无独立 `fast_mode` 字段；可通过 `settings` JSON 的 `fastMode:true` 显式 opt-in | 现有 settings 字符串可表达启动配置；运行中通用 `applyFlagSettings` 仅 TS。初始化能报告 fast 状态，不代表账号已获资格 |
| structured output | `output_format={"type":"json_schema","schema":...}`；读取 `ResultMessage.structured_output` | 已接入；按 draft-07 验证 schema，核对 `is_error`、subtype、是否真有结构化值；中途工具输入不是最终保证值 |

来源：[Python预算/推理配置](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.186/src/claude_agent_sdk/types.py#L2816)、[成本累计口径](https://code.claude.com/docs/en/agent-sdk/cost-tracking)、[OTLP 配置与 beta](https://code.claude.com/docs/en/agent-sdk/observability)、[结构化输出及错误](https://code.claude.com/docs/en/agent-sdk/structured-outputs)、[Fast mode](https://code.claude.com/docs/en/fast-mode)、[TS 运行中 settings](https://code.claude.com/docs/en/agent-sdk/typescript#applyflagsettings)。

Fast 不是 effort 的别名：前者改变服务速度/计费，后者控制推理投入。当前 Fast 文档列 Fable 5.2、Opus 5.5 等模型，且有 provider、组织和付费资格门槛；Bedrock、Foundry、Claude Platform on AWS 不支持。订阅账户使用 usage credits，不计入原订阅额度池。若 CoderFleet 提供开关，应先显示可用性与费用含义，不能把它作为“免费加速”。本轮只研究参数与门槛，没有启用或计费实验。[Fast requirements](https://code.claude.com/docs/en/fast-mode#requirements)

## 4. 需要 TypeScript 或额外协议工作的候选能力

本表列真实差异，并非建议立即重写 worker。签名以 **0.3.329 发行包的 `sdk.d.ts` / `core.d.ts`** 为准；Python 对应面检查了固定 0.2.186 公共 client 与 options。

| 能力 | TS 公开入口 | 可用性/代价 |
|---|---|---|
| 启动预热 | `startup({options?, initializeTimeoutMs?}?) -> Promise<WarmQuery>`；alpha `prewarm({options?, initializeTimeoutMs?}?) -> Promise<SpareProcess>`，随后 claim | Python 无对等公开 API。spare 在预热时绑定 host-level policy/环境，不能跨账号借用以破坏现有隔离 |
| 会话归档 | `archiveSession(id, options?)` / `unarchiveSession(id, options?)` | 0.3.325 新增；本地文件语义，与 CoderFleet Conversation 归档不是同一个状态 |
| 运行中配置 | `applyFlagSettings(settings)` / `updateSettings(source, settings)` | Python 仅 model/permission 专用 setter；有些设置只在下个 turn 生效，system prompt 不因成功回执立即替换 |
| MCP 动态管理 | `setMcpServers(...)`、`setMcpPermissionModeOverride(...)`、alpha `readMcpResource(...)` | Python 当前只支持状态/重连/启停；MCP Apps 资源读取与 UI 渲染还需宿主自己完成 |
| 人工 elicitation / 选择预览 | `onElicitation`、`toolConfig.askUserQuestion.previewFormat` | Python 无对应 options；需新 UI、持久 request ID、取消和重放策略 |
| 更完整 Hook 与级别状态 | TS HookEvent 广于 Python；`SDKBackgroundTasksChangedMessage` | 不能通过向 Python allowlist 加字符串假装公开支持；协议适配需固定版本、专项契约测试 |
| 受管配置解析 | alpha `resolveSettings(options?)`、`matchDeniedModels(...)`；`Options.managedSettings` | TS 可做宿主 policy 检查；不代表授权访问另一个账号的配置 |

来源：[官方 TS 参考](https://code.claude.com/docs/en/agent-sdk/typescript)、[0.3.329 npm 发行包](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.329.tgz)、[归档首次发布](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.325)。

**不应采用旧 V2 session API 作为迁移理由。** `unstable_v2_createSession` / `unstable_v2_resumeSession` / `unstable_v2_prompt` 已在 TS 0.3.142 移除；当前推荐是 `query()` 与 async iterable / resume。[V2 移除说明](https://code.claude.com/docs/en/agent-sdk/typescript-v2-preview)

也不将仅在 Claude Code 终端、Desktop、cloud/Remote Control 等表面提供的功能视为 Agent SDK 功能。**Code Mode** 从 CLI 2.1.323 起提供，但官方明确限定交互终端，**不支持 `-p`、Agent SDK、VS Code panel、Desktop 或 cloud**；升级至捆绑 CLI 2.1.329 不能让现有 SDK worker 启用它。[Code Mode Requirements](https://code.claude.com/docs/en/code-mode#requirements)

## 5. 对 CoderFleet 的建议排序与后续验收

以下是研究结论，尚未执行实现、版本升级或模型验收。

1. **优先：0.2.186 / 2.1.329 升级候选与契约检查。** 明确版本 pin 后，在隔离环境验证现有私有 `_query`/transport/lifecycle 适配。覆盖 settings+sandbox 失败、remember permission、超过 30 秒人工审批、中断后后台终态、长会话输出与 session resume。先解决可靠性，不把所有 TS 新能力打包进同次升级。
2. **消息归属及后台可观测性。** 使用唯一输入 UUID，验证插话合并、后台通知自动 turn、空 result、被中断 result、`task_updated` 单独终态。现有持续读取是良好基础，下一步是产品状态的证据而非计数每条消息产生一个 result。
3. **低成本 Python 参数补齐。** 评估严格 schema 中的 `thinking.display`；有真实业务需要时再开放 `client_app` 与安全截断恢复。Fast 启动 opt-in 可由已有 settings 表达，但应另做资格/费用提示及实测，不当作 SDK 升级新增按钮。
4. **补测原有但未专项验收的能力。** 长时间后台任务、第三方 SessionStore、OS sandbox、遥测归因目前仍是明确空白。内置 SQLite 功能存在不等于分布式迁移、恢复锁或远程 Store 删除已经通过。
5. **出现强需求再引入 TS 侧车。** 优先触发条件是可靠的 MCP elicitation/MCP Apps、运行中动态 tool server 配置、完整 Hook、预热降低启动延迟。侧车也必须一账号一容器/认证/代理边界，不能替换或合并 CoderFleet Task 与 Conversation 的所有权。

上述排序基于本仓库 [安装器](../../coderfleet/data/scripts/install_claude_sdk.py)、[配置与会话适配](../../coderfleet/data/scripts/coderfleet_sdk_features.py)、[worker](../../coderfleet/data/scripts/coderfleet_claude_sdk_worker.py) 的静态读取，以及前述官方资料；未假定历史 954 项测试或 4 次真实 Task 已在新版再次通过。

## 6. 可复核证据与未验证项

### 已完成的静态核查

- 直接 HTTPS 读取 PyPI 与 npm registry JSON；核对版本、上传日期、平台文件、yanked、Node/Python 要求及捆绑 CLI 字段。
- 读取官方 Python `v0.2.180...v0.2.186` compare：21 commits、29 changed files；公共 `client.py` 字节相同，`types.py` 与 permission/parser/transport 有实际差异。
- 下载官方 TS 0.3.329 tarball，仅提取声明文件；SHA-512 与 npm `dist.integrity` 一致。tarball SHA-256：`0f42427d23c99a05c760982329cba9fddfc6cca5c014b031d36ff6e881cf23dc`。这证明本报告检查的是 registry 发布的包，**不证明运行成功**。
- PyPI 0.2.186 Linux x86_64 wheel 元数据 SHA-256：`3aedbd01e5727283339362a544506f05cc19863a3b4c26bb9e1656d3e3940c3d`；本轮未下载/执行该 wheel 内 CLI。
- GitHub connector 在本轮起服超时，随后使用官方 HTTPS 读取 GitHub API/raw source；不是借二手博客补齐事实。

### 保留的不确定性

- 官方动态参考与 tag 注释并非全部同步：特别是 sandbox 默认值、最新归档函数与 Python changelog；已在对应条目标明。
- 所列 TS-only 能力指公开 typed API 差异；不排除同一 CLI 的底层协议可以完成部分操作，但那需要维护私有协议与兼容层，不能称为 Python SDK 官方直接支持。
- 本轮没有实测任何模型、provider、账号资格、MCP OAuth/elicitation、long-running Agent、sandbox 强隔离、远程存储、telemetry collector 或预热性能；不存在新的真实验收结论。
- 0.2.180 的现有验收来自仓库文档，不是本轮重新执行；当前生产安装版本也未通过连接容器/执行程序重新核实。

### 核心官方来源入口

- [Python Releases](https://github.com/anthropics/claude-agent-sdk-python/releases) · [固定差异](https://github.com/anthropics/claude-agent-sdk-python/compare/v0.2.180...v0.2.186) · [PyPI JSON](https://pypi.org/pypi/claude-agent-sdk/json)
- [TS Releases](https://github.com/anthropics/claude-agent-sdk-typescript/releases) · [npm JSON](https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk) · [本轮检查的发行包](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.329.tgz)
- [Python API](https://code.claude.com/docs/en/agent-sdk/python) · [TS API](https://code.claude.com/docs/en/agent-sdk/typescript) · [官方文档索引](https://code.claude.com/docs/llms.txt)
