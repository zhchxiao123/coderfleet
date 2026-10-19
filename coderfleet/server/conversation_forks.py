"""Claude turn checkpoints and immutable fork provenance; never writes transcripts."""
from __future__ import annotations

import json
from pathlib import Path
from uuid import UUID

from coderfleet.server.models import AccountType, Conversation, ConversationMode, Task, TaskStatus


def completed_turn_checkpoint(task: Task, log_path: Path) -> str:
    if task.type != AccountType.claude or task.status != TaskStatus.done:
        raise ValueError("仅支持已完成的 Claude 轮次分叉")
    if not task.native_session_id or not log_path.is_file():
        raise ValueError("任务缺少原生会话或日志，无法分叉")
    last_assistant = None
    successful = False
    with log_path.open(encoding="utf-8") as stream:
        for line in stream:
            try:
                event = json.loads(line)
            except (ValueError, TypeError):
                continue
            if not isinstance(event, dict) or event.get("parent_tool_use_id"):
                continue
            if event.get("session_id") != task.native_session_id:
                continue
            if event.get("type") == "assistant":
                last_assistant = event
            elif event.get("type") == "result":
                successful = event.get("subtype") == "success" and not event.get("is_error")
    if not successful or not last_assistant:
        raise ValueError("日志没有完整的成功轮次，无法定位分叉点")
    message = last_assistant.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, list) or not all(isinstance(block, dict) for block in content):
        raise ValueError("日志中的回复结构不完整，无法定位分叉点")
    if any(block.get("type") == "tool_use" for block in content):
        raise ValueError("不能在尚未闭合的工具调用处分叉")
    checkpoint = last_assistant.get("uuid", "")
    try:
        UUID(checkpoint)
    except (ValueError, TypeError, AttributeError) as err:
        raise ValueError("旧日志缺少有效的消息 UUID，无法分叉") from err
    return checkpoint


def validate_source(conversation: Conversation, task: Task) -> None:
    if conversation.type != AccountType.claude or conversation.mode != ConversationMode.chat:
        raise ValueError("仅支持 Claude 聊天会话分叉")
    if conversation.ephemeral:
        raise ValueError("临时工作区暂不支持分叉，请使用持久项目")
    if (task.conversation_id != conversation.id or task.account != conversation.account
            or task.project != conversation.project):
        raise ValueError("分叉任务不属于该会话、账号或项目")
