# SDK 能力补齐与验收记录 · 2026-11-12

本次实现按已批准的全部缺口推进，固定 SDK 0.2.180 / CLI 2.1.321。Task 仍是执行原子，配置快照、账号、cwd、认证和代理沿用原边界；主服务不导入 SDK 或项目扩展。操作方法见 [使用说明](../claude-agent-sdk.md)，范围见 [能力对照](claude-agent-sdk-capability-coverage-20261111.md)。

## 已接入

- 通用工具与计划批准、拒绝、修改输入、超时/中断/结束关闭，以及持久 token/回执重试。
- 文本/thinking 增量输出、完整块和 result 去重、结构化输出、后台 ID 与 Hook/镜像错误提示。私有 transcript_mirror 帧交给 SDK 存储，不作为聊天输出。
- 运行中模型/权限、MCP 状态/重连/启停、初始化信息、精确上下文和原生后台任务停止。
- Task 参数快照与 Conversation 继承，API/CLI/桌面/移动 JSON 配置：预算、thinking/effort/fallback、tools、AgentDefinition、Skills、插件、settings、sandbox 等。
- worker 内项目工厂：Python Hooks、SDK 进程内工具和自定义 SessionStore；内置 SQLite 镜像采用跨进程事务、UUID 去重与不透明 JSON 保留。
- 原生会话查询、子 Agent 消息、标题/标签、分叉/续聊、归档后的删除、存储导入。元数据修改使用持久 workspace lease，明确未知结果不重放；本地与镜像协调更新，不能确认主/子记录删除时拒绝成功回执。
- 原生上传附件输入与可选运行中插话；旧初始附件路径继续按原文件引用行为处理。
- 文件检查点 UUID 与独立恢复 Task：来源检查、空输入恢复、原工作区复用、同请求幂等、并发排除和禁止自动重放。

## 验证

1. 全量回归已通过 **938 项，6 条既有警告**（最后发布复核结果以本次 release 日志为准）；SDK worker、配置与 mailbox 三个核心模块 strict mypy 通过。Host 五模块与起点代码及用户改动比较，均为既有 27 条类型基线，新增 0 条。
2. Task/API/FakeRuntime 与真实固定 SDK + 受控 CLI 覆盖配置快照、存储并发/互操作、动态权限、计划审批、回执、local 分叉、代理参数、文件恢复和附件。前端实际调用及组件回归 **43 项通过**。
3. 新隔离容器经已有 relay/代理，使用已授权账号的只读凭据挂载，完成 **4 个真实 SDK Task**：
   - 自定义 SDK MCP 工具、Python Hook、工具批准及修改参数、增量输出、原生图片和 JSON Schema 结果；确认模型/权限/MCP 状态/server info/context 控制回执。
   - SQLite 镜像的原生标题/标签/查询/导入及分叉，随后在分叉 Conversation 中恢复并答复。
   - Write 修改文件，原生提问等待期间补充图片，最终返回 `INLINE_IMAGE_OK red`。
   - 通过独立恢复 Task 将文件恢复为原始内容，同一恢复请求返回同一 Task。
4. 实际 Chrome 隔离组件页完成桌面控制回执/参数编辑、移动审批、原生会话和检查点面板验证；390px 视口的文档宽度为 390px，无横向溢出。测试页使用实际组件及合成 API，不是生产整页 E2E。
5. 仓库 4 项 guard 与 diff check 通过。真实验收前后的 6 个生产容器 ID、PID、启动时间一致；只删除本次创建的测试容器。

工作证据保存在 `.scratch/sdk-capabilities-20261112/`：`full-suite-release.log`、最终发布复核日志、`core-types-final.log`、`host-type-comparison.json`、两轴审查报告，以及 `real-e23ef89d/ACCEPTED.json` 和 before/after 快照。该目录含运行细节，不作为安装包发布。

## 审查中修正的问题

Standards 轴的 system_prompt 无效对象静默忽略、重复控制注册表已修正。Spec 轴的动态权限仍受初始 auto 限制、remote Store helper 禁网、local 分叉误建临时工作区、镜像删除遗漏本地/子记录、合法完整 Agent 模型 ID 被拒绝、helper 清理前释放排他状态，均有修正或回归。追加检查修正了权限回执与新问题交错、dontAsk 被误当成 bypass、未知运行设置阻塞下一 Task、local 子目录上传根，以及恢复成功后关闭时限不足误判失败。

初次全量中的 6 个失败分别来自旧初始附件路径兼容（5 项）和 DOM 夹具没有模拟 appendChild 移动已有节点（1 项）；没有删除原有断言来掩盖失败。修正后全量通过。

## 边界和发布

SDK 不允许 SessionStore 与文件检查点同时启用；回滚不恢复对话历史，不保证 Bash、子 Agent 或外部副作用。原生分叉限定普通项目工作区；临时工作区明确拒绝。自定义 Store 的删除需要可确认级联删除，provider 只有 append/load 时不假报删除成功。

真实验收未覆盖第三方远程 Store 服务、长时间真实后台 Agent、各 OS sandbox 或每种模型/参数组合。已有 local/临时执行和恢复承诺继续以对应生命周期测试为界，不能从配置字段存在推断真实平台安全验收。

前后端安装包从当前工作树重新构建，保留既有用户本地改动；提交仅包含本轮改动，已通过补丁反向/回放逐文件校验证明隔离。安装前重新检查本机运行中的 Task，只在主服务空闲时替换和重启；当前活动任务的运行环境、工作容器与会话不因构建或提交改变。安装状态和最终提交 SHA 记录在本轮交付说明中。
