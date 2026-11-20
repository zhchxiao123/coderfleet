# CoderFleet 可以用上的 Claude Code / Agent SDK 更新

调研日期：**2026-11-19，America/Los_Angeles**。本文综合当前安装代码、近期 Task 版本记录、官方发布元数据、固定 tag 源码与官方指南。是选型和接入建议；本轮未升级程序、重启服务、修改业务代码/配置、提交任务或调用真实模型。

## 结论

**最值得做的组合是：升级执行运行时 → 插话与回复精确关联 → 收敛执行过程展示 → 受控并行工作流 → 文件隔离。**

当前不是从零接入 SDK。插话、中断、原生问题、工具批准、流式 Markdown、子 Agent 事件、上下文查询、原生会话及文件检查点都已经有实现。新增价值主要来自近期可靠性修复、真正新增的消息归属字段，以及把已有底层能力变成简单、可理解的产品体验。

最热门的 **Code Mode 目前不能用于现有 SDK Task**；Agent teams 的交互式 teammates、`--bg` 独立会话 daemon 也不是当前 SDK worker 的同一种执行模式。不要为接入宣传中的“全部功能”破坏已建立的 Task、账号、容器与代理边界。

## 1. 当前基线与官方最新版本

| 对象 | 当前 CoderFleet | 本轮官方已发布版本 | 证据 |
| --- | --- | --- | --- |
| Python Agent SDK | **0.2.180** | **0.2.186**，LA 11-19 15:00 首次上传 | [PyPI JSON](https://pypi.org/pypi/claude-agent-sdk/json)、[固定版本元数据](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.186/pyproject.toml) |
| SDK 实际捆绑 CLI | **2.1.321** | **2.1.329** | [SDK 捆绑版本](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.186/src/claude_agent_sdk/_cli_version.py) |
| 全局 Claude Code CLI | Dockerfile 通过 npm 安装，独立于 SDK 的 CLI；本轮未逐容器重新盘点 | **2.1.329**，GitHub LA 11-19 14:14 发布 | [npm latest](https://registry.npmjs.org/@anthropic-ai/claude-code/latest)、[官方 release](https://github.com/anthropics/claude-code/releases/tag/v2.1.329) |
| TypeScript SDK | 当前执行 worker 使用 Python | **0.3.329** | [npm 元数据](https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk) |

本机只读检查发现：最近 **20 个已记录的 Claude SDK Task 全部报告 0.2.180 / 2.1.321**；安装器、worker、配置与控制模块、平台助手和 MCP 模块这六类关键文件与工作树一致。该结果证明近期实际执行基线，不代表每个容器的全局 CLI 都是同一版本。原始摘要见 [baseline.json](../../.scratch/claude-new-capabilities-20261119/baseline.json)。只提取版本和状态字段，没有展示或向外部服务发送真实问答内容。

Python 180→186 的公开 `client.py` 字节相同，但类型、消息解析、权限序列化与 transport 有变化，因此“只有 CLI 更新”不准确。固定差异为 [v0.2.180…v0.2.186](https://github.com/anthropics/claude-agent-sdk-python/compare/v0.2.180...v0.2.186)。完整发布时间、签名与 Python/TS 差异见 [SDK 一手资料](claude-agent-sdk-updates-primary-sources-20261119.md)；CLI 逐版本时间见 [CLI 一手资料](claude-code-updates-primary-sources-20261119.md)。

## 2. 建议优先级

下表的产品形态与优先级是结合当前代码作出的工程判断，不是官方承诺或已完成验收。

| 优先级 | 方向 | 用户能得到什么 | 与当前实现的关系 |
| --- | --- | --- | --- |
| P0 | SDK / 捆绑 CLI 升级 | 改善中断、后台停止、续聊、模型切换和长会话可靠性 | 近期确有相关上游修复；需兼容验收 |
| P0 | 插话与回复 UUID 关联 | 看清补充要求是否进入了哪一轮回复 | **Python 0.2.183 新增字段**；当前发送与展示尚未接通 |
| P1 | 思考摘要和统一执行详情 | 能看见当前阶段与子任务，减少重复进度刷屏 | 流式及后台事件已接；补参数和产品展示 |
| P1 | 原生 dynamic workflows 预设 | 全库审计、并行调研、批量迁移、交叉核验 | 早已支持当前版本；普通项目可评估，平台助手有额外工具限制 |
| P1 | 会话 / 工作分支文件隔离 | 多会话并行修改时减少互相覆盖 | worktree 是既有官方能力；当前仅记录分支/worktree 信息 |
| P2 | 上下文、额度与预算可观测性 | 提前发现长会话风险与账号额度等待 | 查询与预算已有；补用户可理解的状态及调度策略 |
| P2 | MCP 连接体验与长任务 | 看清需要登录/失败原因；未来支持耗时外部作业 | 普通连接控制已有；elicitation、动态 MCP、原生 tasks 各有独立门槛 |

### 2.1 P0：升级实际执行器，优先改善已经做好的功能

近期发布中，与我们相关的修复包括：2.1.327 的 headless UUID 重送/恢复、长时间批准等待；2.1.328 的 SDK interrupt 后后台状态误报、Send now 语义、流式静默超时及自动压缩 prompt；2.1.329 的后台 stop/resume 交错、模型设置与排队消息竞态、headless fork/rewind、长 SDK 会话内存。[2.1.327](https://github.com/anthropics/claude-code/releases/tag/v2.1.327)、[2.1.328](https://github.com/anthropics/claude-code/releases/tag/v2.1.328)、[2.1.329](https://github.com/anthropics/claude-code/releases/tag/v2.1.329)

**建议候选为 Python 0.2.186 + bundled CLI 2.1.329。** 这是需要验证的升级目标，不是说这些上游 bug 都已经在本机复现。只升级全局 `claude` 不会升级 worker 使用的 wheel 内 executable。

当前 [安装器](../../coderfleet/data/scripts/install_claude_sdk.py)和 [worker](../../coderfleet/data/scripts/coderfleet_claude_sdk_worker.py)都校验精确版本；[会话 helper](../../coderfleet/data/scripts/coderfleet_sdk_features.py)也有版本门禁。worker 还使用 SDK 私有 `_query`、运行结束事件和 transport seam。因此需要同步更新版本契约并回归，不能直接 `pip install -U` 后宣称兼容。

升级还有行为变化：Python 0.2.181 起 `settings+sandbox` 加载失败会明确报错；0.2.184 修复权限规则更新的序列化。CLI 新版 sandbox 的自动允许行为与旧 Python 注释存在漂移，应显式配置并观察实际审批。当前已有的 SessionStore / file-checkpointing 互斥限制仍在，不能顺便放宽。[固定差异](https://github.com/anthropics/claude-agent-sdk-python/compare/v0.2.180...v0.2.186)、[权限修复](https://github.com/anthropics/claude-agent-sdk-python/commit/8ed58affbee28a201bb5aeb34afcd513415acac5)、[sandbox 行为发布说明](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.325)

### 2.2 P0：让“插话是否被处理”有真实证据

**0.2.183 新增** `AssistantMessage`、`StreamEvent`、`ResultMessage` 上的 `user_message_uuid` / `user_message_uuids`。调用方可发送带顶层 `uuid` 的 user message，识别某轮实际吸收了哪些输入；后台通知启动的回复也可能顺带处理插话，不能只看 turn origin。[引入提交](https://github.com/anthropics/claude-agent-sdk-python/commit/4720d367f7db9d5df8a166c74d7f36a538ac8c34)、[固定 ResultMessage 定义](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.186/src/claude_agent_sdk/types.py#L1798)

当前 [prepare_input / mailbox message 路径](../../coderfleet/data/scripts/coderfleet_claude_sdk_worker.py)对纯文字直接 `query(str)`，附件的 user frame 也没有显式 UUID。`coderfleet_message_accepted` 记录的是已交给 SDK 的请求 ID；[前端](../../coderfleet/server/static/js/renderer.js)提示“补充消息已接收”，尚未利用这些新字段建立输入与回复归属。

**建议的产品行为：** 每条首次发送分配原生 UUID，持久关联 CoderFleet request ID；同一投递重试保持身份，真正的新消息用新 UUID。界面可显示“已投递 → 已纳入本轮 → 本轮完成 / 被中断”。多条插话可以共同归属一个回复，不要求一条消息必然生成一条独立回答。

出现 UUID 本身不证明回答成功；错误 result 也能带 UUID，仍需判断终态。聚合列表最多保留 64 项，字段缺席不能直接判为丢消息并自动重发。现有 worker 已使用持续 `receive_messages()`，应保留这条正确路径，而不是改成收到一个 result 就结束。[字段契约与持续读取说明](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.186/src/claude_agent_sdk/types.py#L1394)

### 2.3 P1：思考摘要和后台过程，集中在一份执行详情

当前已经流式渲染正文和 thinking Markdown，并把后台进度合并到原工具卡片；这些不是待新增功能。值得补的是 Python `thinking.display` 的 `summarized / omitted` 选择：当前 SDK 类型有此字段，但 CoderFleet 严格 JSON schema 尚未开放。此项属于已存在的参数缺口，不将其认作 181–186 首次新增；可用内容取决于模型返回的可展示摘要。[ThinkingConfig](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.186/src/claude_agent_sdk/types.py#L2251)、[当前参数 schema](../../coderfleet/data/scripts/coderfleet_sdk_features.py)

建议保留聊天为主界面：默认一行当前阶段，例如“正在核对 3 个项目”；展开后看工具、子 Agent、失败原因和用量。思考摘要可选展示；常规 Hook、周期心跳继续归并，错误保持可见。把工作流/子 Agent 收进当前 Task 的执行树，避免重复卡片和一排排高级按钮。

Python 0.2.186 的可注册 `HookEvent` 仍为十种，与当前 allowlist 相同。输出事件、Hook output 类型与可注册 callback 是不同层次，不能单纯多加几个字符串就声称接入 `PostCompact`、`Elicitation` 等回调。[Python HookEvent](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.186/src/claude_agent_sdk/types.py#L324)、[官方语言支持表](https://code.claude.com/docs/en/agent-sdk/hooks#available-hooks)

### 2.4 P1：原生 dynamic workflows，更适合全库审计和研究

这是 **2026-05-28 已发布**的能力，不是这周才出现。官方 Python cookbook 给出的门槛为 SDK **0.2.90 / CLI 2.1.154**，我们当前版本已满足。运行时可执行模型编写的 JavaScript 编排，按阶段扇出子 Agent、收集变量中的结果、执行交叉验证，再返回汇总。[官方发布](https://claude.com/resources/articles/introducing-dynamic-workflows-in-claude-code)、[Python cookbook](https://platform.claude.com/cookbook/claude-agent-sdk-08-dynamic-workflows)

适合先提供三种受控项目预设：全库问题审计、多个方案交叉研究、批量迁移后验证。用户仍从现有项目聊天提出要求；只有任务适合并行时才建议使用，并展示预计规模、预算与验证要求。

**架构建议：** `CoderFleet Task → 原生 workflow → 子 Agent`。原生 workflow 在一个账号/worker 中编排，不是 CoderFleet 自己跨 Task、跨账号的持久 DAG；两者分别记账、分别恢复。子 Agent 数量与并发需受平台资源预算约束，不能因为顶层只有一个 Task 就忽略内部并行消耗。[官方运行与成本说明](https://code.claude.com/docs/en/workflows)

普通项目的通用工具审批可承载 `Workflow`；**平台助手不能直接照搬**。当前 [options_for_retrieval](../../coderfleet/data/scripts/coderfleet_platform_tools.py)明确 `tools=[] / agents={} / plugins=[]`，仅开放已授权 MCP，worker 的平台 permission callback 也拒绝其它工具。跨项目总结若要采用 native workflow，必须先设计子 Agent 的只读工具集合、MCP 数据范围继承和来源账本，再专项验收。

不要把 `ultracode` 当万能开关。官方把其关键字限定为真实人类输入，SDK 需表达相应 origin；定时/webhook 输入不能伪装为用户键盘授权。普通明确请求的 workflow 路径应先探测当前命令/工具及账号可用性。[关键字边界与审批](https://code.claude.com/docs/en/workflows#where-the-keyword-works)

### 2.5 P1：worktree 产品化，解决多个会话修改同一目录

官方已有 CLI `--worktree` 与子 Agent 的 `isolation: worktree`；后者及 Worktree hooks 在 2.1.50 就已存在。它与会话 fork 分别解决“文件隔离”和“历史分支”问题。[Worktrees](https://code.claude.com/docs/en/worktrees)、[2.1.50 发布](https://github.com/anthropics/claude-code/releases/tag/v2.1.50)

当前 scheduler 能检测 Git branch / linked worktree，但未见由平台创建、绑定和回收 worktree 的完整生命周期。建议为“并行修改 / 尝试另一种实现”建立受管理的独立工作目录，记录创建者、原 Conversation、分支、账号、挂载与 session cwd。完成后明确选择查看差异、合并或丢弃，不自动删除用户原有 worktree。

Python 当前 `AgentDefinition` 和 CoderFleet schema 没有可直接透传的 typed `isolation` 字段；实现不能假设把它加进 JSON 就会生效。可以先评估 Runtime 层创建工作区再启动现有 SDK，或通过受版本约束的项目 agent 定义验证子 Agent 隔离。Git ignored 的依赖、环境文件、上传根、项目指令及 resume 的 cwd 都要单独处理。文件隔离继续运行在原账号的容器与 relay 内，不代替安全边界。[Python AgentDefinition](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.186/src/claude_agent_sdk/types.py)、[本项目 schema](../../coderfleet/data/scripts/coderfleet_sdk_features.py)

### 2.6 P2：把已有上下文与额度信号用起来

已有 `get_context_usage`、`get_server_info`、轮数/费用/token 预算，前端也能读 `rate_limit_event`。目前更多是高级控制和异常提示；可把它们整合为安静的状态区：当前上下文、预算余额、等待额度恢复原因，以及进入长会话整理的入口。[现有控制表](../../coderfleet/data/scripts/coderfleet_sdk_control.py)、[当前渲染器](../../coderfleet/server/static/js/renderer.js)、[Python 客户端](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.186/src/claude_agent_sdk/client.py)

公共 Python client 没有独立 `compact()` 方法；`/compact` 需要作为当前会话支持的命令派发，并考虑 `verbatim_prompts` 会禁止 slash dispatch。费用为模型/运行时估计，累计口径需要去重，不能把每个 result 的累计费用反复相加。Fast mode 另有资格与额外计费，不能作为默认免费加速。[固定 options](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.186/src/claude_agent_sdk/types.py)、[成本口径](https://code.claude.com/docs/en/agent-sdk/cost-tracking)、[Fast mode](https://code.claude.com/docs/en/fast-mode)

上述是产品化机会，不是宣称新版 SDK 新增了配额调度器。额度不足时可以标明等待并限制后续派发；不能悄悄换账号后继续使用另一账号的会话和认证记录。

### 2.7 P2：MCP 先补连接体验，再评估 TS 与原生长任务

Python 现有 MCP 状态/重连/启停已经接入，SDK 不负责替宿主完成浏览器 OAuth。最先能改善的是连接列表中的可用工具、需要登录、连接失败、权限范围与最近成功结果，让“保存到忆屿”失败时有可操作信息。[SDK MCP 认证边界](https://code.claude.com/docs/en/agent-sdk/mcp#oauth2-authentication)

TypeScript 的公开接口比 Python 更完整，包括动态 `setMcpServers`、`onElicitation`、AskUserQuestion 选择预览、更完整 Hook 和预热。只有明确需要这些能力时，再评估单独的 TS worker/侧车；不能在 Python 控制表中加操作名称假装存在对应官方方法。两种 worker 仍须遵守同一 Task、账号和代理边界。[TS 参考](https://code.claude.com/docs/en/agent-sdk/typescript)、[用户输入预览](https://code.claude.com/docs/en/agent-sdk/user-input#option-previews-typescript)、[SDK 语言差异详表](claude-agent-sdk-updates-primary-sources-20261119.md#4-需要-typescript-或额外协议工作的候选能力)

原生 server-side MCP tasks 是 public beta，要求 CLI≥2.1.304、支持对应 tasks 扩展的服务端，以及 SDK 持续输入和相关开关；不是升级 CLI 就把任何慢调用变成可恢复后台作业。当前主服务 `mcp==1.12.4` 的普通 FastMCP 工具尚未实现这条协议，且有 FastAPI/Starlette/SSE 依赖约束。建议待有构建、导出等长外部作业需求后，先在独立桥接边界试验，保留写操作幂等回执。[MCP tasks 前提](https://code.claude.com/docs/en/mcp#what-a-call-needs-to-become-an-mcp-task)、[当前依赖](../../pyproject.toml)

## 3. 热门功能的适配结论

| 能力 | 现有 SDK Task 能否直接用 | 结论 |
| --- | --- | --- |
| Code Mode | **不能**；官方明确要求交互终端，不支持 `-p`/SDK | 只适合将来单独评估平台终端入口。[要求](https://code.claude.com/docs/en/code-mode#requirements) |
| Agent teams teammates | **不能按宣传中的团队模式使用**；SDK/`-p` 中仍是普通 subagent | 优先已有 subagent 和 dynamic workflow。[限制](https://code.claude.com/docs/en/agent-teams#enable-agent-teams) |
| `claude --bg` / Agent view | `--bg` 与 `-p` 互斥，另有 supervisor | 不替换现有 Task 生命周期。[Headless](https://code.claude.com/docs/en/headless)、[Agent view](https://code.claude.com/docs/en/agent-view) |
| Remote Control | 仍在原本机环境执行，但有账号、组织、端点与 CONNECT 代理要求 | 可后续作为可选远程入口；需验证容器内运行、session 归属及双端控制。[要求](https://code.claude.com/docs/en/remote-control#requirements) |
| Cloud sessions | 执行在 Anthropic 或企业 self-hosted 环境 | 不能将其等同于沿用本机原容器与 relay。[官方说明](https://code.claude.com/docs/en/claude-code-on-the-web) |
| `/loop`、Desktop / cloud schedules | 分属会话计时、桌面进程或云端调度 | 原 CoderFleet Schedule/Workflow 继续做持久调度所有者。[会话定时](https://code.claude.com/docs/en/scheduled-tasks)、[云端定时](https://code.claude.com/docs/en/routines) |
| TS archive/unarchive | TS 0.3.325 新增，Python 没有对应公开 helper | 平台 Conversation 归档和原生记录归档分别建模，暂不为此迁移语言。[发布记录](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.325) |

## 4. 建议落地顺序及验收

**第一批：升级候选 + 消息归属。** 固定 Python/捆绑 CLI；兼容旧 Task 与旧 worker 的能力协商。验证首条及连续多条插话的 UUID、合并回复、附件、后台通知启动的 turn、中断后的错误 result、重复请求和恢复期间的投递。保持原生 Task 唯一执行身份，旧输入不重发，SDK 生命周期结束与每次 turn 结束分别判断。

**第二批：执行详情 + 受控 workflow。** 先普通项目只读审计/研究，再评估写入型批量迁移。单行进度、展开树、预算和失败卡片优先；不在输入框继续堆设置。工作流源码、输入、原生 ID、子任务归属及最终结果可追溯；超过预算或中断时准确收尾。平台助手另做受限工具与来源继承验收。

**第三批：工作区隔离 + MCP 深化。** 明确创建与回收 worktree 的所有权；确认上传、gitignored 文件与 resume 来源。MCP 连接诊断先做；再用具体 elicitation / 动态工具需求决定是否引入 TS，或用具体远程长作业需求决定是否接 MCP tasks。

所有实际执行升级仍应使用**全新隔离测试容器 → 现有 relay → 宿主代理**，只读挂载已授权凭据并使用新 session。覆盖现有 Python/FakeRuntime、真实 SDK 加受控 CLI、真实 bundled CLI/模型、持久容器重启跟随四种证据；旧版已通过不等于新版已通过。生产安装遵守活动任务自然结束的既有边界。

升级验收应额外核对：settings/sandbox 错误是否 fail closed、审批等待超 30 秒后的后台状态、权限记忆与一次允许的区别、代理 CONNECT/流式超时、恢复与 fork/rewind、SessionStore 与检查点互斥。主服务 MCP 依赖不要随 SDK venv 一起升级。

## 5. 本轮证据边界

- 已完成：官方版本/发布日期核验；固定源码/发行声明比对；当前关键代码与已安装包一致性检查；近期 20 条 SDK Task 的版本字段读取；本文及两个一手资料附录。
- 关键判断均有官方链接与本地代码入口。优先级、产品布局及接入顺序是本报告的推断和建议。
- 未执行：版本升级、下载代码执行、模型请求、真实交互/容器/代理/新 API 验收、生产写入、服务或容器重启。
- 没有将新增字段、SDK 导出类型、官方产品页面或历史测试结果当成本项目已经完成接入的证明。
