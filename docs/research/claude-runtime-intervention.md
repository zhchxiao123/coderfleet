# Claude 后台任务运行中干预研究

研究日期：2026-10-26。范围：官方文档、官方 Python SDK 源码及当前 checkout。没有运行真实推理，没有中断或重启现有任务。网页描述的是检索时的当前接口，不代表本机旧版本已逐项通过验证。

## 结论

可实现，但必须给运行中的 Claude 增加持续输入和控制通道。后台进程脱离终端不是根本限制；当前一次性输入、日志输出的执行方式才是限制。必须区分“等待当前任务结束后再执行下一条”“运行中发送补充消息”“停止当前轮后按新要求继续”，不能将三者统称为即时插话。

## 当前项目边界

- `coderfleet/account_type_registry.py::_build_claude` 使用 `printf ... | claude -p --output-format stream-json --verbose`。这是流式**输出**，没有配置流式输入；写入一次提示词后管道结束。
- `coderfleet/server/scheduler.py` 的任务启动包装使用 `setsid bash ... &`，输出日志和退出状态文件。`coderfleet/server/runtime.py` 的现有进程接口没有持续 stdin；Docker exec 参数也没有为此保留 `-i`。
- `coderfleet/server/static/js/chat.js` 的运行中发送逻辑明确将新消息排队，不能推定当前 CLI 运行已经收到。
- 已有 MCP `ask_user_question` 和任务 answer 链路能够在代理主动提问时等待回答；这不等于用户任意时刻主动干预。自动模式显式禁用这一等待人回答的工具。
- 主研究流程读出的版本：宿主 Claude Code 2.1.233，`claude-dsh` 容器 2.1.296。没有对这些版本执行双向交互验收。

## 官方能力及证据

### 1. CLI 本身支持持续消息输入

