# Claude Agent SDK 执行后端

Claude Account 可以继续使用 CLI，或显式选择 SDK。默认保持 CLI。`runtime=container|local` 决定运行位置，`claude_backend=cli|sdk` 决定如何驱动 Claude；两者独立。

SDK worker 仍会启动 Claude Code 子进程。一个 Task 对应一次完整运行，Conversation 的后续 Task 继续使用明确的原生 session ID。运行中的 SDK Task 可通过主发送按钮补充文字或原生 interrupt，也可回答原生 AskUserQuestion；勾选“排队发送”则创建后续 Task。

## 安装与版本

SDK 必须安装在独立环境中。主服务固定的 MCP 版本与 SDK 所需版本不同，不要把 SDK 直接安装进 CoderFleet 的服务虚拟环境，也不需要因此升级 FastAPI、MCP 或 Starlette。

当前固定 SDK 为 `0.2.186`，配套 wheel 内置 Claude CLI 为 `2.1.329`（由 `0.2.180` / `2.1.321` 升级）。worker 会核对实际版本；系统交互终端里的另一份 Claude CLI 不会自动成为已验收组合。

### 容器 Account

新的共享镜像将 SDK 安装到 `/opt/coderfleet-claude-sdk-venv`，并设置：

```text
CODERFLEET_CLAUDE_SDK_PYTHON=/opt/coderfleet-claude-sdk-venv/bin/python
```

旧容器及基于旧共享镜像的项目镜像需要显式重建并更新后才能使用该环境。修改账号后端设置不会自动重建镜像、运行 apply 或停止正在执行的 Task。先在独立测试项目验证新镜像，再按原有容器发布流程更新。

容器中的只读安装检查：

```bash
python3 /usr/local/bin/coderfleet-install-claude-sdk \
  --venv /opt/coderfleet-claude-sdk-venv --check
```

该检查只导入包并调用 bundled CLI 的 `--version`，不登录、不输出或迁移令牌、不请求模型。JSON 结果包含 `ready`、SDK/CLI 版本、解释器路径和失败原因；缺环境或不支持的 wheel 返回非零。

### local Account

在安装 CoderFleet 的环境中运行打包安装器：

```bash
python3 -m coderfleet.data.scripts.install_claude_sdk
```

默认创建 `${XDG_DATA_HOME:-~/.local/share}/coderfleet/claude-sdk`。可以明确指定独立目录和 Python 3.10+：

```bash
python3 -m coderfleet.data.scripts.install_claude_sdk \
  --venv /absolute/path/to/claude-sdk --python /absolute/path/to/python3
```

使用自定义目录时，将 `CODERFLEET_CLAUDE_SDK_PYTHON` 设为该环境的 Python。此路径必须属于实际运行的环境：宿主机路径不能直接用于容器。账号的 `CODERFLEET_CLAUDE_SDK_PYTHON` 在新 Task 派发时读取，持久容器无需为此重建；它优先于项目中的同名变量，与临时执行和账号诊断保持一致。可以将独立版本环境放在该账号现有共享挂载中的代码目录，保留旧环境，再切换新任务的解释器。

离线部署可先把目标平台所需的全部 wheels 放入独立目录，再传 `--wheelhouse /absolute/path/to/wheels`。安装器在此模式使用 `--no-index`，不会回退联网。安装失败后环境不会被标为 ready，修复下载源或 wheel 集后可以重跑安装器。

## 启用、检查与切回

```bash
coderfleet account sdk-status <account-name>
coderfleet account backend <account-name> sdk
coderfleet account backend <account-name>
```

Web 账号表单提供同一后端选择和诊断能力。只有 Claude Account 可以选择 SDK；其他代理保持原执行方式。

CLI 默认连接 `http://localhost:8765`。服务使用其他端口时设置 `CODERFLEET_API`，例如 `CODERFLEET_API=http://127.0.0.1:8767 coderfleet account sdk-status <account-name>`。这两个 SDK 账号命令连接本机时自动读取当前工作区的 `api_key.txt`；连接远端时需显式设置 `CODERFLEET_API_KEY`，不会把本机密钥自动发往远端。

