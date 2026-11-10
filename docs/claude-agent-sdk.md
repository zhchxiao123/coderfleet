# Claude Agent SDK 执行后端

Claude Account 可以继续使用 CLI，或显式选择 SDK。默认保持 CLI。`runtime=container|local` 决定运行位置，`claude_backend=cli|sdk` 决定如何驱动 Claude；两者独立。

SDK worker 仍会启动 Claude Code 子进程。一个 Task 对应一次完整运行，Conversation 的后续 Task 继续使用明确的原生 session ID。运行中的 SDK Task 可通过主发送按钮补充文字或原生 interrupt，也可回答原生 AskUserQuestion；勾选“排队发送”则创建后续 Task。

## 安装与版本

SDK 必须安装在独立环境中。主服务固定的 MCP 版本与 SDK 所需版本不同，不要把 SDK 直接安装进 CoderFleet 的服务虚拟环境，也不需要因此升级 FastAPI、MCP 或 Starlette。

首个固定 SDK 为 `0.2.180`，配套 wheel 内置 Claude CLI 为 `2.1.321`。worker 会核对实际版本；系统交互终端里的另一份 Claude CLI 不会自动成为已验收组合。

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

使用自定义目录时，将 `CODERFLEET_CLAUDE_SDK_PYTHON` 设为该环境的 Python。此路径必须属于实际运行的环境：宿主机路径不能直接用于容器。

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

普通模式仍使用 `acceptEdits`，项目 auto 模式仍对应 `bypassPermissions`；SDK 自身名为 auto 的分类器模式不是项目 auto 的替代项。普通 SDK Task 的原生 AskUserQuestion 通过 `can_use_tool` 等待回答；已有 MCP 人工问答保留，auto 不增加人工等待。其他未被设置或 allowlist 预批准的工具仍明确拒绝，不提供通用权限审批。worker 使用 SDK 的完整运行生命周期，首个 result 不会提前结束仍有后续工作的 Task。

## 运行中交互

新 SDK Task 的控制通道就绪后，桌面和移动端复用主发送按钮：有纯文字时点击“发送”或按 Enter 补充到当前 Task；输入框为空时按钮显示方形图标，点击请求原生中断。勾选“排队发送”、设置定时或附带文件时，仍走后续 Task 的提交路径。补充消息不占等待队列名额，队列满时仍可发送。连接尚未就绪或附件正在上传时，界面明确禁用当前动作，不会静默把插话转为排队。

投递失败保留文字；投递结果未知时保留原请求 ID，并显示查询入口。原 Task 已结束但回执缺失时，主按钮先查询状态，避免将同一段文字自动重放为新 Task。

原生提问复用问题卡片，可单选、多选或自由输入；回答保留原问题结构，并交还原生工具调用。问题最多等待 10 分钟，超时或中断后关闭。持久容器中的等待由 worker 持有，服务重启并重新接管后可继续回答；旧 MCP 提问仍受原进程内 Future 的恢复边界限制。

```bash
coderfleet task status <task-id>
coderfleet task answer <task-id> --json '{"问题原文":"选项"}'
coderfleet task send <task-id> '补充要求' --request-id my-message-1
coderfleet task interrupt <task-id> --request-id my-interrupt-1
coderfleet task command-status <task-id> my-message-1
```

这些交互命令和 status/answer 在本机读取当前工作区 API key，远端使用显式 `CODERFLEET_API_KEY`。非默认端口继续设置 `CODERFLEET_API`。

补充消息目前只接受文字，附件继续使用原发送入口排队。“已接收”表示已交给当前 SDK 输入；模型可能在当前轮次内消费，也可能在后续轮次处理，不承诺立即抢占。每条投递带请求 ID；同 ID、同内容重试返回原回执，不重复发送。超时或连接丢失时保留草稿，用原 ID 查询或重试，不自动转成新 Task。

interrupt 使用 SDK 原生控制请求，保留 session ID；完成后 Task 的取消状态带 `interrupted=true`，界面显示“已中断”，Conversation 可接着续聊。中断不会回滚已有文件修改。原来的强制终止仍保留。

控制通道是项目 `.coderfleet-tasks/<task-id>.control` 中的原子命令与持久回执，不新增端口。每次 worker 有单独能力令牌，令牌不进入 Task HTTP 响应或业务日志。关闭后拒绝新输入；结果未确认时不重放。旧 worker 没有该能力时明确拒绝，只有新 Task 使用新协议。

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

SDK 的 result 表示一次 turn 结束；后台 agent 的后续 turn 结束前，worker 保持输入和官方运行状态跟踪。SDK 当前默认轮间等待上限为 10 分钟（原生 `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`），活跃主 turn、权限请求或跟踪中的 agent 会暂停该计时；它不是 Task 的总运行时限。前端仅依据调度器的最终日志页脚显示任务完成。

持久 SDK Task 保存原始日志已消费字节与目标日志已提交字节。服务恢复先丢弃未提交尾部，再续读源文件，避免遗漏停机期间事件或重放已显示日志。新会话在初始化时即保存 session ID，后续失败或停止不会清空它。显式停止会验证 worker 及受管理 CLI 已退出，再释放 Conversation；观测失败时保留运行状态以避免重复执行，且不阻塞其他 Task 的启动恢复。local SDK 不继承服务进程中的其他账号令牌，显式项目、账号与 Task 配置仍按原优先级覆盖。

真实模型验收必须使用经授权的账号和新隔离测试容器，凭据只读挂载，走现有容器 → relay → 宿主代理链路；实际验收记录单独保存。普通工具中断与恢复、原生问题在服务重启后的回答，以及当前轮次消费补充消息，都需要真实 bundled CLI 的证据，离线 fixture 不能替代。
