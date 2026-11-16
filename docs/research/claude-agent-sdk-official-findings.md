# Claude Agent SDK：官方接口兼容性核对

检索日期：2026-11-09（America/Los_Angeles）。范围：Anthropic 官方文档、官方 Python SDK 源码、PyPI 发布元数据。只做文档和源码调研，没有发起真实模型请求，没有读取或迁移账号凭证。本文件是 [CoderFleet 迁移方案](claude-agent-sdk-migration.md) 的官方语义补充；项目现状和迁移取舍以该方案为准。

## 结论

官方 SDK 可以承担 Claude Code 的双向控制，但仍然启动本机或容器内的 CLI 子进程。它提供输入、审批和 interrupt 接口，不提供 CoderFleet 所需的独立 worker、服务重启后重连、任务状态文件或既有 JSONL 日志兼容层。迁移应把 SDK 放进原有账号执行边界内，由适配层维持现有任务契约，不能仅把 `claude -p` 替换成一个 Python 函数调用。[官方架构说明](https://code.claude.com/docs/en/agent-sdk/hosting#the-subprocess-model)

当前资料中最容易误用的两项默认值：**省略 system_prompt 与 `claude -p` 的系统提示不同；省略 setting_sources 在当前版本会加载 CLI 的配置来源**。这两项需要分别处理，不能套用早期 SDK 的整体印象。

## 版本和安装

| 项目 | 本次查到的事实 | 对迁移的影响 |
|---|---|---|
| Python 发布版本 | PyPI 最新元数据为 `claude-agent-sdk==0.2.180`，非 yanked，要求 Python `>=3.10` | 应锁定验证版本，不能依赖浮动 latest |
| 发布版依赖 | `anyio>=4.0.0`、`sniffio>=1.0.0`、`mcp>=1.23.0,<3.0.0`、`jsonschema>=4.20.0` | 需要与项目现有 MCP pin 单独做解析和回归验证 |
| 内置 CLI | `v0.2.180` 的 `_cli_version.py` 为 `2.1.321` | SDK 与全局 CLI 是两条可能不同的版本轨道 |
| 二进制选择 | 显式 `cli_path` 优先；否则先查 wheel 内置 CLI，再找系统安装 | 第一阶段建议显式指定已经验证的容器 CLI 路径，减少一次迁移引入两项变化 |
| Python 安装 | 平台 wheel 通常携带原生 CLI；sdist 安装可能没有 | 镜像构建需要检查目标架构、实际二进制和 `--version` |
| Node 要求 | 官方 Quickstart 分别给出 Node.js `18.14+` **或** Python `3.10+` | Python 集成不必为了 SDK 再创建 Node worker；仍需保留项目/MCP 工具本来的 Node 需求 |

来源：[PyPI 元数据](https://pypi.org/pypi/claude-agent-sdk/json)、[v0.2.180 依赖声明](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.180/pyproject.toml)、[内置 CLI 版本](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.180/src/claude_agent_sdk/_cli_version.py)、[二进制查找源码](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.180/src/claude_agent_sdk/_internal/transport/subprocess_cli.py)、[官方安装说明](https://code.claude.com/docs/en/agent-sdk/quickstart#setup)。这是检索快照，不是环境已安装版本的声明。

## query 与 ClaudeSDKClient

| 接口 | 官方能力 | 建议用途 |
|---|---|---|
| 顶层 `query()` | 返回异步消息迭代器，自动启动和关闭执行；可用 `resume` 接续历史，可传流式输入、hooks、权限回调；没有公开 interrupt 方法 | 已知全部输入的一次性工作 |
| `ClaudeSDKClient` | `connect` / `disconnect`、`query`、`receive_messages`、`receive_response`、`interrupt`，同一实例支持多次发送 | 需要运行中控制的 CoderFleet worker |
| `receive_response()` | 读到并包含第一个 `ResultMessage` 后返回 | 只在明确按单轮消费时使用 |
| `receive_messages()` | 持续消费整个客户端消息流 | worker 的唯一读循环，向日志和控制状态分发 |

来源：[Python API 比较](https://code.claude.com/docs/en/agent-sdk/python#choosing-between-query-and-claudesdkclient)、[query 发布版源码](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.180/src/claude_agent_sdk/query.py)、[客户端发布版源码](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.180/src/claude_agent_sdk/client.py)。

**输入送入不等于当前生成被抢占。** `client.query()` 将用户消息写入已有输入通道；显式停止当前轮需要 `interrupt()`。后者是控制请求，不是文件回滚，也不是事务撤销。适配层必须分清停止当前轮、关闭整个客户端和杀死 worker 三个操作，并验证旧轮次结果的归属。[Streaming Input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)、[interrupt 控制实现](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.180/src/claude_agent_sdk/_internal/query.py)

在 `v0.2.180` 中，一个 `result` 表示一个 turn 结束；后台子任务可能仍在运行或即将触发后续 turn。内部控制层还跟踪 `session_state_changed` 和后台任务，才决定是否结束运行并关闭 stdin。**不能在任意第一个 result 后直接 disconnect 并宣称全部后台工作完成。** 若第一期保留 Task=一次完整运行的语义，应在 worker 中明确结束条件。[运行结束判定源码](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.180/src/claude_agent_sdk/_internal/query.py)

## 会话、恢复和 fork

- `resume=<明确 native session id>` 指向指定历史会话；`continue_conversation=True` 查找当前目录最近的会话。多账号、多会话调度应继续传明确 ID，避免最近会话隐式误选。
- `fork_session=True` 配合 `resume` 建立新的 session；新 ID 应从实际返回事件保存，不能继续覆盖原会话 ID。
- SDK 使用 Claude Code 的磁盘会话；会话历史与工作目录产物是不同状态。保留账号配置目录挂载和 cwd 是迁移条件，单有 session ID 不能恢复文件变更。
- SDK 提供 SessionStore，可用于跨主机恢复；第一期没有必要为了替换执行通道一并迁移已有会话存储。

来源：[Sessions 官方指南](https://code.claude.com/docs/en/agent-sdk/sessions)、[v0.2.180 会话选项](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.180/src/claude_agent_sdk/types.py)。

**待验证**：目标容器现有 CLI 会话 → 指定版本 SDK resume → 再返回旧 CLI；现有 fork 截断点与 SDK `resume_session_at` 的 UUID 对齐；被强杀/未刷盘的最后一轮能恢复到哪个位置。这些不能仅凭接口同名当成通过。

## Prompt、settings、skills、MCP 和 plugins

1. **系统提示要显式选择。** 当前 SDK 缺省是精简提示；要匹配现有 CLI 编程行为，应传 `system_prompt={"type":"preset","preset":"claude_code"}`。`system_prompt` 传字符串会替换系统提示。该行为和项目 `CLAUDE.md` 的配置加载是不同维度。[系统提示指南](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts#how-system-prompts-work)
2. **配置来源应明确固定。** 当前 `setting_sources=None` 且不设置 `skills` 时，沿用 user/project/local；显式 `[]` 禁用这些来源。当前 `skills` 参数会在来源未设时自动设为 user/project，因此为了兼容本地设置，应显式 `setting_sources=["user","project","local"]`。不能声称当前 SDK 默认不加载项目配置。[配置加载指南](https://code.claude.com/docs/en/agent-sdk/claude-code-features)、[默认值源码](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.180/src/claude_agent_sdk/_internal/transport/subprocess_cli.py)
3. **skills 从文件系统发现。** `skills=None` 不代表关闭；`skills=[]` 才是显式抑制。第一阶段应保持当前设置来源和磁盘布局，避免顺带增加 skills 过滤。[Skills 指南](https://code.claude.com/docs/en/agent-sdk/skills)
4. **MCP 可继续走现有配置。** `mcp_servers` 可接字典或配置文件路径。`strict_mcp_config=True` 会改变加载范围，不能在兼容迁移时随意打开。`create_sdk_mcp_server` 是可选的进程内扩展，不是迁移已有 HTTP MCP 桥的前提。[MCP 选项定义](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.180/src/claude_agent_sdk/types.py)、[参数映射源码](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.180/src/claude_agent_sdk/_internal/transport/subprocess_cli.py)
5. **plugins 显式支持本地目录。** 传 `plugins=[{"type":"local","path":"..."}]`；远程 marketplace 插件需先下载。路径以实际运行环境为准，宿主路径不可直接当作容器路径。[Plugins 指南](https://code.claude.com/docs/en/agent-sdk/plugins)

以上是当前发布版语义。旧 Python SDK 对 `setting_sources=[]` 等曾有不同处理；验收应以选定 SDK+CLI 组合为单位。

## 审批与 AskUserQuestion

`can_use_tool(tool_name, input_data, context)` 是异步决策点，应用负责呈现和等待答案。当前 Python `context.tool_use_id` 来自原生工具调用 ID，可用于对齐 CoderFleet 已有 intervention 卡片，避免另造一个无法匹配前端的 ID。`AskUserQuestion` 的批准结果需要返回保留原始 questions、附带 answers 的 updated_input；answers 以问题全文为键。[官方用户输入指南](https://code.claude.com/docs/en/agent-sdk/user-input)、[context 构造源码](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.180/src/claude_agent_sdk/_internal/query.py)

**权限模式不应机械照搬名字。** SDK 的 `permission_mode="auto"` 指官方分类器模式，不等价于项目已有自动任务的 bypass 意义。已有自动模式若本来传 `--dangerously-skip-permissions`，迁移映射应由项目当前行为决定。`allowed_tools` 是自动批准规则，不是模型只看得见的工具白名单；工具集限制用 `tools`，显式禁止用 `disallowed_tools`。[权限指南](https://code.claude.com/docs/en/agent-sdk/permissions)

当前官方权限规则明确：`AskUserQuestion` 即便处于 bypassPermissions 或匹配 allow，也会进入回调；dontAsk 则拒绝。SDK 接入后必须继续明确项目自动任务是否禁止等待人，避免自动任务突然长时间挂起。权限回调可以长时间 pending；若要跨进程退出后继续等待，官方另有 PreToolUse `defer` 机制，但这是独立产品能力，不属于第一期兼容替换。[权限求值顺序](https://code.claude.com/docs/en/agent-sdk/permissions#how-permissions-are-evaluated)、[等待输入生命周期](https://code.claude.com/docs/en/agent-sdk/user-input#detect-when-claude-needs-input)

官方示例部分仍带旧版 streaming-input/dummy-hook workaround；`v0.2.180` 的内部客户端对字符串输入也建立流式传输、等待控制需求结束再关闭输入。应按锁定版本验证，避免把历史 workaround 无条件带入新 worker。[当前内部客户端源码](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.180/src/claude_agent_sdk/_internal/client.py)

## 事件与日志保真

- SDK 默认输出类型化 Python 消息，不是原封不动的 CLI JSONL。当前 parser 保留 `UserMessage.tool_use_result`，generic `SystemMessage.data` 包含完整原事件，但 assistant/user/result 仍会被解析为各自字段；未知顶层消息会被跳过。不能直接用 `dataclasses.asdict()` 就当成当前前端消费的 JSONL。
- `include_partial_messages=True` 才会增加文本增量的 `StreamEvent`；它们与完整 assistant 消息并存，需要避免重复渲染和重复计费统计。
- 内部存在只给 SDK 控制层消费的 `session_state_changed` 事件（`sdk_host_only`），不会全部透传给调用方。不能把 SDK 消息流当成 CLI stdout 的无损镜像。
- subprocess transport 默认单消息缓冲上限为 1 MiB。项目已有大工具结果/中文日志，应以选定 `max_buffer_size` 和真实形态 fixture 验证，防止以前可用的大事件在迁移后报错。

来源：[v0.2.180 parser](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.180/src/claude_agent_sdk/_internal/message_parser.py)、[streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output)、[内部控制层](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.180/src/claude_agent_sdk/_internal/query.py)、[transport 缓冲与分帧](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.180/src/claude_agent_sdk/_internal/transport/subprocess_cli.py)。类型化事件到旧日志 envelope 的具体兼容实验由主迁移方案记录。

### 可选的 raw 事件旁路（设计推论）

`Transport` 可从包根导入，接口的 `read_messages()` 返回原始 JSON 字典，随后才由 Query 分流控制消息、由客户端进行类型化解析。因此，可用一个轻量 decorator 包装官方 `SubprocessCLITransport`：在原始业务事件进入 parser 前写入兼容日志，再将原事件完整交还 SDK。这样能复用官方的子进程、分帧和双向控制实现，不必自行重写协议。控制帧应单独处理，不能把权限控制、MCP 内部请求等当作聊天日志公开给前端。[Transport 定义](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.180/src/claude_agent_sdk/_internal/transport/__init__.py)、[客户端接收顺序](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.180/src/claude_agent_sdk/client.py)

这条路径有明确代价：Transport 文档虽对外暴露，源码仍声明未来版本可改变或移除；默认 `SubprocessCLITransport` 位于私有模块。应把引用限制在一个兼容模块，锁版本并测试升级，而不是在各处依赖私有实现。传入 custom transport 后，SDK 不会替预构造的 transport 应用 cwd/model/权限等 CLI 选项，也会跳过 SessionStore 的恢复物化。inner transport 必须由同一组规范化配置构造；本地磁盘 resume 仍可交给 inner 的 `resume` 参数。[query 的 custom transport 契约](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.180/src/claude_agent_sdk/query.py)

特别是 `can_use_tool`：SDK 的 `_configure_can_use_tool` 会生成 `permission_prompt_tool_name="stdio"` 的选项副本；若 decorator 的 inner 在此前就按原始 options 构造，可能缺少此 CLI flag。兼容模块需要受控复用这项规范化或给 inner 提供对应副本，client 仍使用原始选项，避免同时显式设置 callback 和 permission_prompt_tool_name 触发互斥错误。[规范化 helper](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.180/src/claude_agent_sdk/types.py#L2292)、[自定义 transport 初始化分支](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.180/src/claude_agent_sdk/client.py#L143)

## 进程生存期和重连

官方默认 transport 对 `claude` 使用 stdin/stdout 管道。`disconnect()` 会走关闭流程；当前实现先关闭输入等待 CLI 刷会话，之后逐级 TERM/KILL，进程退出时还登记了 atexit 清理子 CLI。SDK 没有公开“按 PID 接回原来的 stdio 和回调状态”接口。[客户端关闭](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.180/src/claude_agent_sdk/client.py)、[transport 生命周期](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.180/src/claude_agent_sdk/_internal/transport/subprocess_cli.py)

**设计推论**：SDK 直接由 FastAPI 进程持有，会把正在执行的代理和 Web 服务生存期绑在一起，不能保留现有 detached 任务服务重启后继续运行的契约。更合适的是独立账号边界内的 worker 持有 SDK，Web 服务通过可重连 IPC 发送带幂等键的命令，并从持久日志补读。worker 崩溃后使用 native session resume 是“新进程接续历史”，不等价于接回旧进程中的 Bash、回调或内存状态。实现可继续使用现有进程脱离手段启动 worker；替换重点是内部执行与控制契约，而不是为了移除某个 shell 命令而丢掉任务存活能力。

## 认证的已知范围与待确认项

官方 Quickstart 以 `ANTHROPIC_API_KEY` 为标准配置，并列出受支持云提供方。SDK 子进程继承/合并环境，技术层面要保留项目按账号配置的配置目录、代理和认证来源；应避免在实验中读取、导出或跨账号复制令牌。[SDK Quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart#set-your-api-key)、[子进程环境源码](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.180/src/claude_agent_sdk/_internal/transport/subprocess_cli.py)

当前官方资料的措辞需要按适用场景区分：

- Agent SDK overview/Quickstart 说，第三方开发者未经事先批准，不能为其产品提供 claude.ai 登录或额度，应采用所列 API 认证。
- Claude Code legal-and-compliance 又描述，符合其商业条款和条件时，产品可以预装/运行未修改的 CLI，最终用户自行认证，所列凭证包括自己的订阅凭证；同时不允许替最终用户支付、转售或中介 usage。

来源：[SDK overview](https://code.claude.com/docs/en/agent-sdk/overview#get-started)、[CLI 产品集成条款页面](https://code.claude.com/docs/en/legal-and-compliance#can-customers-offer-claude-code-in-their-products)。这里记录官方页面的不同范围，不据此给出法律结论。**当前私人账号调度场景、将来向第三方提供产品的场景、以及是否已有 Anthropic 批准，需要分开确认**；不能仅因底层沿用 CLI 就宣称现有订阅额度全部兼容，也不能笼统声称所有 SDK OAuth 技术上不可用。

## 第一轮兼容验证建议（尚未执行）

1. 固定 SDK 版本及 `cli_path`，先在单账号现有容器内跑最小离线协议/序列化 fixture；不改共享调度或所有账号配置。
2. 显式固定 cwd、配置目录、代理环境、model、Claude Code prompt preset 和三个 settings 来源；检验 CLAUDE.md、MCP、skills、plugins 的发现结果。
3. 用旧 CLI 会话验证 resume/fork，再验证 SDK 会话回到旧 CLI，保存实际 native session ID。
4. 按现有 renderer/parser 的输入契约验证 assistant、tool_result、usage/error、未知事件、长行和中文；新旧后端运行记录都要能继续查看。
5. 验证正常结束、interrupt、kill、后台子任务、等待人、服务重启、worker 崩溃、重复命令和账号回退，特别检查无人响应的自动任务。
6. 通过后再做默认仍为 CLI 的开关灰度。任务一旦已产生副作用，不能因为 SDK 报错就自动换旧后端重放同一 prompt。

这份报告没有证明上述验收通过；它确定了实现时必须保留和核对的官方接口边界。