后端在 Task 提交时固化，SDK Task 同时保存运行位置供派发、停止和恢复使用。切换设置只影响之后提交的新 Task，已排队或运行的 Task 不改后端或运行位置。Task 详情和 CLI status 显示实际后端及版本。缺 SDK 环境、版本不符或启动失败会明确报错，不静默换成 CLI。

切回时：

```bash
coderfleet account backend <account-name> cli
```

之后可以显式新建恢复或重试 Task。已经开始执行、产生文件修改或结果不明的 Task 不自动重放。旧 SDK 日志、状态和已持久化的 session ID 保留。

## 认证、网络与已有行为

使用原 Account 的认证目录、环境和代理规则。SDK 的独立 Python 环境不代表新的账号，也不能用它集中复制多个账号的凭据。目标 SDK/CLI 组合是否支持现有认证来源，需要按部署方式和实际账号验证。

容器继续使用现有网络边界和代理；local 继续遵守现有代理兼容规则、sandbox 确认和 root/auto 门禁。项目工作目录、规则、技能、插件、附件及 MCP 工具使用原布局与权限语义。检查版本或通过离线协议 fixture 不等于认证、代理出口或真实工具验收已经通过。

普通模式仍使用 `acceptEdits`，项目 auto 模式仍对应 `bypassPermissions`；SDK 自身名为 auto 的分类器模式不是项目 auto 的替代项。普通 SDK Task 的原生 AskUserQuestion 通过 `can_use_tool` 等待回答；已有 MCP 人工问答保留，auto 不增加人工等待。其他进入 can_use_tool 的工具显示一次性授权卡，可批准、修改参数或拒绝；ExitPlanMode 批准后切到 session 级 acceptEdits。allow/deny 规则、Hooks 和当前权限模式仍先决定是否需要回调。通过运行设置可切换六种 SDK 权限模式；显式 permission_mode 优先于项目“全自动”预设。worker 使用 SDK 的完整运行生命周期，首个 result 不会提前结束仍有后续工作的 Task。

## 运行中交互

新 SDK Task 的控制通道就绪后，桌面和移动端复用主发送按钮：有纯文字时点击“发送”或按 Enter 补充到当前 Task；输入框为空时按钮显示方形图标，点击请求原生中断。勾选“排队发送”或设置定时时创建后续 Task。附件默认排队；在“SDK 参数”中勾选“附件随当前任务插话”后，新 worker 可把已上传的 PNG/JPEG/WebP/GIF/PDF 转成原生内容块投递到当前 Task。其他文件保留路径引用；旧 worker 明确保留排队路径。补充消息不占等待队列名额，队列满时仍可发送。连接尚未就绪或附件正在上传时，界面明确禁用当前动作，不会静默把插话转为排队。

就绪状态在日志跟随期间也自动同步，无需刷新页面；切换对话会立即撤销旧 Task 的交互操作。投递失败保留文字；投递结果未知时保留原请求 ID，并显示查询入口。原 Task 已结束但回执缺失时，主按钮先查询状态；勾选排队或定时也不会绕过该检查，避免将同一段文字自动重放为新 Task。

原生提问复用问题卡片，可单选、多选或自由输入；有选项时也保留“其他”输入。回答保留原问题结构，并交还原生工具调用。回答响应丢失后复用相同 token 和内容查询/重试；明确拒绝的尝试可纠正后重新提交，已接收或结果未知的答案不重放。问题关闭后禁用全部回答控件，迟到的网络错误不覆盖关闭状态。问题最多等待 10 分钟，超时或中断后关闭。持久容器中的等待由 worker 持有，服务重启并重新接管后可继续回答；旧 MCP 提问仍受原进程内 Future 的恢复边界限制。

```bash
coderfleet task status <task-id>
coderfleet task answer <task-id> --json '{"问题原文":"选项"}'
coderfleet task send <task-id> '补充要求' --request-id my-message-1
coderfleet task interrupt <task-id> --request-id my-interrupt-1
coderfleet task command-status <task-id> my-message-1
```

全部 Task HTTP 命令在本机读取当前工作区 API key，远端使用显式 `CODERFLEET_API_KEY`；本机密钥不会自动发送给远端。非默认端口继续设置 `CODERFLEET_API`。

