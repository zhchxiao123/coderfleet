"""Conversation compatibility through real Scheduler submissions and worker requests."""
from __future__ import annotations

import asyncio
import json
import shlex
from pathlib import Path
from uuid import uuid4

import pytest

from coderfleet.server import docker_mgr
from coderfleet.server.models import Task, TaskResponse, TaskStatus
from coderfleet.server.runtime import FakeProcess, FakeRuntime
from coderfleet.server.scheduler import Scheduler


class ConversationRuntime(FakeRuntime):
    """Controlled CLI/SDK process protocol, preserving session/checkpoint history."""

    def __init__(self, workspace: Path, repo: Path) -> None:
        super().__init__()
        self.workspace = workspace
        self.repo = repo
        self.requests: list[dict] = []
        self.histories: dict[str, list[str]] = {}
        self.checkpoints: dict[str, list[str]] = {}
        self.hold_next = False
        self.pending_exits: dict[str, Path] = {}
        self.corrupt_next_transcript = False

    async def exec(self, container, command, env=None, workdir=""):
        await super().exec(container, command, env=env, workdir=workdir)
        if len(command) >= 8 and command[-4].endswith(".sdk-state.json"):
            return FakeProcess(stdout_chunks=[json.dumps({"alive": command[-3] in self.pending_exits}).encode()])
        payload = command[-1]
        if "setsid" not in payload:
            return FakeProcess(returncode=0)
        if "--spec" in payload:
            consumed = {request["task_id"] for request in self.requests}
            candidates = [
                json.loads(path.read_text())
                for path in (self.repo / ".coderfleet-tasks").glob("*.sdk.json")
                if path.name.removesuffix(".sdk.json") not in consumed
            ]
            assert len(candidates) == 1
            request = {**candidates[0], "backend": "sdk"}
        else:
            outer = shlex.split(payload)
            body = outer[outer.index("setsid") + 3]
            tokens = shlex.split(body)
            task_id = next(token.split("=", 1)[1] for token in tokens if token.startswith("CODERFLEET_TASK_ID="))
            request = {
                "backend": "cli", "task_id": task_id,
                "prompt": tokens[tokens.index("printf") + 2],
                "session_id": tokens[tokens.index("--resume") + 1] if "--resume" in tokens else "",
                "fork_session_id": "", "resume_session_at": "",
            }
        self.requests.append(request)
        source = request["session_id"]
        target = request["fork_session_id"] or source or str(uuid4())
        history = list(self.checkpoints[request["resume_session_at"]]) if request["resume_session_at"] else list(self.histories.get(source, []))
        history.append(request["prompt"])
        self.histories[target] = history
        checkpoint = str(uuid4())
        self.checkpoints[checkpoint] = list(history)
        answer = " > ".join(history)
        events = [
            {"type": "system", "subtype": "init", "session_id": target},
            {"type": "assistant", "session_id": target, "uuid": checkpoint,
             "message": {"content": [{"type": "text", "text": answer}]}},
            {"type": "result", "session_id": target, "subtype": "success", "is_error": False,
             "result": answer, "total_cost_usd": 0.01},
        ]
        if request["backend"] == "sdk":
            events.insert(0, {"type": "system", "subtype": "coderfleet_backend", "task_id": request["task_id"],
                              "execution_backend": "sdk", "sdk_version": "0.2.180", "cli_version": "2.1.321"})
        artifact = self.repo / ".coderfleet-tasks"
        artifact.mkdir(exist_ok=True)
        (artifact / f'{request["task_id"]}.log').write_text("\n".join(json.dumps(event) for event in events) + "\n")
        transcript = self.workspace / "accounts/one/projects/-repo" / f"{target}.jsonl"
        transcript.parent.mkdir(parents=True, exist_ok=True)
        with transcript.open("a") as stream:
            transcript_checkpoint = str(uuid4()) if self.corrupt_next_transcript else checkpoint
            stream.write(json.dumps({"uuid": transcript_checkpoint, "sessionId": target, "message": events[-2]["message"]}) + "\n")
        self.corrupt_next_transcript = False
        exit_file = artifact / f'{request["task_id"]}.exit'
        if self.hold_next:
            self.hold_next = False
            self.pending_exits[request["task_id"]] = exit_file
        else:
            exit_file.write_text("0")
        return FakeProcess(returncode=0)

    def release(self, task_id: str) -> None:
        self.pending_exits.pop(task_id).write_text("0")


