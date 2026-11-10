"""SDK fork API boundaries for account isolation and historical time precision."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi import HTTPException

from coderfleet.server import main as server_main
from coderfleet.server.models import AccountType, Conversation, Task, TaskStatus
from coderfleet.server.runtime import FakeRuntime
from coderfleet.server.scheduler import Scheduler


def seed_source(scheduler: Scheduler, project: Path) -> tuple[Conversation, Task, str]:
    session, checkpoint = str(uuid4()), str(uuid4())
    conversation = Conversation(id="source", name="Source", account="one", type=AccountType.claude,
                                project=str(project), project_name="repo", native_session_id=session)
    conversation.save(scheduler.conversations_dir)
    task = Task(id="z-earlier", status=TaskStatus.done, account="one", type=AccountType.claude,
                execution_backend="sdk", project=str(project), project_name="repo", prompt="earlier",
                conversation_id=conversation.id, native_session_id=session,
                created="2026-11-09T00:00:00+00:00", finished="2026-11-09T00:00:05+00:00")
    task.save(scheduler.tasks_dir)
    events = [
        {"type": "assistant", "session_id": session, "uuid": checkpoint,
         "message": {"content": [{"type": "text", "text": "earlier answer"}]}},
        {"type": "result", "session_id": session, "subtype": "success", "is_error": False},
    ]
    scheduler.get_log_path(task.id).write_text("\n".join(json.dumps(event) for event in events) + "\n")
    return conversation, task, checkpoint


@pytest.mark.parametrize("has_account_transcript", [True, False])
def test_local_fork_api_uses_only_the_account_transcript_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, has_account_transcript: bool,
) -> None:
    scheduler = Scheduler(tmp_path, runtime=FakeRuntime())
    (tmp_path / "accounts.conf").write_text("NAME=one TYPE=claude RUNTIME=local PROXY=off CLAUDE_BACKEND=sdk\n")
    repo = tmp_path / "repo"
    repo.mkdir()
    (tmp_path / "projects.conf").write_text(f"NAME=repo ACCOUNT=one PATH={repo}\n")
    source, task, checkpoint = seed_source(scheduler, repo)
    account_root = tmp_path / "accounts/one/.claude"
    global_root = tmp_path / "global-claude"
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(global_root))
    global_transcript = global_root / "projects/-repo" / f"{source.native_session_id}.jsonl"
    global_transcript.parent.mkdir(parents=True)
    global_transcript.write_text(json.dumps({"uuid": str(uuid4()) if has_account_transcript else checkpoint}) + "\n")
    if has_account_transcript:
        transcript = account_root / "projects/-repo" / f"{source.native_session_id}.jsonl"
        transcript.parent.mkdir(parents=True)
        transcript.write_text(json.dumps({"uuid": checkpoint, "sessionId": source.native_session_id}) + "\n")
    monkeypatch.setattr(server_main, "scheduler", scheduler)

    if has_account_transcript:
        child = asyncio.run(server_main.fork_conversation(source.id, server_main.ConversationForkRequest(task_id=task.id)))
        assert child.fork.source_session_id == source.native_session_id
        assert child.fork.message_uuid == checkpoint
    else:
        with pytest.raises(HTTPException) as error:
            asyncio.run(server_main.fork_conversation(source.id, server_main.ConversationForkRequest(task_id=task.id)))
        assert error.value.status_code == 400
        assert "原生会话记录不存在" in error.value.detail
        assert len(scheduler.list_conversations()) == 1


def test_legacy_same_second_completion_forks_do_not_inherit_a_later_turn(tmp_path: Path) -> None:
    scheduler = Scheduler(tmp_path, runtime=FakeRuntime())
    (tmp_path / "accounts.conf").write_text("NAME=one TYPE=claude CLAUDE_BACKEND=sdk\n")
    repo = tmp_path / "repo"
    repo.mkdir()
    source, earlier, checkpoint = seed_source(scheduler, repo)
    later = earlier.model_copy(update={"id": "a-later", "prompt": "later", "created": "2026-11-09T00:00:01+00:00"})
    later.save(scheduler.tasks_dir)
    transcript = tmp_path / "accounts/one/projects/-repo" / f"{source.native_session_id}.jsonl"
    transcript.parent.mkdir(parents=True)
    transcript.write_text(json.dumps({"uuid": checkpoint}) + "\n")
    child = scheduler.fork_conversation(source.id, earlier.id)
    assert child.fork.inherited_task_ids == [earlier.id]