补充消息默认只发文字；勾选原生附件插话后，新 worker 可接收本项目已上传附件，默认发送行为仍保留排队。“已接收”表示已交给当前 SDK 输入；模型可能在当前轮次内消费，也可能在后续轮次处理，不承诺立即抢占。每条投递带请求 ID；同 ID、同内容重试返回原回执，不重复发送。超时或连接丢失时保留草稿，用原 ID 查询或重试，不自动转成新 Task。

新 worker 为初始输入及每条插话发送稳定且属于当前 Task 的原生 UUID：同一请求重试不变，新请求即使内容相同也使用新 UUID。CLI `task send` 打印消息 UUID，`task command-status` 的原回执保留该 UUID；`task logs` 保留 SDK 原始 `user_message_uuid` / `user_message_uuids` 供查询。旧任务仍显示实际启动版本，旧回执和日志无需迁移。

插话在对话中显示为自己的用户消息，状态从“已投递”到“已纳入本轮”，再到“本轮完成／失败／中断”；有对应文字回复时点击状态即可定位。一个模型轮次可以纳入多条输入，后台事件触发的轮次也可能答复用户。SDK 往往只在本轮首条或归属变化的事件携带 UUID，因此界面在当前原生轮次内沿用关联，并在 result 后清空。仅 result 才出现的新输入也可定位本轮最终文字；下一轮没有文字时不会借用上一轮回复。仅有原生 UUID 关联才能确认归属；旧日志、缺字段或 SDK 的最多 64 条关联列表未包含该输入时，不按结果数量猜测。正常 Task 结束仍未确认的消息显示“任务结束 · 归属未确认”。这些状态说明处理进度，不等同于需求已实现或验收通过。

执行详情默认收起为一条当前状态，点击可查看工具和可展示的思考内容；原生问题、授权和工具失败会自动展开，最终任务失败也保持可见。`thinking` 可设置 `{"type":"adaptive","display":"summarized"}` 请求模型提供的思考摘要，或用 `"display":"omitted"` 省略；`disabled` 不接受 `display`。界面只展示 SDK 实际返回的内容。

interrupt 使用 SDK 原生控制请求，保留 session ID；完成后 Task 的取消状态带 `interrupted=true`，界面显示“已中断”，Conversation 可接着续聊。中断不会回滚已有文件修改。原来的强制终止仍保留。

控制通道是项目 `.coderfleet-tasks/<task-id>.control` 中的原子命令与持久回执，不新增端口。每次 worker 有单独能力令牌，令牌不进入 Task HTTP 响应或业务日志。关闭后拒绝新输入；结果未确认时不重放。旧 worker 没有该能力时明确拒绝，只有新 Task 使用新协议。

## 原生只读工作流

普通项目问答仍为默认。需要多路审计或交叉研究时，在原项目聊天的“更多 → 下次任务的高级设置 → 本次执行方式”选择“只读项目审计”或“只读资料研究”，再输入具体问题。它仍是当前 Conversation 中的一个 Task，无需创建看板或 CoderFleet Workflow DAG。已有任务在运行时，这次请求会进入后续 Task，不能当成给普通任务的插话。

预设只作用于本次任务。服务端保留原 Conversation 的高级设置，客户端只在提交成功后清除这次预设；失败、切换页面或提交期间的新编辑不会被误清空。未选择预设时，原有问答、开发、原生提问、插话和中断保持原行为。

CLI 使用相同的参数 JSON，保存为 `audit.json`：

```json
{
  "native_workflow": {
    "preset": "audit",
    "max_concurrent_agents": 2,
    "timeout_seconds": 600
  },
  "max_turns": 24,
  "max_budget_usd": 2
}
```

```bash
coderfleet task run '审计 src 下的鉴权路径，交叉核验发现并给出文件证据' \
  --project <project-name> --conversation <conversation-id> --sdk-options audit.json
coderfleet task status <task-id>
coderfleet task logs <task-id> -f
coderfleet task interrupt <task-id> --request-id stop-audit-1
```

