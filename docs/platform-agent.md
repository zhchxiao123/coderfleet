# 平台助手

平台助手由 CoderFleet 的检索与权限服务、隔离容器中的 Claude Agent SDK、显式选中的外部 MCP 组成。SDK 根据当前消息决定读取哪些聊天、Task 或历史回复，再整理答案或执行用户指定的 MCP 操作。普通对话不预先扫描全部日志，不把整段问答历史拼进提示词。

## 使用

左侧保存会话，中间问答，底部一个输入框。Enter 发送、Shift+Enter 换行；中文输入法确认不会误发。运行期间发送按钮可停止当前 Task；草稿和未确认提交会保留。

在“更多 → 助手设置”选择执行账号和接入 MCP。当前支持账号 `settings.json`、`.claude.json` 及其 `/workspace` 配置中的 HTTP/SSE 服务；宿主 stdio 命令不能直接在隔离容器使用。界面只显示名称与类型，不暴露地址、请求头或 OAuth。连接凭据沿用该账号认证目录；不会导入其他账号或宿主配置。未选中的外部服务不接入。

例如：先问“查找某项目关于代理问题的聊天，整理完成事项和遗留问题”；收到总结后，再说“把上一条总结保存到忆屿的某分类，我确认保存”。助手按需读取上一条回答，调用忆屿并返回工具实际给出的记录标识。目标或内容不明确时会先询问；若服务将内容放入收件箱，应按回执说明仍需收下，不能宣称已成为正式记录。

执行详情列出调用过的 MCP 工具及完成/失败状态，来源可展开阅读。普通查询显示按需读取的数量，不把局部检索宣称为全量覆盖。模型文本仍需结合来源和真实工具回执判断。

## CoderFleet MCP

宿主 `/platform-mcp/` 提供只读工具，服务名 `fleet`：

| 工具 | 用途 |
| --- | --- |
| `catalog` | 日期、截止时间、项目范围和任务数；不读取日志 |
| `list_tasks` / `get_task` | 按项目、问题预览定位 Task 和 Conversation |
| `search_chats` | 搜索授权范围内实际公开问答 |
| `read_task` / `read_chat` | 分页读取选中的 Task 或聊天公开内容 |
| `read_reply` | 按需分段读取同一平台会话的祖先回复 |

创建查询时只建立轻量任务目录。第一次读取某个 Task 才解析其日志，保留该轮读取缓存和来源回执。正文按 UTF-8 字节限制分页，长文本继续读取，不静默截断。来源必须属于本轮工具实际返回的片段；历史平台回复本身作为独立来源，不伪称重新读取了它的全部底层聊天。纯操作结果或澄清允许空来源。

每个运行有独立随机凭证，绑定 `Task.platform_run_id`、项目/日期和截止时间。工具与协议入口均检查凭证和运行状态；Task 结束后失效。操作者 API Key 不进入容器。不能通过 Task ID、Conversation ID 或回复 ID 越过授权范围。平台活动仍只读，当前未开放创建/修改平台任务等操作。

只纳入平台记录的公开问题、回复、插话、人工作答与权限决定；不暴露思考、任意工具原始结果、附件或环境变量。复用活动解析器的脱敏与时区/跨日规则。没有事件时间的旧日志会标为估计或缺口；未登记的终端操作不在范围内。自由文本脱敏不能保证识别所有敏感信息。

## 会话和执行

每次人工发送仍是一个普通 SDK Task。初始输入只有当前消息、范围和历史回复指针，完整历史通过 MCP 分段获取。这一阶段不声称使用 SDK 原生 resume；SDK 的执行循环负责工具选择，CoderFleet 保存可检索的持久会话。最多32轮；读取单页或工具结果仍有显式大小限制。

对话沿用初始目录和截止时间，获取新资料时新建对话。查询容器只挂载私有工作目录及执行账号认证；不挂载业务项目、原始聊天库或 Docker socket。SDK 禁用内置工具、项目设置/扩展、插件及未选择的 MCP。真实 MCP OAuth 由该账号 CLI 凭据处理。

请求身份持久化：原 request-id 和相同参数重试只查询同一运行，不再次调用模型。结果不确定时不自动重放写入。写入工具支持幂等时使用本轮稳定标识；具体写入确认和收件箱语义由外部 MCP 约束。服务重启不能接管的执行会明确失败，不自动重放。完成回答、来源和回执不依赖普通 Task 日志永久保留。

## 日报兼容

“生成日报”仍保留原有完整活动快照和覆盖检查，沿用本地只读分页工具；自动日报不接入外部 MCP，不执行保存操作。普通查询走新的宿主检索服务。跨日 Task 费用是累计值，不能当作精确日账单。未读完、缺日志或达到预算时明确表示部分覆盖或失败。

## CLI

```bash
coderfleet platform status
coderfleet platform configure --account YOUR_ACCOUNT --timezone America/Los_Angeles --mcp-server reminis
coderfleet platform configure --clear-mcp
coderfleet platform run 2026-11-13 --question '检索某项目的聊天并总结进展' --request-id query-v1
coderfleet platform run 2026-11-13 --after RUN_ID --question '保存上一条总结到忆屿的工作分类，我确认保存' --request-id save-v1
coderfleet platform thread RUN_ID
coderfleet platform get RUN_ID
coderfleet platform source RUN_ID SOURCE_ID
coderfleet platform logs RUN_ID
coderfleet platform cancel RUN_ID
```

Web 与 CLI 共用相同身份、连接设置和执行链路。自动日报仍由 `DIGEST_ENABLED` 控制，默认关闭；保存设置不启用自动执行。
