# CoderFleet 平台级 Agent Harness 调研

调研日期：2026-11-12。范围：官方能力核验与产品建议；未调用模型、修改服务配置、启用定时任务或改变账号权限。当前官方文档可能先于仓库固定 SDK 0.2.180；落地时需要按固定版本源码和协议回归验证，不能直接照搬新接口。

## 结论

**建议：把每日跨项目总结作为平台级 Agent 的第一个只读场景，复用现有 Task/SDK 执行链，补平台工具、证据索引与运行策略。** 不需要先引入第二套 agent 执行框架。跨项目读取是平台控制面授予的显式范围，不应顺带赋予普通项目 agent 横向访问权限。

## 本地核查：日报已有雏形，完整工作复盘尚未形成

核查日期：2026-11-12。检查当前工作树与本机配置；没有触发模型、日报生成、计划创建或运行中的项目操作。

| 现有能力 | 代码依据 | 与本次目标的差距 |
|---|---|---|
| 日报页面、按日期统计、按项目汇总、AI 摘要及 CLI | [coderfleet/server/static/js/digest.js](../../coderfleet/server/static/js/digest.js)；[coderfleet/schedule_cmds.py:114](../../coderfleet/schedule_cmds.py#L114)；[coderfleet/server/main.py:3078](../../coderfleet/server/main.py#L3078) | 可以复用入口和历史记录，不需要另造日报页面 |
| 收集 Task 并读取成功任务最终输出 | [coderfleet/server/digest.py:54](../../coderfleet/server/digest.py#L54)、`:26`、`:133` | 用户指令截至100字、成功输出截至350字，每项目只送前12条；没有按 Conversation 完整整理问答、插话、人工答案或决策 |
| 按日期归档 | [coderfleet/server/digest.py:22](../../coderfleet/server/digest.py#L22)、`:116` | 直接取时间字符串前10位；不按用户IANA时区计算窗口；跨日运行且当天有插话的旧Task会遗漏 |
| 手动/自动生成摘要 | [coderfleet/server/main.py:3126](../../coderfleet/server/main.py#L3126)；[coderfleet/server/scheduler.py:1918](../../coderfleet/server/scheduler.py#L1918) | 使用首个active项目并`auto=True`；普通项目的完整执行权限不适合平台只读总结 |
| 自动触发 | [coderfleet/server/scheduler.py:1918](../../coderfleet/server/scheduler.py#L1918) | 宿主本地23:30生成前一天；没有可配置时区/时间，进程内日期标记不等于持久补跑或生成幂等 |
| 系统级文本模型调用 | [coderfleet/server/system_llm.py:72](../../coderfleet/server/system_llm.py#L72) | 已有独立配置的complete()，但当前日报实际未使用；不等于已具备平台工具调用循环 |
| MCP工具及创建者归属 | [coderfleet/server/mcp_bridge.py:38](../../coderfleet/server/mcp_bridge.py#L38)；[docs/adr/0001-agent-self-service-schedules.md](../../docs/adr/0001-agent-self-service-schedules.md) | 已有人工问答、Continuation与本项目Schedule；未提供跨项目活动检索工具。普通项目agent的范围不应被扩大 |
| 跨项目记录搜索 | [coderfleet/server/search.py:125](../../coderfleet/server/search.py#L125)；[coderfleet/server/main.py:354](../../coderfleet/server/main.py#L354) | 已可查询项目、Conversation、Task及深度日志内容，可作为只读工具的数据入口；仍需范围校验、去敏、来源水位及完整活动覆盖 |

本机只读检查：`DIGEST_ENABLED=false`；存在38份历史日报JSON记录，但此数量不代表38份成功/完整日报；SystemLLM配置完整，未进行可用性或计费调用。

现有模型仅保存日期、统计、AI文本与生成Task ID，没有可核查的完整来源清单、数据水位、覆盖率或摘要版本。生成Task也未被排除在普通任务统计之外，升级时要避免日报汇总自己。

### 三个无模型合成探针

证据：`.scratch/platform-harness-20261112/digest-probe.json`。仅使用新临时目录，退出后清理夹具，没有读取或修改生产问答内容。

1. 同项目13个成功Task：统计为13，摘要输入只包含12个Task标记，确认存在静默截取。
2. `2026-11-13T02:00:00Z`在`America/Los_Angeles`属于11月12日，但现有统计归到13日。时区仅用于证明边界，未来产品应明确配置业务时区。
3. 前一天创建的运行中Task，即使当天日志含补充消息，也未进入当天统计或摘要。


## 官方事实

1. **SDK 已提供主要 agent 执行能力。** 官方概览说明，Agent SDK 提供 Claude Code 的 agent loop、工具和上下文管理，并列出 Hooks、MCP、权限、会话、子 Agent、Skills 等能力；它是在运营者进程中驱动 Claude Code binary 的库。由此可区分：SDK 是执行能力，CoderFleet 仍负责自己产品的运行记录、调度、权限和业务策略。[Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
2. **平台查询能力可以作为自定义工具接入。** 官方 custom-tools 说明可通过进程内 MCP server 把应用函数、数据库和外部 API 暴露给模型；Python 路径使用 `@tool` 和 `create_sdk_mcp_server`，工具包括名称、说明、输入 schema 和处理函数。这里的事实支持复用 SDK 加工具，不证明 CoderFleet 已有跨项目工具。[Give Claude custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools)
3. **工具准入可以由运行时策略控制。** 官方权限页提供 modes、allow/deny rules、Hooks 和运行时回调。具体校验顺序和部分自定义工具策略存在语言/版本差异；平台数据授权仍必须由平台工具服务端执行，不能仅靠提示词或工具名声明。[Configure permissions](https://code.claude.com/docs/en/agent-sdk/permissions)
4. **长任务不能只依赖上下文压缩。** Anthropic 的长任务实践指出，跨上下文工作需要持久的结构化进度、初始化与逐步验证成果；压缩本身不足以保证连续正确执行。本文只从中归纳“显式进度与恢复记录”原则，不把其编码案例的多 Agent 结构当作日报必要条件。[Effective harnesses for long-running agents](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents)

## 建议架构（推断与设计建议，尚未实现）

沿用 `Schedule → Task → 现有 SDK worker → 受限平台工具 → Digest artifact`。Workflow 仅在确实需要多阶段依赖/并行时编排这些 Task；不要另造一个不受 Task 生命周期约束的后台 agent loop。

- **平台专用执行档**：明确执行账号和数据范围，复用账号的容器/relay/代理；摘要任务工作区与业务项目分离。只提供本次需要的工具，禁用项目文件写入、任意 Bash 和平台修改操作。只读能力必须由服务端授权、工具集合及运行环境共同约束，不能把 `plan` 或“不修改文件”的提示当作隔离保证。
- **少量只读平台工具**：列出获准项目；按时间窗分页检索活动；读取指定 Task/Conversation 的问答片段；取得最终状态、验证证据及来源位置。工具服务端从本次运行凭据绑定允许的项目集合，不接受模型自行扩大范围。
- **日志作为资料**：历史提示、模型输出、工具结果都属于被总结的数据，不是对总结 agent 的新指令。过滤凭据、令牌、原始环境与不必要的附件；工具只返回指定事件字段，保留拒绝和缺失信息。
- **完整索引后分层摘要**：先确定时区、半开时间窗和快照水位，建立完整活动 manifest，再按项目/Conversation 分块汇总，最后聚合为当天总览。每个原始活动应标为已处理、显式排除或失败；不能把采样或截断默认为“已总结所有操作”。
- **来源可追溯**：摘要中的决策、结果、风险和待办都带可点击的 Task/Conversation/事件引用；“模型说完成”和“验证结果显示通过”分开记录。没有证据的状态写成待确认。
- **运行策略**：按日期、时区、范围、快照及配置版本建立幂等键；记录输入 manifest、任务 ID、阶段进度、成本与输出版本。预算或上下文不足时分批或标记部分完成；服务恢复从持久状态继续，不重复提交或重复发布。
- **写操作分级**：第一版仅生成可审阅的报告；后续再增加创建待办、提出修复方案、提交任务等工具，并复用已有持久回执与批准入口。项目 agent 已有的本人项目 Schedule 自助创建语义保持原状，平台级跨项目写权限另行设计。

## 每日报告建议内容

平台总览、逐项目问答主题与目标、已确认完成事项、关键决策及变化、失败/阻塞/未验证项、待办和次日建议。附完整性说明：覆盖哪些项目、哪个时区与时间窗、多少条活动、是否有日志缺失或仍在运行的任务。需覆盖当日追加到旧 Task 的插话/人工回答等活动，不能只按 Task 创建或完成日期归档。

## 渐进交付建议

1. **可审阅日报**：用户选择日期/时区/项目范围，一键生成带来源、完整性说明的只读报告；先解决数据覆盖与正确性。
2. **可靠自动日报**：在第一步稳定后加持久触发、补跑、预算、失败恢复与版本管理；避免把固定宿主时刻视为所有用户的“当天”。
3. **平台问答助手**：复用相同工具，回答跨项目进展、决策变化和历史依据。
4. **受控操作助手**：逐项接入建议转任务、工作流、报告发布等写能力，保持现有 Task 为唯一执行原子和账号边界。

## 验收建议

按时区跨日、长时间运行 Task 当日追加消息、同任务多次人工问答、超过分块上限、缺失日志、归档项目、权限排除、运行中结果、重启补跑、重复触发、预算耗尽和提示注入分别验证。摘要事实必须可回到来源；所有输入活动有覆盖账本。该列表是设计建议，并非已执行验收。

## 面向当前平台的落地补充

- 完整性范围首先限定为**平台已记录**的所有项目Task、Conversation与问答活动。交互终端中未登记为Task的CLI会话不能自动算已覆盖；原生历史导入需另行定义。
- 平台专用摘要Task应有用途标记，默认排除在项目工作总结之外，避免日报总结自己；资源消耗仍单独记账。现有日报记录保留，旧记录的来源覆盖不可追溯时明确标为旧版摘要。
- 已有SystemLLM无状态文本生成模块可作为备选，但它走独立系统账号/API及代理配置，不自动继承SDK容器网络保证；采用时仍需统一作业生命周期与记账。面向本次可扩展助手的主方案优先复用已接入的SDK Task执行器。
- 复用现有日报页面；平台级问答采用一个“平台助手”入口，共用同一活动索引，避免向每条任务日志或输入框继续堆按钮。
- 业务时区与自动生成时间应在实际启用时配置；本报告的洛杉矶夹具用于验证日期边界，没有启用任何定时调用。

## 本次验证边界

检查当前代码与本机配置，执行三个新临时目录的合成探针；未改变业务源码、任务、会话、账号、服务配置或计划，未触发任何真实模型调用。未执行完整应用/真实模型验收，本报告是调研与分阶段方案。探针完整结果保存在 `.scratch/platform-harness-20261112/digest-probe.json`。
