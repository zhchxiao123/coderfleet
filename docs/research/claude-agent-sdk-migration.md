# Claude Agent SDK 渐进替换调研

研究日期：2026-11-09（America/Los_Angeles）。本地基线：`00b4915` 加当前工作区未提交改动；这些改动未被覆盖。范围是方案和兼容性研究，未安装 SDK 到项目环境、未运行真实模型、未切换线上执行方式。官方发布基线为 `claude-agent-sdk==0.2.180`，以发布 tag 源码及 PyPI 元数据为准；滚动文档与旧版本可能不同。

## 结论与推荐

可采用官方 **Python Claude Agent SDK + 独立任务 worker**，分阶段替换 Claude 的执行适配器。第一阶段保留「一个 Task 一次完整运行，Conversation 串行 resume」以及现有 JSONL/SSE/任务文件协议；先做到等价问答，再开放运行中补充、interrupt 和原生权限问答。SDK 的底层仍启动 Claude Code CLI，收益主要是官方维护的双向控制、权限回调、会话和事件接口，并不自动提供进程托管或重启重连。[SDK transport 源码](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.180/src/claude_agent_sdk/_internal/transport/subprocess_cli.py)、[Python 客户端源码](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.180/src/claude_agent_sdk/client.py)

初期不应把 SDK 直接作为 FastAPI 的同环境依赖：项目固定 `mcp==1.12.4`，SDK 0.2.180 要求 `mcp>=1.23.0,<3.0.0`，约束没有交集。项目的 pin 与 FastAPI/Starlette/SSE 兼容性有关，贸然升级会扩大改动面。推荐容器中单独 venv 运行 worker；local 账号使用对应的独立环境。TypeScript worker 也能避开 Python 依赖冲突，但会增加跨语言部署和维护成本，暂列备选。[项目依赖](../../pyproject.toml)、[SDK 发布依赖](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.180/pyproject.toml)、[官方 PyPI 元数据](https://pypi.org/pypi/claude-agent-sdk/0.2.180/json)

## 当前执行链与必须保留的契约

用户所说的 `nohup` 在当前持久容器实现中实际是 `setsid bash ... &`。`_build_claude()` 将一次 prompt 通过 `printf` 管道送给 `claude -p --output-format stream-json --verbose`；`build_cli_command()` 包装后台运行、任务 marker、日志文件和 `.exit` 文件。调度器通过日志轮询获取结果，重启后根据 marker 探活并重新跟随日志。[命令构造](../../coderfleet/account_type_registry.py)、[调度器](../../coderfleet/server/scheduler.py)

另有 `_run_ephemeral_task()` 路径：临时容器、保留临时容器以及 local 执行直接读取子进程 stdout，不能把持久容器的 detached 恢复保证推广到所有路径。`ContainerRuntime` 只暴露 run/exec/is_running/remove，`Process` 未暴露持续 stdin，Docker exec 也未启用 `-i`。因此增加 SDK 是新的代理控制层，不能只替换一条 shell 命令。[运行时](../../coderfleet/server/runtime.py)、[调度器](../../coderfleet/server/scheduler.py)

| 当前能力 | SDK 侧映射／兼容要求 |
|---|---|
| 账号、凭据和代理隔离 | worker 留在对应账号容器中，继承原挂载、网络和环境；local 保持账号独立配置目录。不能统一迁到宿主 SDK 客户端 |
| 项目工作目录、模型 | 显式传 `cwd`、`model`；容器路径与宿主路径分别解析，不能把宿主路径直接传给容器 |
| 一次提问及后续任务排队 | 一个 Task 拥有一个 SDK worker；第一期用顶层 `query()` 驱动一次输入并消费至 SDK 运行结束，后续双向版本改用 `ClaudeSDKClient`。排队语义沿用现有调度器 |
| 原生会话恢复 | `resume=native_session_id`，保留原账号、cwd 和 transcript 挂载；收到 init/session 信息立即持久化 |
| 历史轮次分叉 | 发布版已有 `resume`、`fork_session`、`session_id`、`resume_session_at`，可用公开选项映射现有参数并验证生成的 argv。来源会话不可被追加写入 |
| 文件交付系统提示 | 显式 `system_prompt={"type":"preset","preset":"claude_code","append":现有提示}`，不能仅依赖 SDK 默认值 |
| 项目规则、设置、技能和插件 | 显式保留 `setting_sources=["user","project","local"]` 和原始 cwd；MCP、插件及已展开的 `/skill` 提示词分别验证，避免重复扩展或遗漏 |
| 普通与 auto 权限 | 分别映射 `acceptEdits` / `bypassPermissions`；保留 local sandbox/root 门禁。首期继续使用现有 MCP 人工问答和 continuation，并保持 auto 禁用人工等待工具 |
| 图片附件 | 第一阶段沿用现有 prompt 中附加文件路径的行为；SDK 多模态 content 作为独立增强验证，不能悄悄改变历史记录和路径语义 |
| 实时日志、历史回放、token/费用 | 保持现有 CLI JSONL 外形；保存 UUID、session ID、tool ID、父工具 ID、usage/cost、system 和限流事件 |
| 完成、失败、取消 | 对齐 SDK result 的 `is_error`/`subtype`/终止原因与进程退出；不能因 worker exit=0 就把错误或中断标为成功；最终 `.exit` 仅写一次 |
| Web 服务重启 | 独立 worker 继续执行并落盘，服务恢复后重连日志／控制通道；SDK 自身不会重新接管另一进程的存量 stdin |

本表是映射设计，尚非端到端验收。代码依据：`Scheduler.build_cli_command`、`_run`、`_run_ephemeral_task`、`_stream_container_log`、`reconcile_running_tasks`、`kill_task`；`_build_claude`、`_claude_mcp_bridge_arg`、`_events_claude`；`conversation_forks.completed_turn_checkpoint`。SDK 接口依据：[发布版 types](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.180/src/claude_agent_sdk/types.py)、[发布版 transport](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.180/src/claude_agent_sdk/_internal/transport/subprocess_cli.py)。

### 系统提示与设置默认值不能照搬旧调研

发布版 transport 在 `system_prompt is None` 时显式传空系统提示；需要 Claude Code 默认编程行为时，应选择 `claude_code` preset 并追加现有文件交付提示。当前版本 `setting_sources=None` 且未配置新 `skills` 选项时会继承 CLI 的 user/project/local；配置 `skills` 又会改变默认设置来源。因此显式列出来源比依赖默认更可审查。先前 [运行中干预研究](claude-runtime-intervention.md) 中把「SDK 默认不加载设置」列作风险，不能作为本次发布版的确定事实。[发布版 transport](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.180/src/claude_agent_sdk/_internal/transport/subprocess_cli.py)、[当前官方设置说明](https://code.claude.com/docs/en/agent-sdk/python#setting-source)

## 日志兼容性：不能直接序列化 SDK dataclass

对发布版 `message_parser.py` 和 `types.py` 做了离线探针：使用官方函数原逻辑及所需 dataclass 定义，通过 AST 选取后执行，避开安装 SDK 及其依赖。输入是人工构造事件，不涉及用户会话或模型。8 项结构断言通过，观察到：

- `dataclasses.asdict(AssistantMessage)` 不带外层 `type`、`message`，内部 TextBlock 也不带 `type:"text"`，直接写入现有日志会破坏渲染和解析。
- 当前 AssistantMessage **已经保留** `uuid`、`session_id`、`usage`、`message_id`；UserMessage **已经保留** `tool_use_result`。不能依据旧 SDK 信息宣称这些字段都没有。
- UserMessage 没有原始 `session_id`；限流对象将部分 camelCase 键改为 snake_case，同时在 `raw` 中保留原限流对象。
- 未识别顶层事件返回 `None`；TextBlock 的额外字段（探针使用 `citations`）不被保留；用户直接 image block 在当前 parser 中被跳过。后者不等于工具结果内嵌的 image 也被丢弃：ToolResultBlock.content 仍保留原嵌套列表。

因此，**渲染兼容**和**原始日志完整性**要分开处理。映射 SDK 公开对象能覆盖常见渲染字段，但不能恢复已被 parser 丢弃的信息。优先采用 transport 的 `read_messages()` 边界、进入 parser 前旁路保存原始业务事件，再用 SDK 公开对象做控制与状态判断。应过滤内部 control_request/control_response 等控制帧；保存的是业务事件语义，不承诺与 CLI stdout 字节完全相同。若初期只实现对象映射，应明确日志信息缩减，不能宣称原始日志无损兼容。[发布版 parser](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.180/src/claude_agent_sdk/_internal/message_parser.py)、[发布版类型](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.180/src/claude_agent_sdk/types.py)

这条旁路接缝可以包装官方 `SubprocessCLITransport`，继续由 SDK 处理分帧、输入和控制协议；但该实现位于私有模块，`Transport` 的接口说明也明确不保证未来稳定，必须锁版本并限制到单一兼容模块。自定义 transport 要自己应用同一份 cwd/model/权限等选项；特别是 `can_use_tool` 所需的 `permission_prompt_tool_name="stdio"` 规范化，不能因提前构造 inner transport 而遗漏。custom transport 还跳过 SessionStore 的自动物化；首期继续使用原有磁盘会话。[Transport 契约](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.180/src/claude_agent_sdk/_internal/transport/__init__.py)、[初始化与规范化详解](claude-agent-sdk-official-findings.md#可选的-raw-事件旁路设计推论)

当前 `completed_turn_checkpoint()` 要求外层 assistant UUID、匹配的 session ID、非子代理事件、闭合的 tool_use 和成功 result，分叉是首批必须验证的消费者。后端 token/费用解析依赖 CLI 事件外形，前端也依赖 `system`、`assistant`、`user`、`result`、`rate_limit_event` 以及 `parent_tool_use_id`。显示接口会剥除冗余 `tool_use_result`，原始日志接口仍需保留它。[分叉校验](../../coderfleet/server/conversation_forks.py)、[日志解析](../../coderfleet/server/log_parser.py)、[前端渲染器](../../coderfleet/server/static/js/renderer.js)

## 推荐架构与迁移顺序

调度器继续管理 Task、账号、串行队列和持久状态；账号执行环境里的独立 worker 持有 SDK 运行实例和 Claude 子进程。第一阶段用 `query()` 保留 SDK 自身的一次完整运行收尾逻辑，双向阶段再用 `ClaudeSDKClient` 的持续读循环。业务事件先落当前 task 日志，再用于状态更新；worker 的诊断输出走独立 stderr/诊断文件，避免混入 JSONL。凭据通过现有环境／挂载获取，不写进任务 spec 或日志。

### 第一阶段：兼容执行器，可选择回退

1. 在代理层引入 `cli` / `sdk` 执行适配器，保留 `ContainerRuntime` 负责 Docker/local 机制。只给 Claude 接 SDK；其余账号类型沿用原实现。
2. 为 worker 准备独立 venv，并锁定 SDK 与 CLI 组合。可以显式 `cli_path` 复用经测试的 CLI，也可采用 SDK bundled CLI；避免交互终端 CLI 自动更新而 worker 版本不明。当前 Docker 镜像已有 Python 3.12、Node 22，Python 版本下限不是直接阻塞。
3. 以结构化 spec 传 cwd/model/session/fork/auto/附件和提示词。持久容器暂保留后台启动与 `.log`/`.exit` 协议；ephemeral/local 各自使用原有 runtime 入口。后台隔离机制仍有价值，不能因改用 SDK 而取消。
4. 启动前检查环境、配置和所需能力。将选定执行后端及必要版本信息绑定到 Task，旧记录按 `cli` 恢复，切换配置不能改变正在执行的任务。首期保持每个 Task 一次用户输入所驱动的完整运行、每个 Conversation 同时一个执行者；不能把首个 result 当作包含后台子任务的整个运行结束。
5. 验证旧 CLI 产生的会话能由 SDK resume，以及 SDK 产生的会话能由 CLI resume。切换限于新任务或明确的会话边界。会话绑定同一账号和项目，不能以切换后端为由迁移凭据。

回退只能发生在确认尚未启动 Claude、没有副作用的预检失败时。已经调用模型、写文件或结果不明后，禁止自动再跑一遍 CLI；应保留原 Task 及错误信息，让用户选择重试／恢复。否则 SDK 网络失败可能变成重复工具操作。

### 第二阶段：增加双向控制

在第一阶段的日志和恢复契约通过后增加 worker 控制通道。容器内 Unix socket 可供 `docker exec ... workerctl` 使用；local 直接连接本机 socket。不要假设 macOS 宿主可直接连接 Docker VM 中 bind mount 的 Unix socket。命令和回执另有持久记录、消息 ID、幂等键、task/session 归属；服务重新连接不能重复投递旧输入。

产品明确区分「排队」「补充消息」「打断并发送」。`ClaudeSDKClient.query()` 支持持续输入，`interrupt()` 提供显式控制；普通顶层 `query()` 不提供同等的公开客户端控制接口。一次 receive_response 返回并不等于整个常驻 worker 应该关闭；需要唯一消息读循环和严格的轮次归属，避免把被打断轮次的残余 result 归给下一条输入。后台子任务与注入消息也要单独验收。[Python 客户端](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.180/src/claude_agent_sdk/client.py)、[Streaming Input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)

原生 `can_use_tool`／AskUserQuestion 可随后接到现有 intervention REST/CLI/UI；第一阶段继续使用现有 MCP bridge，避免同时替换执行器和人工问答协议。SDK 回调及现有 scheduler Future 都不能凭空获得重启恢复能力，需要单独定义等待问题的持久化与重发规则。所有用户操作按项目约束同时提供 CLI 和 Web UI。

### 第三阶段：按需要常驻会话

只有确认进程启动成本或运行中协作有实际需求，再考虑 Conversation 长驻 worker。届时 Task 从「一次进程执行」到「一轮持久记录」的变化要明确设计；不能把 SDK 的长期连接直接塞进现有 Task 状态机。

## 验收门槛与尚未验证项

| 验收组 | 最小覆盖 |
|---|---|
| 问答与上下文 | 新会话、CLI→SDK→CLI 双向 resume、自定义模型、项目 cwd、CLAUDE.md/user/local 设置、技能、插件、附件 |
| 分叉与历史 | 指定已完成消息处分叉、来源 transcript 不变、分叉后续链不再次 fork、旧日志继续回放 |
| 事件完整性 | 文本／thinking／tool use+result、子代理、Monitor、限流、错误 result、中文、跨 chunk UTF-8、超大单行；检查 `max_buffer_size` |
| 状态与隔离 | 普通/auto 权限、MCP 人工问题、continuation、账号配置隔离、代理出口、local sandbox/root 门禁、持久/临时/local 启动路径 |
| 生命周期 | Web 刷新、服务重启后不重复启动、worker/CLI 崩溃、kill 后子进程清理、取消与正常完成竞态、日志游标不重复不漏、退出状态只落一次 |
| 后续双向功能 | 补充消息消费时机、长 Bash/并行工具 interrupt、旧轮次排空、重试幂等、等待问题时重启 |

本轮确认了源码映射、依赖约束和 parser 结构差异；尚未进行 SDK 实际启动、目标容器构建、真实认证、模型调用、跨后端 session 互通或故障重启实验。离线探针不是运行时验收。探针来源、结果与复现脚本保存在 [.scratch/claude-sdk-research-20261109](../../.scratch/claude-sdk-research-20261109/)。认证需要按实际部署方式核实：当前官方 SDK 概览对第三方产品提供 claude.ai 登录／额度提出事先批准条件，而 Claude Code 法律与合规页另有随产品分发 CLI、由最终用户自行认证的说明；不能仅凭共享 CLI 就承诺现有订阅账号自动适用于本集成，也不能笼统断言所有订阅用法都被禁止。[SDK 概览](https://code.claude.com/docs/en/agent-sdk/overview)、[Claude Code 法律与合规](https://code.claude.com/docs/en/legal-and-compliance)

官方接口、认证说明和源码细节另见 [官方能力核对](claude-agent-sdk-official-findings.md)。本次工作未更改生产执行代码。

## 本轮验证结果

- 离线 parser 探针：8 项断言通过，官方源文件版本与 blob SHA 见 scratch 中 `provenance.json`；可用 `python3 .scratch/claude-sdk-research-20261109/probe_message_shapes.py` 复现。
- 按仓库要求运行 `uv run --with pytest pytest -q`：**789 passed，3 failed**。失败为 `tests/test_runtime.py` 的 `test_local_runtime_run_executes_and_captures_stdout`、`test_local_runtime_is_running_tracks_registered_pid`、`test_local_runtime_remove_terminates_process_and_is_noop_for_unknown`。它们以 ContainerSpec 默认 cwd `/workspace` 启动本地进程，而本机不存在该目录，报 `FileNotFoundError`。本轮未修改运行时和这些测试，未为调研改动该行为，也未将全量测试宣称为通过。
- `git diff --check` 通过；本轮新增两份调研文档和独立 scratch 证据，原有未提交改动保留。