`preset` 也可用 `research`，增加 WebSearch / WebFetch。默认最多 2 个原生并发 Agent、24 个 SDK 主轮次、$2 SDK 预算、600 秒执行时限；配置上限分别为 4、40、$10、1800 秒。Agent 总数“小于五个”属于给原生编排的规模指导，不是平台对总数的硬限制。执行时限由 worker 观察并清理运行，初始化和收尾另有运行时等待；SDK 费用口径不等同于实际账单。

审计预设提供 Read / Glob / Grep / Workflow；研究预设增加网络检索工具。独立工具集、原生 PreToolUse 拦截和不可放宽的运行设置共同限制写入；运行时注入的 StructuredOutput 只返回数据，仍允许使用。不会加载项目扩展、插件、自定义 Agent、MCP 或执行 Hook。账号与项目的 `disableWorkflows` 和权限拒绝规则继续保留；原本需要授权的操作在该只读预设内拒绝，不自动批准。常规项目任务的配置不受这些限制影响。

本批预设限定普通已配置项目；平台助手、真正的临时工作区和文件恢复任务明确拒绝。可以切换模型、查看上下文和停止原生后台任务；不能在运行中把此预设变成可写模式。超时、运行时不提供 Workflow，或只有工具尝试而没有真实原生运行完成事件时，任务明确失败，不把普通回答当作工作流验收成功。

执行详情中可展开 Workflow 的编排源码、工具结果、原生后台 ID、工具调用数、token 和耗时。频繁进度更新同一张卡片，子过程收在所属工作流下面；中间模型 result 不结束 CoderFleet Task。此预设的原生中断会请求停止所属 Workflow，再中断主轮次并清理退出，不等待额外后台唤起的模型轮次；原生会话和编排的持久状态保留供之后明确续聊。原生 `command_lifecycle` 的 `queued / started / completed` 按 `command_uuid` 合并为一条中文状态，重复、迟到和历史重载不产生三张红色 JSON 卡；“指令处理已结束”不代替回复成功或 Task 完成。Task 结束但缺少原生命令终态时显示“指令终态未确认”，不会继续显示执行中，也不会编造取消或成功。

