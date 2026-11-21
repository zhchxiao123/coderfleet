# Claude SDK 第二阶段：原生命令状态与受控工作流

日期：2026-11-20，America/Los_Angeles。沿用已确认的“对话优先”方案，普通项目问答继续是基础入口。本次使用 SDK `0.2.186` / bundled CLI `2.1.329`，没有升级宿主 MCP / FastAPI 或变更账号认证。

## 本阶段实现

1. 解析截图中的原生 command_lifecycle。按 command_uuid 与 session 分组，同一行更新排队、执行、结束、取消或未执行状态；保留原始日志，终态不被重复或迟到帧回退。这些状态只说明原生命令生命周期，不能证明回答成功，也不结束 CoderFleet Task。
2. 普通项目可显式选择只读审计或资料研究。预设进入原 Task、Conversation、账号、容器和 relay 边界；不是平台的持久 Workflow DAG，不要求用户额外建卡片。原问答与开发默认不变。
3. 单次预设与会话默认分开。服务端不把该预设写成 Conversation 的长期默认；桌面、移动端、CLI 共用 JSON 参数。运行中选预设会新建后续 Task，避免把只读要求误发给已有的可写任务。确认提交后只清除对应预设，保留编辑中的新内容和原聊天草稿。
4. 受控工具集、权限回调和原生 PreToolUse 共同限制写工具及 Shell；研究模式额外允许 WebSearch / WebFetch。保留账号／项目禁用工作流及既有拒绝规则，需授权的操作不自动放行。插件、扩展工厂和 MCP 不进入此预设。普通任务仍使用原配置。
5. 并发默认 2、最大 4，通过原生运行时环境约束；SDK 轮次默认 24、最大 40，SDK 预算默认 $2、最大 $10；执行时限默认 600 秒、最大 1800 秒。Agent 总数的规模指导不冒充硬上限，费用不冒充真实账单；初始化与清理保留原有等待边界。
6. 必须观察到所属 Workflow 工具、真实原生运行及完成事件；只有工具尝试或普通回答会失败。后台运行期间保留完整 SDK 生命周期，中间 result 不提前结束 Task。超时、原生中断、能力缺失和权限修改拒绝均有行为验收。
7. 进度更新所属 Workflow 卡片，提供原生 ID、工具次数、token、耗时和编排源码；子过程收在原卡片，常规进度不追加时间线记录。没有给主输入框增加一排按钮。

## 实际验收与证据边界

- 使用既有 Task / FakeRuntime、真实固定 SDK + 离线协议以及桌面／移动共享渲染器做行为验证；覆盖普通追问不继承预设、CLI 传参、请求失败与编辑保留、真实运行证明、权限不可放宽、StructuredOutput、写入拒绝、超时和中断。
- 全新隔离容器使用已授权账号的只读凭据挂载，只提供三个合成文件，复用内部网络 → relay → 代理。最终一次真实模型验收只启动一个 Workflow，包含两个并行核对者与一个独立核验者；实际脚本使用 schema，原生运行完成，最终事实正确，文件名与 SHA-256 集合完全不变，退出码 0。原始 command_lifecycle 实际收到 queued / started / completed。
- 首轮测试规格漏填人工交互超时，启动校验即拒绝，未进入模型。随后真实模型验收暴露只读 Hook 误拒绝 StructuredOutput；已补行为复现并修复，最后在新容器、新会话重新通过。所有失败材料保留，不能把模型自行改用纯文本的那轮计为修复后验收。
- 全量回归发现中断主轮次仍会等待后台 Workflow；现对本预设先受限请求停止所属原生运行，再 interrupt 并走既有清理。另用新真实容器在原生 Workflow 启动后立即中断，回执 accepted、worker cancelled、退出码 143，合成文件不变。也验证了工作流恰好完成与停止响应交错的情况；子 Agent 的 init 不能覆盖根会话能力判断。
- 浏览器隔离页使用修复后真实合成事件与当前共享 renderer，核对折叠、源码和实际进度可读、单条指令状态、草稿保留；390px 布局没有横向溢出。预设与确认清除同时有 DOM 行为测试。页面不连接生产 API，Task footer 为模拟，不是生产任务验收。

本机原始材料：`.scratch/sdk-workflow-stage2-20261120/real-workflow-acceptance.json`、`native-workflow-synthetic-cf527228b4/events.jsonl`（最终正常运行）、`native-workflow-synthetic-adcba96752/events.jsonl`（界面验收素材）、`real-workflow-interrupt.json`、`desktop.jpg`、`mobile.jpg`。测试与服务安装最终状态另记录在该目录的 `VERIFICATION.md`，以实际结果为准。

## 下一阶段

- 第三阶段先做有所有权与恢复边界的 worktree 隔离，再接写入型迁移预设；不把会话 fork 当作文件隔离。
- MCP 连接诊断、登录提示和工具范围先产品化，再按具体需求评估 elicitation、动态 MCP 或独立 TS worker；原生长任务需要服务端协议配套。
- 上下文、额度与预算状态继续收敛；平台助手采用工作流前另验只读工具及来源继承。

普通项目问答、原 Conversation / native session 归属和 Task 生命周期均为后续阶段的保留约束。本批不宣称接入全部 Claude SDK 能力。

官方依据：[原生工作流与并发限制](https://code.claude.com/docs/en/workflows)、[SDK 触发与流生命周期](https://platform.claude.com/cookbook/claude-agent-sdk-08-dynamic-workflows)。