@pytest.fixture
def conversation_system(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    repo = tmp_path / "repo"
    repo.mkdir()
    (tmp_path / "accounts.conf").write_text("NAME=one TYPE=claude CLAUDE_BACKEND=cli\n")
    (tmp_path / "projects.conf").write_text(f"NAME=repo ACCOUNT=one PATH={repo}\n")
    monkeypatch.setattr(docker_mgr, "is_container_running", lambda _: True)
    runtime = ConversationRuntime(tmp_path, repo)
    return Scheduler(tmp_path, runtime=runtime), runtime


def select_backend(scheduler: Scheduler, backend: str) -> None:
    account = scheduler.get_accounts()[0]
    scheduler.save_account(account.name, account.type, account.auth, account.proxy,
                           account.runtime, account.sandbox_confirmed, claude_backend=backend)


async def wait_done(scheduler: Scheduler, task: Task) -> Task:
    for _ in range(250):
        current = scheduler.get_task(task.id)
        assert current is not None
        if current.status not in (TaskStatus.running, TaskStatus.pending):
            assert current.status == TaskStatus.done, scheduler.get_log_path(task.id).read_text()
            return current
        await asyncio.sleep(0.02)
    raise AssertionError(f"Task {task.id} did not finish")


def test_conversation_resumes_cli_to_sdk_and_back_without_changing_session(conversation_system) -> None:
    scheduler, runtime = conversation_system

    async def drive():
        first = await wait_done(scheduler, await scheduler.submit("alpha", project_name="repo", conversation_name="Context"))
        select_backend(scheduler, "sdk")
        second = await wait_done(scheduler, await scheduler.submit("beta", conversation_id=first.conversation_id))
        select_backend(scheduler, "cli")
        third = await wait_done(scheduler, await scheduler.submit("gamma", conversation_id=first.conversation_id))
        return first, second, third

    first, second, third = asyncio.run(drive())
    assert [task.execution_backend for task in (first, second, third)] == ["cli", "sdk", "cli"]
    assert first.native_session_id == second.native_session_id == third.native_session_id
    assert "alpha > beta > gamma" in scheduler.get_log_path(third.id).read_text()
    assert runtime.requests[1]["session_id"] == first.native_session_id
    assert runtime.requests[2]["session_id"] == first.native_session_id
    assert TaskResponse.from_task(second).sdk_version == "0.2.180"


def test_queued_conversation_tasks_keep_backend_snapshots_and_start_serially(conversation_system) -> None:
    scheduler, runtime = conversation_system

    async def drive():
        select_backend(scheduler, "sdk")
        runtime.hold_next = True
        first = await scheduler.submit("first", project_name="repo", conversation_name="Queue")
        for _ in range(100):
            if runtime.requests:
                break
            await asyncio.sleep(0.01)
        assert len(runtime.requests) == 1
        second = await scheduler.submit("second", conversation_id=first.conversation_id)
        select_backend(scheduler, "cli")
        third = await scheduler.submit("third", conversation_id=first.conversation_id)
        assert scheduler.get_task(second.id).status == TaskStatus.pending
        assert scheduler.get_task(third.id).status == TaskStatus.pending
        await scheduler.schedule_next_tasks()
        assert len(runtime.requests) == 1
        runtime.release(first.id)
        return [await wait_done(scheduler, task) for task in (first, second, third)]

    finished = asyncio.run(drive())
    assert [task.execution_backend for task in finished] == ["sdk", "sdk", "cli"]
    assert [request["prompt"] for request in runtime.requests] == ["first", "second", "third"]
    assert [request["backend"] for request in runtime.requests] == ["sdk", "sdk", "cli"]
    assert len({task.native_session_id for task in finished}) == 1
    assert "first > second > third" in scheduler.get_log_path(finished[-1].id).read_text()


def test_sdk_fork_freezes_completed_checkpoint_and_followup_uses_target_session(conversation_system) -> None:
    scheduler, runtime = conversation_system

    async def drive():
        first = await wait_done(scheduler, await scheduler.submit("alpha", project_name="repo", conversation_name="Source"))
        select_backend(scheduler, "sdk")
        await wait_done(scheduler, await scheduler.submit("beta", conversation_id=first.conversation_id))
        source = scheduler.get_conversation(first.conversation_id)
        source_transcript = runtime.workspace / "accounts/one/projects/-repo" / f"{source.native_session_id}.jsonl"
        original = source_transcript.read_bytes()
        child = scheduler.fork_conversation(source.id, first.id, name="Alternative")
        first_branch = await wait_done(scheduler, await scheduler.submit("branch-B", conversation_id=child.id))
        second_branch = await wait_done(scheduler, await scheduler.submit("branch-C", conversation_id=child.id))
        return first, source, child, first_branch, second_branch, original, source_transcript.read_bytes()

    first, source, child, first_branch, second_branch, before, after = asyncio.run(drive())
    assert child.fork is not None
    assert child.fork.inherited_task_ids == [first.id]
    target = child.fork.target_session_id
    assert target != source.native_session_id
    assert first_branch.native_session_id == second_branch.native_session_id == target
    assert scheduler.get_conversation(child.id).native_session_id == target
    assert scheduler.get_conversation(source.id).native_session_id == first.native_session_id
    assert before == after
    assert "alpha > branch-B > branch-C" in scheduler.get_log_path(second_branch.id).read_text()
    assert "alpha > beta" not in scheduler.get_log_path(second_branch.id).read_text()
    branch_request, followup_request = runtime.requests[-2:]
    assert branch_request["session_id"] == source.native_session_id
    assert branch_request["resume_session_at"] == child.fork.message_uuid
    assert followup_request["session_id"] == target
    assert followup_request["fork_session_id"] == followup_request["resume_session_at"] == ""


def test_cancelling_pending_sdk_task_does_not_launch_it_or_stop_the_active_turn(conversation_system) -> None:
    scheduler, runtime = conversation_system

    async def drive():
        select_backend(scheduler, "sdk")
        runtime.hold_next = True
        first = await scheduler.submit("first", project_name="repo", conversation_name="Cancel queue")
        for _ in range(100):
            if runtime.requests:
                break
            await asyncio.sleep(0.01)
        cancelled = await scheduler.submit("cancelled", conversation_id=first.conversation_id)
        await scheduler.kill_task(cancelled.id)
        third = await scheduler.submit("third", conversation_id=first.conversation_id)
        await scheduler.schedule_next_tasks()
        assert scheduler.get_task(first.id).status == TaskStatus.running
        assert scheduler.get_task(cancelled.id).status == TaskStatus.killed
        assert len(runtime.requests) == 1
        runtime.release(first.id)
        await wait_done(scheduler, first)
        await wait_done(scheduler, third)
        return cancelled, third

    cancelled, third = asyncio.run(drive())
    assert [request["prompt"] for request in runtime.requests] == ["first", "third"]
    assert scheduler.get_task(cancelled.id).status == TaskStatus.killed
    assert "first > third" in scheduler.get_log_path(third.id).read_text()
    assert not (runtime.repo / ".coderfleet-tasks" / f"{cancelled.id}.sdk.json").exists()


@pytest.mark.parametrize("invalid_source", ["foreign_task", "missing_checkpoint"])
def test_sdk_fork_rejects_foreign_task_or_unrecorded_checkpoint(conversation_system, invalid_source: str) -> None:
    scheduler, runtime = conversation_system

    async def drive():
        select_backend(scheduler, "sdk")
        runtime.corrupt_next_transcript = invalid_source == "missing_checkpoint"
        source = await wait_done(scheduler, await scheduler.submit("source", project_name="repo", conversation_name="Source"))
        if invalid_source == "foreign_task":
            foreign = await wait_done(scheduler, await scheduler.submit("foreign", project_name="repo", conversation_name="Foreign"))
            checkpoint_task = foreign.id
        else:
            checkpoint_task = source.id
        before = [conversation.id for conversation in scheduler.list_conversations()]
        with pytest.raises(ValueError, match="不属于|消息 UUID 不在原生"):
            scheduler.fork_conversation(source.conversation_id, checkpoint_task)
        assert [conversation.id for conversation in scheduler.list_conversations()] == before

    asyncio.run(drive())
