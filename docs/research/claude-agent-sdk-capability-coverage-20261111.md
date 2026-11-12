# Claude Agent SDK 能力覆盖对照

初始调研日期为 2026-11-11；本表于 2026-11-12 按已批准的全部缺口更新。固定 Python SDK **0.2.180** / CLI **2.1.321**，保留 Task、Conversation、账号与运行位置边界。下表说明产品入口和证据，不以一个覆盖率百分比代替验收。

| 能力 | 当前接入 | 验证边界 |
|---|---|---|
| Task、resume、分叉、interrupt、原生提问 | 保留并回归 | 既有 Task/Runtime/FakeRuntime、真实 SDK 协议和历史容器证据 |
| 工具/计划批准 | worker→持久 pending→API/CLI→桌面/移动卡片 | 真实工具批准及修改输入；离线拒绝、超时、重试、动态权限回归 |
| 权限模式、运行中模型切换 | 六种权限模式，typed control，local 原有门禁 | 真实运行中切模型/权限；bypass→manual 的工具/计划/问题回调回归 |
| 增量文本/thinking | partial events 就绪即显示，完成块与 result 去重 | 真实流式事件；DOM 部分/完整/多块去重，结束收尾 |
| 原生附件输入 | 已上传 PNG/JPEG/WebP/GIF/PDF 转 SDK blocks；插话显式勾选 | 真实初始图片识别和运行中图片插话；旧 Task 路径引用兼容 |
| MCP 管理、初始化、上下文 | 状态、重连、启停、server info、context usage | 真实状态/info/context；全部方法由固定 SDK 受控 CLI 验证 |
| SDK 后台任务 | stop_task 接受原生后台 ID，事件中显示 ID | 固定 SDK 协议验收；不混用 CoderFleet Task ID |
| Skills、插件、settings、sandbox | 验证的 Task 配置快照与 UI/CLI JSON 入口 | 配置边界/SDK 组装；不是各 OS sandbox 的独立安全认证 |
| AgentDefinition | JSON 定义转固定 SDK dataclass，支持完整模型 ID、forward_subagent_text | 字段/快照/协议验证；普通项目及 local 会话回归 |
| Python Hooks、自定义进程内工具 | 显式项目工厂，仅 worker 执行 | 真实 Hook、SDK MCP 工具、审批修改参数与工具结果 |
| 结构化输出 | output_format + renderer JSON 输出 | 真实模型按 schema 返回，结果保留在原始日志 |
| 预算、thinking、effort、fallback | 轮数/费用/token/推理和模型选项 | 边界/参数快照；真实模型预算及结构化运行，不承诺每种模型组合 |
| 文件检查点与恢复 | 保存 user UUID；live 控制及独立恢复 Task，复用原工作区 | 真实文件改写后恢复原内容；请求幂等、并发与来源检查 |
| 原生会话管理 | 按账号/工作区绑定的 list/info/messages/subagent/rename/tag/fork/delete/import | 真实本地+SQLite 元数据及分叉续聊；受限存储的删除明确拒绝 |
| 外部会话存储 | SQLite durable adapter、工厂自定义 SessionStore、flush/load 选项 | 真实 SDK 镜像及恢复；并发/UUID/未知字段、SDK metadata/store 互操作 |
| 前端交互 | 共享发送按钮、运行设置、参数编辑和日志内会话面板 | 实际页面调用的 Node 回归；Chrome 桌面/390px 审批与面板交互 |

配置和运行操作通过 `/api/sdk/capabilities` 的同源 schema 暴露，CLI 具有对应入口。配置快照可读、可写、可继承；空参数继承会话，显式 `{}` 重置。运行中的修改仅针对当前 SDK Task。回执未知时保留原 ID/内容，不重放副作用。

## 固定版本与产品边界

- SDK 0.2.180 拒绝同时配置 SessionStore 和 file checkpointing；不能把 fork 当作文件恢复，也不能声称恢复 Bash、子 Agent 或外部副作用。
- 身份、cwd、认证、代理及会话归属由现有 Task/Runtime 管理，未开放任意 CLI 路径、环境/extra_args 来覆盖它们。
- 原生分叉与已有受管分叉一样限定普通项目；真正的临时工作区明确拒绝，普通 local 项目仍保留原工作区。
- 原生记录删除要求归档引用与明确 session ID；配置 Store 时要求可确认主记录及子 Agent 的删除。仅 append/load 的 provider 可以运行/恢复，不能假报删除成功。
- 元数据修改的持久 lease 跨服务重启保留，直到回执/完成标记证明结束；结果未知不自动重放。
- 真实验收使用新隔离容器、用户已授权账号的只读凭据挂载、现有 relay/代理。未专项调用第三方远程 Store 服务、长时间真实后台 Agent 或各 OS sandbox；这些不因配置字段接入而自动算通过。

操作方法见 [SDK 使用说明](../claude-agent-sdk.md)。实现与最终验收记录见 [2026-11-12 验收报告](claude-sdk-capability-acceptance-20261112.md)。

## 官方依据

以下接口存在性同时核对了固定版本源码；当前官方参考可能随时间更新。

- [固定 0.2.180 的客户端源码](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.180/src/claude_agent_sdk/client.py)：set_model、set_permission_mode、rewind_files、MCP 控制、上下文查询、stop_task 等公共方法。
- [固定 0.2.180 的类型定义](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.180/src/claude_agent_sdk/types.py)：ClaudeAgentOptions、AgentDefinition、Hooks、预算、thinking、结构化输出、sandbox、SessionStore 等选项和类型。
- [Python SDK 官方参考](https://code.claude.com/docs/en/agent-sdk/python)：客户端方法、配置、工具和消息类型。
- [权限及用户输入](https://code.claude.com/docs/en/agent-sdk/user-input)：工具授权和 AskUserQuestion 的区别。
- [文件检查点](https://code.claude.com/docs/en/agent-sdk/file-checkpointing)：enable_file_checkpointing 与 rewind_files。

适配层还依赖固定版本的少量内部接口；升级 SDK 后需要重新验证，不能假设升级即自动获得产品层的新能力。