官方 CLI 提供 `--input-format stream-json`；`--replay-user-messages` 可把 stdin 消息回显到 stdout。`--max-turns` 在流式输入下的说明还明确区分当前轮与仍在队列中的消息。因此 `-p` 不意味着永远只能接收一条输入，但仅增加一个参数仍不足以实现产品级控制：需要持续 stdin、消息编码、响应关联及控制请求处理。[CLI reference](https://code.claude.com/docs/en/cli-reference)

### 2. 推荐使用 SDK 的双向客户端

Python `ClaudeSDKClient` 支持多轮 `query()`、持续 `receive_messages()`、按轮读取的 `receive_response()` 和 `interrupt()`。普通顶层 `query()` 生成器不提供同等客户端打断接口。`receive_response()` 在 `ResultMessage` 结束；这意味着一轮完成，不意味着常驻客户端必须退出。[Python SDK reference](https://code.claude.com/docs/en/agent-sdk/python)

官方 streaming-input 文档明确支持长驻会话、消息顺序排队、干预及权限请求。**仅写入新消息不应承诺立刻抢占当前生成。** 需要明确停止当前工作时，应使用显式 interrupt，再处理后续输入。[Streaming Input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)

`interrupt()` 不清空已经产生的消息缓冲。新旧轮次共用消息流时应排空被打断轮次的终止结果，或由唯一读循环按轮归属分发，避免把旧结果当成新消息的回答。打断不是文件回滚，已发生的外部操作也不能据此视为撤销。中断工具、后台子进程的具体行为仍需目标版本验证。[Interrupt example](https://code.claude.com/docs/en/agent-sdk/python#example-using-interrupts)

SDK 不是另写一个模型工具循环：官方源码的 subprocess transport 启动 Claude Code 并使用 `--input-format stream-json`；控制层将 interrupt 编码为双向控制请求。直接自建协议技术上可行，但依赖内部细节，应优先通过 SDK 接口隔离版本变动。[官方 transport 源码](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/transport/subprocess_cli.py)、[官方 control 源码](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py)

### 3. 主动提问与审批可接入网页

SDK 的 `can_use_tool` 回调可以承接权限判断和 `AskUserQuestion`，应用展示问题或审批并返回结果。它与主动 interrupt 是两条不同链路。工具预批准规则会影响回调是否触发，不能一边绕过审批、一边承诺每次都弹窗。[Handle approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input)

### 4. 认证需要单独验证

SDK 仍能运行本地/容器内的 Claude Code，不需要迁移到云端托管执行服务。但其官方快速开始要求 API key，并列出 Bedrock 等云提供方认证；文档同时明确，未经事先批准，第三方产品不能向用户提供 claude.ai 登录及其额度。不能仅因 SDK 能启动 CLI，就宣称现有订阅账号自动获得 SDK 使用授权；也不能把自建 CLI 协议作为绕过这些要求的方案。这里不判断当前私人使用场景的适用性，正式集成应确认认证和授权范围。[SDK quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart#set-your-api-key)

## 针对 CoderFleet 的实现建议（设计推论，尚未实施）

推荐先做容器内双向 worker 的小型验证，避免直接大改 scheduler。首个版本可让每个运行中 Task 拥有独立 worker，保持当前 Task 对应一次 CLI invocation 的语义，在该次 invocation 运行期间接收干预；不必先迁移成一会话永久进程。worker 持有 Claude 客户端和持续输入通道，宿主服务通过可重连的 IPC 发命令、订阅事件；不得把所有账号的 CLI 统一搬到宿主，破坏既有账号和代理隔离。local runtime 应使用相同命令语义的本地 worker。

产品上保留三个清晰操作：

1. **排队发送**：保持现有行为，当前轮完整结束后启动下一条。
2. **补充消息**：交给正在运行的 worker，显示待投递/已接收状态；实际何时纳入推理应按目标版本实测，不用“发送成功”暗示即时生效。
3. **打断并发送**：持久记录新指令，显式停止当前轮，确认终止事件后继续；原任务显示已中断，不伪装成成功或直接丢弃。

Task 继续作为执行的持久记录。若未来选择一会话长驻 worker，必须另行定义其跨 Task 生命周期：不能把 `ResultMessage` 当成进程退出，一个原生会话也不能被两个 Task 并发驱动。无论采用哪种粒度，都应共享单一读循环，使用任务/轮次/消息 ID 与幂等键保存事件、输入及中断请求。网页刷新或服务重启应能重连 worker；只把客户端放在 FastAPI 内存里会损失现有后台存活能力。

按项目规则，REST 能力必须同时具备 Web UI 和 CLI 操作。现有恢复、fork 原生 session ID、费用、日志解析、自动重试/账号切换及过期输入拒绝都属于兼容边界，不能只验证界面能输入文字。

## 验收前仍未知

- 在容器固定版本及明确认证方式下，运行中第二条消息的实际消费时机。
- 生成文本、普通工具、长 Bash、并行工具分别被 interrupt 后是否还有后续输出或后台副作用。
- 中断与正常完成竞态、连点两次、网络超时重试是否重复投递或错配轮次。
- 网页刷新、Web 服务重启、worker 崩溃后的消息确认与恢复；输入已确认不等于已执行，需要分别记录。
- SDK 默认 prompt/settings 与现有 CLI 是否等价；应显式验证项目规则、MCP、模型、resume/fork 参数，而非假定替换库后全部继承。

较小的备选方案是“停止旧进程，持原 session ID 重新 resume 并发送纠正指令”。它适合阶段性打断，但不提供同一活进程的持续补充输入；硬杀、未落盘记录与子进程残留仍需验证。PTY/tmux 可以保留人工终端操作，但对当前结构化 Web 聊天、任务关联与恢复机制来说，需要另行处理终端状态及交互解析，不是首选。

另一条低侵入路线是持久收件箱配合 hooks：在适用 hook 触发处读取用户补充内容，返回 `additionalContext`，使其进入后续模型请求。它只在 hook 边界生效，不能保证纯文本生成期间及时介入，也不会自动变成普通聊天气泡，仍需应用记录原文、回执和消费状态。它适合协作补充，不能代替显式 interrupt。[Hooks: add context for Claude](https://code.claude.com/docs/en/hooks#add-context-for-claude)
