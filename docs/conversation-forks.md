# Claude 聊天会话分叉

在桌面和手机聊天界面，已完成 Claude 轮次的最后一条回复底部提供分叉图标，与复制操作并排。桌面悬停或键盘聚焦时显示，触屏端保持可见；提示和无障碍标签为「从这里分叉」。新会话展示截至该轮的只读继承历史，后续任务独立保存。顶部「查看来源」可以跳回原会话。

命令行入口使用相同的校验与创建逻辑：

```bash
coderfleet task fork <conversation-id> --after-task <task-id> --name "方案 B"
coderfleet task run "沿方案 B 继续" --conversation <new-conversation-id>
```

HTTP 入口：

- `GET /api/conversations/{id}/fork-point/{task_id}`：检查轮次和原生 transcript，返回固定分叉点。
- `POST /api/conversations/{id}/fork`：请求体为 `{"task_id":"...","name":"..."}`，创建独立会话，不立即调用模型。
- `GET /api/conversations/{id}/inherited-tasks`：只读读取继承历史，不改变原 Task 的归属或统计。

## 状态与执行

`Conversation.fork` 保存来源会话、来源 Task、来源原生 session ID、消息 UUID、预分配的目标 session ID、继承 Task 列表和原模型。新会话的 `native_session_id` 在实际建立前为空。

首次发送消息时使用 `--resume <source> --fork-session --resume-session-at <uuid> --session-id <target>`。普通容器与 local 执行路径均使用同一份已持久化的来源信息。捕获目标 session ID 后，后续只使用 `--resume <target>`。拒绝将来源或其他 session ID 写入分支。

如果进程在 Claude 写入目标 transcript 后、平台捕获输出前退出，下次执行会检查预分配目标 ID 的 transcript 并恢复它，避免再次复制来源上下文。任务失败或取消时保留来源记录，继续沿现有任务重试和调度流程执行。

分叉点从成功结束任务日志的最后一个主会话 assistant 事件的外层 `uuid` 提取，再验证该 UUID 存在于原生 transcript。`message.id` 的 `msg_...` 不是分叉点。子 agent 事件和未闭合的工具调用不能作为轮次末尾。

## 范围

- 支持持久项目中的 Claude 聊天会话，分叉位置为已成功完成轮次的末尾。
- 支持分支再次分叉；继承历史通过固定引用展示，不复制 Task，不重复统计用量。
- 不支持终端模式、临时工作区、跨账号或跨项目分叉。
- 旧日志缺失 UUID、原生 transcript 已删除、UUID 不匹配时明确拒绝，不自动退化成从最新位置分叉。
- 分叉共享当前项目文件，不回滚代码，也不创建 worktree。
- 继承 Task 被删除时，历史接口返回明确错误。保留历史所引用的任务、日志和账号 transcript，才能完整回看。

## 验证

自动化测试：`tests/test_conversation_forks.py`。真实 CLI 验收脚本只创建新的测试会话，禁用模型工具和 hooks，不续接用户现有会话：

```bash
PYTHONPATH=. python scripts/smoke_conversation_fork.py \
  --container <running-claude-container> --model haiku --output /tmp/fork-evidence
```

脚本验证 A/B/C 三轮从 B 分叉，新分支包含 A/B 而不包含 C；再分别恢复原会话和分支，确认上下文独立。
