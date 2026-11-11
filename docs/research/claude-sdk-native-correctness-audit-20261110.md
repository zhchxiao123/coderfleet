# Claude SDK 原生交互逻辑审查与修复（2026-11-10）

范围：原生交互提交 330688b，以及 d79c121、8b49d20 的界面修复；审查从实际桌面/移动端调用方，经 API、Scheduler、Runtime、持久 mailbox 到固定版 SDK worker。Task 仍是执行原子，Conversation 仍串行执行 Tasks。保留现有工作区修改。

## Standards：执行边界与状态一致性

| 问题 | 原因/后果 | 修复和回归 |
|---|---|---|
| local/临时执行丢失或重放控制事件 | 用 session-ID 扫描缓冲解析控制事件；捕获 session 后缓冲冻结 | 独立完整行缓冲；实际 Scheduler.submit + FakeRuntime 分块就绪事件、关闭后继续读，覆盖两种运行位置 |
| 已接受的原生答案重试报 404 | pending 被清理后错误回退到旧 MCP Future | 先检查不可变答案投递，问题/Task 结束后同内容重试返回原回执，改内容拒绝 |
| 明确拒绝的答案不能纠正 | 固定答案请求 ID 永久占用 | API 验证字符串/字符串列表；仅明确拒绝且同问题仍等待时推进新尝试 ID，未知/已接受不重放 |
| 临时容器清理绕过 Runtime | 在异步任务内直接同步运行 docker rm；FakeRuntime 用例也会触碰真实 daemon | await runtime.remove；保留临时容器路径增加真实 seam 调用断言 |

下一问题已出现时重试旧答案也已单独探测：接受/未知/拒绝三种旧回执均不清除新问题，不额外发送。worker 能力令牌不出现在 TaskResponse；同 ID 不同内容拒绝、Task 结束后未知投递不自动重放、原生中断取消等待问题的既有边界保留。

## Spec：用户行为与页面调用链

| 问题 | 修复后的约定 | 验证方式 |
|---|---|---|
| 一直“连接中”，刷新才有中断 | SSE 跟随期间持续心跳；就绪后原地启用按钮 | 加载真实 state.js/chat.js/app.js，驱动真实 5 秒回调，验证 connecting→interrupt |
| pending→running 未打开日志；延迟刷新重建另一会话 | 启动刷新携带原 Conversation ID；就绪变化不重建编辑器/问题卡片 | 延迟请求 + 导航回归，检查正确刷新次数 |
| 全量请求失败抹掉运行 Task | 失败保留心跳确认的缓存，不把当前补充消息变成新 Task | 真实 poll→full fetch 失败→输入回归 |
| 桌面旧 Task 兜底、移动端新会话旧按钮 | 查找和派发均校验归属；显示会话刷新按钮，新会话重置排队选择 | 捕获旧中断回调、延迟 selectConversation、移动端 startNew 实际调用 |
| 排队/定时绕过未知投递 | 先查询未知回执，避免复制已送达文字 | 两种 checkbox 分别验证无 POST /api/tasks |
| 同会话刷新丢附件 | 刷新保留附件并恢复预览，跨会话清理 | 调用完整 renderChatWorkspace/selectConversation；防止“带附件排队”变成纯文字插话 |
| 有选项时不能自由回答 | “其他”输入与选项共存；单选字符串、多选列表 | 真实 renderer 输出/收集/POST body 回归 |
| 问题关闭后仍可编辑；迟到错误覆盖已回答 | 关闭全部输入与提交控件；权威流状态优先 | SSE close 与 HTTP error 交错、Task end 回归 |
| 答案结果未知不能恢复提交 | 保留 token 和不可变答案 body，同内容重试不依赖 pending 再查询 | 首次响应丢失、pending 清空、再次 POST；未知时改答案拒绝，明确拒绝后可纠正 |

