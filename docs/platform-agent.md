# 平台助手

平台助手是 CoderFleet 的内置只读 harness。它把跨项目工作日报和按日查询变成普通的 SDK Task，在新的临时容器中执行；业务项目的工作目录不挂载进去。Web 左侧「平台助手」与 `coderfleet platform` 使用同一 API。

## 使用

在「助手设置」中选择容器模式的 Claude SDK 账号、模型、费用上限和 SDK 已安装的镜像；日期旁可以输入 IANA 时区。先点击「预览范围」，不选择项目表示所有项目。问题留空时生成日报，填写问题则查询所选日期的记录。历史报告保留在下方，支持来源查看、执行日志和取消生成。旧版日报与统计保留在折叠区域。

```bash
coderfleet platform configure --account YOUR_ACCOUNT --timezone America/Los_Angeles --model sonnet
coderfleet platform status
coderfleet platform preview 2026-11-12
coderfleet platform run 2026-11-12 --request-id daily-20261112-v1
coderfleet platform run 2026-11-12 --project my-project --question '还有哪些未完成事项？' --request-id query-20261112-v1
coderfleet platform list --date 2026-11-12
coderfleet platform get RUN_ID
coderfleet platform get daily-20261112-v1 --request-id
coderfleet platform source RUN_ID SOURCE_ID
coderfleet platform logs RUN_ID
coderfleet platform cancel RUN_ID
```

提交连接断开时，沿用**原 request-id 和完全相同的参数**查询或重试；同 ID 不会再次调用模型，变更参数会被拒绝。Web 会在本机保存未确认的请求，刷新后可继续原提交。重新生成需要新的 request-id，形成独立版本，不覆盖旧报告。`coderfleet digest DATE --generate` 也转向新的平台助手；普通 `digest DATE` 继续读取旧版统计和历史摘要。

## 资料和来源

数据范围是平台已记录的 Task，包括初始问题、公开回复、已接受的插话、模型提问、人工答案和权限决定。有结构化事件的其他供应商沿用各自公开输出分类器；无法区分公开回复的纯文本日志不读取原文，明确标为覆盖缺口。不会把思考过程、任意工具原始输出、附件或环境变量直接交给汇总模型。常见令牌格式和已知平台配置密钥会被遮盖；自由文本仍是所选账号模型的输入，脱敏不是对所有可能敏感内容的识别保证。

日期按选定时区的半开区间计算，包括夏令时。跨日任务的原始问题作为背景，具有事件时间的当日追加内容归入当日；旧日志缺少事件时间时使用明确标记的估计时间，已在截止前结束的跨日记录中，无法精确归日内容只作为背景；无法确认发生于截止前的内容会排除并提示覆盖缺口。未登记为 Task 的交互终端操作不在覆盖范围。统计中的 token/费用是 Task 累计值，不能当成精确当日账单。

每次生成冻结 `snapshot.json`，保存截止时间、指纹、来源 ID、Task/Conversation/日志行号及覆盖提醒。只读 MCP 工具为 `manifest`、`read_activities`、`get_activity`，模型不能扩大项目或日期范围。长活动按完整片段分页，没有旧版每项目 12 个任务的截断。模型报告的引用必须属于工具实际返回的来源。

工具读取回执记录已返回多少活动；这证明资料提供情况，不证明模型逐字理解或每条结论都正确。日报未读取所有活动或存在缺失日志等提醒时标为「部分覆盖」。查询允许只检索相关活动，依然展示读取数。预算、上下文或轮数不足可能导致部分覆盖或失败；32 MiB 快照上限会明确拒绝并提示缩小项目范围，不静默丢弃。历史摘要没有新快照的来源保证。

## 执行与恢复

管理、数据选择、状态和报告存放于 CoderFleet；SDK loop 与 MCP 工具运行在独立容器，复用执行账号的认证、relay 和代理链路。平台容器只有私有空工作目录、该账号认证目录和只读快照，不挂载业务项目或 Docker socket。SDK 禁用普通内置工具、项目/user/local 设置、项目扩展、其他 MCP、插件和子 Agent；仅开放快照读工具。普通项目 Agent 的权限保持原范围。

`platform/settings.json` 保存设置，`platform/runs/RUN_ID/` 保存请求、不可变快照、私有工作目录与校验后的结果。`Task.platform_run_id` 绑定执行记录；平台任务不会再被汇总进工作日报或混入普通聊天任务列表，原始 token/费用仍保存在其 Task 中。平台任务不发送项目完成通知，也不能走普通任务重试去执行。

完成的报告、来源和请求身份在服务重启后仍可读取。执行中的任务沿用现有临时 SDK 容器恢复规则：无法重新接管 stdout 时停止并标为失败，不自动重放模型调用；准备阶段因重启失去提交者也会明确失败。需要用户用新请求重试。首版没有多阶段断点续算或任意时间范围的知识库。

## 自动日报

默认关闭。现有设置 `DIGEST_ENABLED` 现在只控制自动生成；手动生成不需要打开它。启用前先配置平台账号、镜像和预算。到设置的时区/时间汇总当天截至该时刻的数据；在次日该时刻之前启动服务时可补前一天一次。日期与时区形成持久请求 ID，重启不重复生成同一份自动报告；失败需要显式新请求重试。更改时区形成新的范围和请求。安装不会开启此开关。