官方原生编排的入口与运行边界见 [Workflow 指南](https://code.claude.com/docs/en/workflows) 和 [SDK cookbook](https://platform.claude.com/cookbook/claude-agent-sdk-08-dynamic-workflows)。本阶段验收与后续范围见 [第二阶段记录](research/coderfleet-sdk-workflow-stage2-20261120.md)。

## 验收记录要求

对每个实际交付的 SDK/CLI/平台/运行路径组合分别记录证据：

1. 安装和只读诊断：版本匹配、bundled CLI 可执行、主服务依赖未被升级。
2. 无模型的受控协议测试：原始业务事件、未知字段、中文分片、超过 1 MiB 的工具事件、控制帧过滤、失败与退出。
3. 使用明确指定的独立测试账号和新会话进行真实请求：CLI→SDK→CLI resume、指定 checkpoint 分叉且来源 transcript 不变、实际工具/附件/MCP、代理出口与账号隔离。
4. 持久容器的服务重启：worker 保持存活、只重新跟随原 Task、日志不重复不漏、最终状态准确。
5. local 的真实 cwd、会话来源、停止与子进程清理；临时容器的一次性释放、会话保留及 TTL 分别验证。

现有 local 和临时路径没有因此自动获得与持久容器相同的跨服务重启续跑承诺。无法重连时应明确失败；等待中的进程内人工问题也不能据此视为已实现跨重启恢复。

发布记录必须区分离线 fixture、真实 SDK 加受控 CLI、真实 bundled CLI/模型、实际容器生命周期四种证据，列明未执行项。没有真实请求或目标容器实验时，不得宣称该组合完整验收。CLI 保持默认后端，直到所有计划交付路径通过各自的验收。

### 开发者的无模型验收

真实 SDK 与受控 CLI 的 worker 测试需要显式指定独立测试解释器：

```bash
CODERFLEET_TEST_SDK_PYTHON=/absolute/path/to/claude-sdk/bin/python \
  uv run --python 3.13 --with pytest pytest -q tests/test_claude_sdk_worker.py
```

容器 Task 集成测试默认跳过。使用一个已经具备固定 SDK 环境的本地镜像明确启用：

```bash
SDK_TEST_IMAGE=your-local-sdk-image:tag \
  uv run --python 3.13 --with pytest pytest -q tests/test_claude_sdk_container_integration.py
```

这些测试只创建全新的测试账号目录、工作区和禁网容器，结束后只删除本次创建的容器，不挂载现有账号凭据、不连接模型服务。覆盖持久 Task、临时释放与保留/TTL、错误、停止清理，以及宿主 watcher 进程终止后恢复日志跟随。它们证明执行与生命周期协议，不证明真实模型上下文、认证或公网代理可用。

## 后台运行与日志恢复

正文和思考内容在流式输出时同步渲染 Markdown，按动画帧合并更新；无需等待整段回答结束。分片中的代码围栏、列表和表格使用与最终回复相同的解析器。任务结束或中断时会同步刷新最后一段内容。

后台任务的启动、周期进度和正常完成不逐条追加到对话；原工具卡片显示运行/完成/失败/停止状态。展开卡片可查看原生后台 ID 和结果摘要。找不到所属卡片的后台失败仍提示一次，原始事件继续保留在日志中。

SDK 的 result 表示一次 turn 结束；后台 agent 的后续 turn 结束前，worker 保持输入和官方运行状态跟踪。SDK 当前默认轮间等待上限为 10 分钟（原生 `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`），活跃主 turn、权限请求或跟踪中的 agent 会暂停该计时；它不是 Task 的总运行时限。前端仅依据调度器的最终日志页脚显示任务完成。

持久 SDK Task 保存原始日志已消费字节与目标日志已提交字节。服务恢复先丢弃未提交尾部，再续读源文件，避免遗漏停机期间事件或重放已显示日志。新会话在初始化时即保存 session ID，后续失败或停止不会清空它。显式停止会验证 worker 及受管理 CLI 已退出，再释放 Conversation；观测失败时保留运行状态以避免重复执行，且不阻塞其他 Task 的启动恢复。local SDK 不继承服务进程中的其他账号令牌，显式项目、账号与 Task 配置仍按原优先级覆盖。

真实模型验收必须使用经授权的账号和新隔离测试容器，凭据只读挂载，走现有容器 → relay → 宿主代理链路；实际验收记录单独保存。普通工具中断与恢复、原生问题在服务重启后的回答，以及当前轮次消费补充消息，都需要真实 bundled CLI 的证据，离线 fixture 不能替代。


## SDK 参数与扩展

桌面和移动端把高级能力统一放在输入框工具栏的“更多”中，默认收起。日常聊天直接发送，无需设置。

- “调整当前运行”即时修改所选运行中任务的模型、权限等，不新建任务。
- “会话记录与文件恢复”查看当前或历史 Task 的会话与检查点；有多条记录时先选择任务。
- “下次任务的高级设置”提供可选 JSON 编辑器，仅作用于新建 Task，不改变当前运行。附件插话在“更多”中单独勾选。

CLI 使用 `coderfleet task run '要求' --project <项目> --model sonnet --sdk-options /absolute/options.json`。留空继承会话参数，显式 `{}` 恢复默认。参数保存在 Task 快照中，重试保留原快照；运行中的切换模型/权限不修改账号默认值。

```json
{
  "max_turns": 12,
  "max_budget_usd": 2,
  "thinking": {"type": "adaptive"},
  "effort": "high",
  "agents": {"reviewer": {"description": "检查代码", "prompt": "检查功能与回归", "model": "sonnet"}},
  "forward_subagent_text": true,
  "output_format": {"type": "json_schema", "schema": {"type": "object", "properties": {"summary": {"type": "string"}}, "required": ["summary"]}}
}
```

`GET /api/sdk/capabilities` 返回同源配置及操作 schema。支持 tools/allow/deny、system_prompt、fallback_model、轮数/费用/token 预算、thinking/effort、JSON Schema、Skills、插件、AgentDefinition、MCP、sandbox、settings/setting_sources、Hook 事件和增量输出。预算与模型支持仍由固定 SDK/CLI/模型决定；费用统计不是绝对费用承诺。身份、cwd、凭据、原生 session 归属和代理由 CoderFleet 管理，不能通过任意 SDK extra_args 覆盖。

Python 回调通过 `"extension":{"path":"extension.py"}` 显式加载。文件相对配置项目根目录，必须解析在该根内；工厂默认 `create(context)`，可同步或异步，返回 `hooks`、`mcp_servers`、`session_store`。仅账号 worker 执行它，主服务不会 import 项目模块。示例见 [claude_sdk_extension.py](../examples/claude_sdk_extension.py)，包含 Hook 和 SDK 进程内 echo 工具。凭据使用账号/项目环境，避免写入可见的 Task JSON。

`"session_store":{"type":"sqlite"}` 启用账号目录下独立的 SQLite 镜像，保留未知 JSON 字段，跨进程事务追加，按 UUID 幂等；本地原生记录仍保留。也可由工厂提供远程 SessionStore，其管理操作沿用账号运行位置和 relay/代理。支持 `session_store_flush` 与 `load_timeout_ms`。镜像写入失败会显示提示；不能把 Task 成功等同于远程备份始终成功。

## 运行设置与工具批准

运行设置可查询 MCP、初始化能力、上下文占用，切换模型/权限，重连或启停 MCP，以及停止指定原生后台任务。SDK 后台 `task_id` 和 CoderFleet Task ID 是两种标识。操作有持久回执；结果未知时保留同一 ID 和参数查询，不能换 ID 自动重放。

```bash
coderfleet task approve <task-id> --decision allow
coderfleet task approve <task-id> --decision deny --message '请先说明修改范围'
coderfleet task sdk <task-id> get_context_usage
coderfleet task sdk <task-id> set_model --json '{"model":"sonnet"}' --request-id model-1
coderfleet task sdk <task-id> toggle_mcp_server --json '{"server_name":"project_tools","enabled":true}'
coderfleet task send <task-id> '查看图片' --image /workspace/.coderfleet-uploads/image.png --request-id image-1
```

批准工具可用 `--input-json` 修改输入；原生问题和审批的 CLI 都打印问题标识/token，可通过 `--tool-call-id ... --token ...` 在问题关闭后精确重试。等待最长十分钟，拒绝、超时、中断和结束均关闭表单。

## 原生记录与文件检查点

“更多”中的“会话记录与文件恢复”面板和 CLI `task session` 提供当前项目已绑定会话的 info/list/messages/subagents/subagent_messages/rename/tag/fork/delete/import_store。查询固定账号/cwd，不接受浏览器覆盖认证根目录。元数据 helper 不启动模型；使用外部存储时需要对应账号的网络链路。原生分叉会创建可续聊的 Conversation，并保留存储配置；与现有受管分叉一样限定普通项目工作区，临时工作区不会被静默替换。普通 local 项目不因此改成临时项目。

```bash
coderfleet task session <task-id> messages --json '{"limit":50,"offset":0}'
coderfleet task session <task-id> tag --json '{"tag":"reviewed"}' --request-id tag-1
coderfleet task session <task-id> fork --json '{"title":"独立方案"}' --request-id fork-1
```

修改操作要求工作区空闲，使用持久 lease 与回执；原生删除要求所有引用先归档，且明确确认 session ID。有镜像时同步本地与镜像；不能确认子 Agent 级联删除的 provider 会明确拒绝。部分失败保留未知结果，不能假报成功或自动重放。分叉共享普通项目当前文件，不复制 undo/file-history。

启用 `"enable_file_checkpointing":true` 后，保存重放 user 消息的检查点 UUID。“创建文件恢复任务”或 `coderfleet task rewind <source-task> <checkpoint> --request-id rewind-1` 创建独立 Task：复用来源工作区/账号/session，以空输入恢复，不重放原 prompt；相同请求只创建一次。项目有任务运行时拒绝恢复，恢复期间新任务不能并发修改文件。

SDK **0.2.186 仍不允许 SessionStore 和文件检查点同时启用**。恢复覆盖 Write/Edit/NotebookEdit 跟踪的修改，不保证任意 Bash、子 Agent 或外部副作用，也不回退对话历史。SDK 的关闭过程需要有限的刷新/退出时间，恢复 Task 的清理单独保留该时限。