主按钮规则：纯文字 + 已就绪 SDK Task 为补充消息；空输入为原生 interrupt；显式排队/定时/附件为后续 Task；上传/初始化时禁用；队列满不影响纯文字补充。未知投递检查优先于创建后续 Task。普通 CLI 强制终止保持原路径。

## 验证证据

- 前端真实调用方/渲染器/回执专项：36 项通过。证据 `.scratch/native-logic-audit-20261110/frontend-green.log`。
- Task/API、分块事件、原生答案回执与 Runtime 清理专项：12 项通过；UI/API 组合检查上一轮 88 项通过。证据 `focused-final.log` 和执行输出。
- 真实固定版 SDK + 受控 CLI 的原生交互：9 项通过，涵盖插话同 ID 重试、当前轮消费、中断、原生答案、超时、auto 不等待人。它不调用模型，不代表真实模型验收。
- 环境恢复后的完整最终套件：**902 项全部通过，无跳过**，耗时 189.15 秒；明确启用固定版 SDK 与隔离容器测试。6 条既有弃用/事件循环清理警告不影响结果。日志 full-suite-recovered.log。早期无容器环境的全量为 866 通过、35 跳过、1 项观测超时；独立复查及恢复后完整重跑均通过，早期日志保留。
- 四项仓库 guard 通过。

## 环境恢复后的补充验收

首轮 Docker/OrbStack 的 inspect 及 socket 健康检查持续超时，部分 local 进程检查也超时。恢复后重跑，隔离容器和 local 的真实 SDK + 受控 CLI 生命周期验收 **16 项通过**（61.92 秒），包括持续容器跟随/恢复、临时释放/保留/TTL、local resume/fork、停止与崩溃清理；未以超时期间的业务 result 冒充 Task 已结束。

真实模型使用授权账号、新会话和新隔离容器，凭据只读挂载，走现有 container→relay→宿主代理，不使用 standalone sleep。四个 Task 验收通过：

1. 原生 AskUserQuestion 等待期间取消宿主 watcher 并重新接管，回答后得到 NATIVE_QUESTION_OK Alpha。
2. 另一原生问题等待时调用 SDK interrupt，Task 为 killed 且 interrupted=true，保留原生 session。
3. 同 Conversation 恢复后得到 RESUME_AFTER_INTERRUPT_OK，session 与中断前一致。
4. 等待原生问题期间补充消息，同 ID 重试只接收一次；自定义答案提交后得到 SUPPLEMENT_INPUT_OK；Task 结束后重试原答案返回原回执。

测试容器已经清理。前后快照证明 5 个既有工作容器及 relay 的 ID、PID、启动时间完全一致。证据 real-acceptance-recovered.log、real-40bdad66/results.json、before.json、after.json。未挂载生产项目或创建业务通知。

既有模板目标解析测试已改为不启动真实 watcher，保留目标映射断言。早期核心全量与环境恢复后明确启用 SDK/容器的完整重跑分开记账；最终完整套件 902 项通过，没有把跳过算作通过。浏览器实点未在本次执行，前端证据来自真实页面脚本调用链。

## 本机交付

已从最终源码重建 wheel，覆盖更新前后端并重启空闲主服务；安装前无 running/pending Task，未重启或重建工作容器。103 个安装文件逐字节匹配 wheel；直连本机 HTTP 的 app/chat/SDK 控制/renderer 脚本匹配源码，桌面及移动 HTML 使用新缓存版本，OpenAPI 的答案值类型已核对。FastAPI 0.115.0、Starlette 0.38.6、MCP 1.12.4、Pydantic 2.9.2 保持不变。

安装脚本最初的健康探测受代理环境影响报连接拒绝；已改用显式不经过代理的 loopback 请求核验 /api/health、/api/tasks/heartbeat 和页面入口均为 200。安装本身成功，证据 deployment-verified.json。页面需刷新一次以加载新版资源，后续 Task 就绪自动更新。
