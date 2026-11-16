# CoderFleet Agent 产品设计：官方能力与产品责任

研究日期：2026-11-15。仅核验官方一手资料；以下是文档事实与设计推论，不是产品实测。官方文档滚动更新，未标发布日期的能力不能据此推定上线时间。仓库指定组合为 Python Agent SDK **0.2.180 / bundled Claude Code 2.1.321**；本研究不证明 latest 文档中的接口在该组合可用，也不替代固定版本验收。建议用于串联、检验已有能力，不表示相应 SDK 选项尚未接入；现状以仓库审计为准。

## 九条设计启示

1. **保留执行内核，建设任务控制层。** Claude Agent SDK 原生提供工具循环、上下文管理、会话和 hooks，本身仍运行 Claude Code binary，进程由集成方运营。推论：CoderFleet 的价值应落在任务归属、持久状态、故障恢复和交付，而不是重新实现模型推理循环。[官方 SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)

2. **把会话恢复、工作区恢复分别设计。** SDK 会话保存对话而非文件系统；最新文档提供外部 SessionStore，但镜像写失败可丢批次并继续。推论：精确绑定 session ID、任务、工作区版本，显示持久化异常；有聊天历史不能直接标记为可恢复执行。[Sessions](https://code.claude.com/docs/en/agent-sdk/sessions)、[SessionStore](https://code.claude.com/docs/en/agent-sdk/session-storage)

3. **事件流必须有产品语义。** SDK 增量事件与完整消息并存；子 agent 的 token 增量不转发，完整消息可带父工具标识。推论：统一事件身份、顺序和断线回放，避免重复展示；区分收到消息、工具结束、回合结束和任务交付。[Streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output)

4. **权限策略要能承受策略服务自身失败。** SDK 有规则、权限回调与执行前 hooks；hook 失败默认可能继续，阻断失败需显式配置且有事件例外。Codex 也分别设计 sandbox 与 approvals，自动审查不构成确定性安全保证。推论：权限范围、审批记录、超时和失败处理应是可审计的产品状态。[Permissions](https://code.claude.com/docs/en/agent-sdk/permissions)、[Hooks](https://code.claude.com/docs/en/agent-sdk/hooks)、[Codex security](https://learn.chatgpt.com/docs/agent-approvals-security)、[Auto-review](https://learn.chatgpt.com/docs/sandboxing/auto-review)

5. **工具接入必须包含可用性契约。** MCP 提供外部工具连接；SDK 不启动交互式 OAuth，缺授权时可继续运行而没有该服务器工具。推论：产品应管理授权归属、健康状态和必要能力检查；缺少任务必需工具时，明确阻塞或经用户接受后降级。[SDK MCP](https://code.claude.com/docs/en/agent-sdk/mcp)

6. **并行要同时解决协调和隔离。** Claude 子 agent 支持独立上下文、工具限制和后台执行；Codex 支持委派、等待汇总，子 agent 继承权限。Codex worktree 隔离不同聊天的文件修改。推论：产品需呈现父子工作、预算、取消和汇合条件，并处理写入冲突；上下文分开不等于文件或权限隔离。[Claude subagents](https://code.claude.com/docs/en/agent-sdk/subagents)、[Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)、[Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)

7. **把交付做成可反馈的对象。** Codex 云委派提供 diff 审阅、迭代和 PR 路径；Copilot 当前云体验允许先研究、计划和修改，再决定创建 PR。推论：交付包应关联需求、diff、实际验证、未验证项和下一步，并让用户反馈继续进入同一工作上下文。[Codex delegation](https://learn.chatgpt.com/docs/prompting)、[Copilot cloud](https://docs.github.com/en/copilot/concepts/copilot-surfaces/copilot-on-github)

8. **自动化需要独立的运行与验收闭环。** Codex 项目定时任务依赖机器及桌面端在线；GitHub Agentic Workflows 将触发、权限和允许输出写入配置。Codex 官方同时强调 AI review 仍是附加审阅者。推论：自动化先具备负责人、去重、重试上限、资源预算和失败通知，完成后仍需测试、审阅及明确接受条件。[Scheduled tasks](https://learn.chatgpt.com/docs/automations)、[Agentic Workflows](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/about-github-agentic-workflows)、[Review rules](https://developers.openai.com/blog/custom-code-review-rules-for-codex)

9. **认证路线取决于产品形态。** 官方承认普通个人 Claude Code/SDK 使用及终端用户自行登录未修改的 Claude Code；SDK overview 与 legal 页面另限制第三方应用内提供 claude.ai 登录、代用户路由订阅额度。推论：本地个人工具、托管原版 CLI、对外 SDK 产品分别核验，不能由“SDK 能登录”推出可转售或代理额度，也不能把个人自用一概判为禁止。[SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)、[Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)

建议顺序（设计推论）：先统一任务状态、事件与恢复证据，再打通权限/工具阻塞和交付反馈，最后扩展并行及无人值守。可以保留现有 Task、Conversation、Workflow、Board 职责：任务记录真实执行，会话承接反馈，流程承接依赖和审批，看板承接目标与验收。无需为包装这些能力另造一套执行引擎。

产品验收应从用户可见结果倒推：交付对应哪一个目标、哪些检查实际通过、哪些仍需设备或外部服务验证、谁能接受结果、失败后从哪里恢复。用户应能分辨排队、执行、等待授权、等待依赖、已产出及已接受，并能从历史交付返回准确的会话与工作区。对重试和续跑，先核对已有副作用，避免重复外部写入；对并行结果，先确认依赖和文件版本，再决定汇合。记录日志只是证据入口，还需要能解释当前状态和下一步。

这些均是产品设计推论，不是要求重写已实现的适配器。官方功能存在不证明 CoderFleet 已集成，更不证明正确率、持续可用或无需人参与。

## 可核验证据表

| 主题 | 官方文档确认的能力或限制 | 日期、版本与适用边界 |
|---|---|---|
| [SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) | SDK 运行 Claude Code binary；集成方运营进程；含工具、会话、hooks、MCP 等。 | 滚动文档；模型能力、SDK 内核和托管服务不可混称。 |
| [Sessions](https://code.claude.com/docs/en/agent-sdk/sessions) | resume 指定会话；continue 选最近会话；fork 复制历史；历史不包含文件系统快照。 | 多会话产品需追踪准确 ID；跨 host 还涉及 cwd 和存储。 |
| [External SessionStore](https://code.claude.com/docs/en/agent-sdk/session-storage) | 外部镜像支持跨 host resume；append 最多尝试三次，失败发 mirror_error 后丢批次；需按 uuid 去重。 | 页面未统一给出最低 SDK 版本；不据此宣称 0.2.180 支持。镜像与 file checkpointing 不能组合。 |
| [Streaming](https://code.claude.com/docs/en/agent-sdk/streaming-output) | partial stream 与完整消息同时存在；子 agent token 增量不转发，完整消息有归属信息。 | 逐事件渲染与重放策略由产品实现；需固定版本录制验收。 |
| [Permissions](https://code.claude.com/docs/en/agent-sdk/permissions) | deny、ask、模式、allow 共同参与；不是单一 allowlist。 | 最新文档的细节不能替代固定 CLI 权限测试。 |
| [Hooks](https://code.claude.com/docs/en/agent-sdk/hooks#block-the-action-when-a-callback-fails) | 多数事件 callback 失败默认继续；onFailure/on_failure 可阻断，Stop、SubagentStop 等有例外。 | 文档注明 TS ≥0.3.317 / Python ≥0.2.177；仍需核验 bundled CLI 支持并做故障注入。 |
| [MCP](https://code.claude.com/docs/en/agent-sdk/mcp#oauth2-authentication) | stdio、HTTP/SSE、进程内服务器；应用自办 OAuth 流程；鉴权失败后运行可继续。 | 区分服务器已配置、已连通、已授权、工具可用。 |
| [Claude subagents](https://code.claude.com/docs/en/agent-sdk/subagents) | 专门提示、工具限制、并行上下文；默认后台，报告可在后续回合到达。 | 最新行为；不能以父回合结果证明所有后台工作已交付。 |
| [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) | 支持分派、追问、等待、关闭；继承父级 sandbox/approvals，自定义指令不创建只读沙箱。 | 本地 Codex 与 ChatGPT Work 的执行环境不同。 |
| [Codex worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees) / [delegation](https://learn.chatgpt.com/docs/prompting#cloud-delegation-ide--cloud) | 并行聊天可独立 checkout；云委派后审 diff、迭代、建 PR 或拉回本地验证。 | worktree 是 Git 工作区隔离；不能代替权限 sandbox。 |
| [Codex approvals](https://learn.chatgpt.com/docs/agent-approvals-security) / [Auto-review](https://learn.chatgpt.com/docs/sandboxing/auto-review) | sandbox 控制技术能力，approvals 决定何时审批；自动 reviewer 只审需要审批的动作。 | 可出错；API/自建 harness 不自动等于官方产品机制。 |
| [Codex scheduled tasks](https://learn.chatgpt.com/docs/automations) | 可后台定时运行并选本地目录/worktree；项目任务要求机器和桌面端在线；使用默认 sandbox。 | 取决于平台、组织设置；先手动验证 prompt，再检查前几次产物。 |
| [Copilot current cloud](https://docs.github.com/en/copilot/concepts/copilot-surfaces/copilot-on-github) | 区分 client、session、environment；支持研究→修改→审阅→PR；日志不能替代审阅测试。 | 官方标明新体验自 **2026-10-28** 提供；Actions 与 cloud sandbox 的范围/续接能力有差别。 |
| [Copilot cloud-agent risks](https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings/risks-and-mitigations) | 文档所述 cloud agent 受分支/检查约束，草稿 PR 需人审阅合并；保留 session 与审计记录。 | 针对该页所述工作模式；不把旧 cloud agent 限制泛化到所有新 cloud sandbox。 |
| [GitHub Agentic Workflows](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/about-github-agentic-workflows) | Markdown 定义任务，frontmatter 声明触发/权限/输出；默认只读，写操作走 safe outputs。 | 属于 GitHub Actions 产品机制；不是模型天然能力。 |
| [Codex review rules](https://developers.openai.com/blog/custom-code-review-rules-for-codex) | AI review 是附加审阅；测试、分支保护和 required approvals 继续强制执行。 | 不能据此宣称自动 review 达到确定正确或可免验收。 |
| [Anthropic legal](https://code.claude.com/docs/en/legal-and-compliance) / [authentication](https://code.claude.com/docs/en/authentication) / [SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) | 区分普通个人使用、用户自行登录原版 CLI、第三方应用提供登录/代用户使用订阅凭据；各有条件。 | 此处整理官方陈述，不对既有 CoderFleet 使用作法律判定；对外形态存在疑义时按实际方案确认。 |

验证边界：未安装依赖、运行推理、登录账户、访问用户会话或测试恢复/审批/外部写入；未验证官方产品在用户账户上的可用性和质量。
