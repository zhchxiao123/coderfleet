# Claude Agent SDK 执行后端

Claude Account 可以继续使用 CLI，或显式选择 SDK。默认保持 CLI。`runtime=container|local` 决定运行位置，`claude_backend=cli|sdk` 决定如何驱动 Claude；两者独立。

SDK worker 仍会启动 Claude Code 子进程。一个 Task 对应一次完整运行，Conversation 的后续 Task 继续使用明确的原生 session ID。运行中发送消息仍然排队，本阶段不提供运行中补充消息或 interrupt。

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

后端在 Task 提交时固化，SDK Task 同时保存运行位置供派发、停止和恢复使用。切换设置只影响之后提交的新 Task，已排队或运行的 Task 不改后端或运行位置。Task 详情和 CLI status 显示实际后端及版本。缺 SDK 环境、版本不符或启动失败会明确报错，不静默换成 CLI。

切回时：

```bash
coderfleet account backend <account-name> cli
```

之后可以显式新建恢复或重试 Task。已经开始执行、产生文件修改或结果不明的 Task 不自动重放。旧 SDK 日志、状态和已持久化的 session ID 保留。

## 认证、网络与已有行为

使用原 Account 的认证目录、环境和代理规则。SDK 的独立 Python 环境不代表新的账号，也不能用它集中复制多个账号的凭据。目标 SDK/CLI 组合是否支持现有认证来源，需要按部署方式和实际账号验证。

容器继续使用现有网络边界和代理；local 继续遵守现有代理兼容规则、sandbox 确认和 root/auto 门禁。项目工作目录、规则、技能、插件、附件及 MCP 工具使用原布局与权限语义。检查版本或通过离线协议 fixture 不等于认证、代理出口或真实工具验收已经通过。

普通模式仍使用 `acceptEdits`，项目 auto 模式仍对应 `bypassPermissions`；SDK 自身名为 auto 的分类器模式不是项目 auto 的替代项。已有 MCP 人工问答继续走原工具，auto 不增加人工等待；未被已有设置或 allowlist 预批准的请求由非交互 fallback 明确拒绝；原生 AskUserQuestion 不会进入人工等待。这个策略也使 SDK 维持其官方完整运行生命周期，首个 result 不会提前关闭输入或把 Task 标为完成。

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

本轮按用户要求没有真实模型请求、既有凭据挂载或现有工作容器修改。真实认证、跨后端原生模型上下文和公网代理出口仍需单独验收；受控 CLI 的上下文与工具事件只能证明协议处理。
