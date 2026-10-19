from __future__ import annotations

import asyncio
import json
from pathlib import Path
from uuid import uuid4

import pytest

from coderfleet.server.models import (
    AccountType, Conversation, ConversationResponse, Task, TaskStatus,
)
from coderfleet.server.scheduler import Scheduler
from coderfleet.server.conversation_forks import completed_turn_checkpoint


@pytest.fixture
def fork_source(tmp_path):
    (tmp_path / "accounts.conf").write_text("NAME=alice TYPE=claude\n")
    sched = Scheduler(tmp_path)
    session = str(uuid4())
    checkpoint = str(uuid4())
    conv = Conversation(id="source", name="Original", account="alice", type=AccountType.claude,
                        project="/repo", project_name="repo", native_session_id=session)
    conv.save(sched.conversations_dir)
    task = Task(id="turn-b", status=TaskStatus.done, account="alice", type=AccountType.claude,
                prompt="B", project="/repo", project_name="repo", conversation_id=conv.id,
                native_session_id=session, model="claude-opus-5-5")
    task.save(sched.tasks_dir)
    events = [
        {"type": "assistant", "session_id": session, "uuid": checkpoint,
         "message": {"id": "msg_not_a_checkpoint", "content": [{"type": "text", "text": "B"}]}},
        {"type": "assistant", "session_id": session, "uuid": str(uuid4()),
         "parent_tool_use_id": "subagent", "message": {"content": []}},
        {"type": "result", "session_id": session, "subtype": "success"},
    ]
    sched.get_log_path(task.id).write_text("\n".join(json.dumps(e) for e in events))
    transcript = tmp_path / "accounts" / "alice" / "projects" / "-repo" / f"{session}.jsonl"
    transcript.parent.mkdir(parents=True)
    transcript.write_text(json.dumps({"uuid": checkpoint, "sessionId": session}) + "\n")
    return sched, conv, task, checkpoint, transcript


def test_fork_freezes_checkpoint_without_reusing_source_session(fork_source):
    sched, source, task, checkpoint, _ = fork_source
    child = sched.fork_conversation(source.id, task.id)
    assert child.native_session_id == ""
    assert child.fork.message_uuid == checkpoint
    assert child.fork.inherited_task_ids == [task.id]
    assert child.fork.model == task.model
    assert child.fork.target_session_id != source.native_session_id
    assert ConversationResponse.from_conversation(child).fork == child.fork
    # Source advances after fork creation: the child remains frozen at B.
    source.native_session_id = str(uuid4())
    source.save(sched.conversations_dir)
    loaded = Scheduler(sched.workspace_dir).get_conversation(child.id)
    assert loaded.fork.source_session_id == task.native_session_id
    cmd = Scheduler.build_cli_command(AccountType.claude, "branch", False, "new",
                                     native_session_id=loaded.fork.source_session_id, fork=loaded.fork)
    assert "--fork-session" in cmd
    assert f"--resume-session-at {checkpoint}" in cmd
    assert f"--session-id {loaded.fork.target_session_id}" in cmd
    assert "msg_not_a_checkpoint" not in cmd


def test_fork_recovery_and_followup_do_not_fork_again(fork_source):
    sched, source, task, _, transcript = fork_source
    child = sched.fork_conversation(source.id, task.id)
    target = child.fork.target_session_id
    transcript.with_name(f"{target}.jsonl").write_text(json.dumps({"sessionId": target}) + "\n")
    recovered = sched._conversation_for_launch(child)
    assert recovered.native_session_id == target
    cmd = Scheduler.build_cli_command(AccountType.claude, "followup", False, "new",
                                     native_session_id=recovered.native_session_id)
    assert f"--resume {target}" in cmd
    assert "--fork-session" not in cmd
    assert sched.get_conversation(source.id).native_session_id == source.native_session_id
    with pytest.raises(ValueError, match="来源会话 ID"):
        sched.update_conversation_native_session(child.id, source.native_session_id, "new")


@pytest.mark.parametrize("mutation", ["running", "missing_uuid", "tool_use", "foreign_session", "no_success"])
def test_rejects_unsafe_checkpoints(fork_source, mutation):
    sched, source, task, _, _ = fork_source
    path = sched.get_log_path(task.id)
    events = [json.loads(line) for line in path.read_text().splitlines()]
    if mutation == "running":
        task.status = TaskStatus.running
    elif mutation == "missing_uuid":
        events[0].pop("uuid")
    elif mutation == "tool_use":
        events[0]["message"]["content"] = [{"type": "tool_use"}]
    elif mutation == "foreign_session":
        task.native_session_id = str(uuid4())
    else:
        events[-1]["subtype"] = "error_max_turns"
    path.write_text("\n".join(json.dumps(e) for e in events))
    with pytest.raises(ValueError):
        completed_turn_checkpoint(task, path)


def test_rejects_foreign_task_and_missing_transcript(fork_source):
    sched, source, task, _, transcript = fork_source
    task.conversation_id = "other"
    task.save(sched.tasks_dir)
    with pytest.raises(ValueError, match="不属于"):
        sched.fork_conversation(source.id, task.id)
    task.conversation_id = source.id
    task.save(sched.tasks_dir)
    transcript.unlink()
    with pytest.raises(ValueError, match="原生会话"):
        sched.fork_conversation(source.id, task.id)
    assert len(sched.list_conversations()) == 1


def test_api_fork_and_read_only_inherited_history(fork_source, monkeypatch):
    from coderfleet.server import main
    sched, source, task, _, _ = fork_source
    monkeypatch.setattr(main, "scheduler", sched)
    response = asyncio.run(main.fork_conversation(source.id, main.ConversationForkRequest(task_id=task.id)))
    history = asyncio.run(main.inherited_conversation_tasks(response.id))
    assert [item.id for item in history] == [task.id]
    assert history[0].conversation_id == source.id
    assert sched.get_conversation(response.id).last_task_id == ""
    # Forking a child preserves all inherited turns exactly once.
    branch_task = task.model_copy(update={"id": "branch-turn", "conversation_id": response.id})
    branch_task.save(sched.tasks_dir)
    sched.get_log_path(branch_task.id).write_text(sched.get_log_path(task.id).read_text())
    grandchild = sched.fork_conversation(response.id, branch_task.id)
    assert grandchild.fork.inherited_task_ids == [task.id, branch_task.id]


def test_fork_cli_uses_same_endpoint(monkeypatch):
    from click.testing import CliRunner
    import httpx
    from coderfleet import task_cmds
    calls = []
    monkeypatch.setattr(task_cmds, "_require_server", lambda: "http://test")

    def post(url, *, json, timeout):
        calls.append((url, json))
        return httpx.Response(201, json={"id": "child"})

    monkeypatch.setattr(task_cmds.httpx, "post", post)
    result = CliRunner().invoke(task_cmds.task_group, ["fork", "source", "--after-task", "turn-b", "--name", "Plan B"])
    assert result.exit_code == 0, result.output
    assert calls == [("http://test/api/conversations/source/fork", {"task_id": "turn-b", "name": "Plan B"})]
    assert "--conversation child" in result.output


def test_scheduled_turn_after_checkpoint_is_not_inherited(fork_source):
    sched, source, task, _, _ = fork_source
    task.finished = "2026-10-18T12:00:00"
    task.save(sched.tasks_dir)
    later = task.model_copy(update={"id": "later", "created": "2020-01-01T00:00:00",
                                   "finished": "2026-10-18T13:00:00"})
    later.save(sched.tasks_dir)
    child = sched.fork_conversation(source.id, task.id)
    assert child.fork.inherited_task_ids == [task.id]


def test_mobile_page_versions_shared_renderer(monkeypatch):
    from coderfleet.server import main
    monkeypatch.setattr(main, "_BUILD_VERSION", "fork-icon-test")
    response = asyncio.run(main.mobile())
    html = response.body.decode()
    assert "/static/js/renderer.js?v=fork-icon-test" in html
    assert "/static/css/turn-actions.css?v=fork-icon-test" in html
    assert "__BUILD__" not in html
    assert response.headers["cache-control"] == "no-cache"
