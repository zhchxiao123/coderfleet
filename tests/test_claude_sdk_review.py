"""Review regressions at the existing Task execution boundary."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from coderfleet.server import docker_mgr
from coderfleet.server.models import TaskStatus
from coderfleet.server.runtime import FakeProcess, FakeRuntime
from coderfleet.server.scheduler import Scheduler


@pytest.mark.parametrize("local", [False, True], ids=["persistent", "local"])
@pytest.mark.parametrize("returncode", [1, 143], ids=["failed", "killed"])
def test_new_sdk_conversation_retains_init_session_after_unsuccessful_exit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, local: bool, returncode: int,
) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    runtime_options = " RUNTIME=local PROXY=off" if local else ""
    (tmp_path / "accounts.conf").write_text(
        f"NAME=one TYPE=claude CLAUDE_BACKEND=sdk{runtime_options}\n",
        encoding="utf-8",
    )
    (tmp_path / "projects.conf").write_text(
        f"NAME=repo ACCOUNT=one PATH={repo}\n", encoding="utf-8",
    )
    monkeypatch.setattr(docker_mgr, "is_container_running", lambda _: True)
    session_id = "11111111-1111-4111-8111-111111111111"
    events = (
        json.dumps({"type": "system", "subtype": "init", "session_id": session_id})
        + "\n"
    ).encode()

    class ExitingWorkerRuntime(FakeRuntime):
        async def exec(self, container, command, env=None, workdir=""):
            if len(command) >= 8 and command[-4].endswith(".sdk-state.json"):
                return FakeProcess(stdout_chunks=[b'{"alive":false}'])
            if "setsid" in command[-1]:
                request_path = next((repo / ".coderfleet-tasks").glob("*.sdk.json"))
                task_id = json.loads(request_path.read_text(encoding="utf-8"))["task_id"]
                (request_path.parent / f"{task_id}.log").write_bytes(events)
                (request_path.parent / f"{task_id}.exit").write_text(
                    str(returncode), encoding="utf-8",
                )
            return FakeProcess()

        async def run(self, spec):
            return FakeProcess(stdout_chunks=[events], returncode=returncode)

    runtime = ExitingWorkerRuntime()
    scheduler = Scheduler(tmp_path, runtime=runtime, local_runtime=runtime)

    async def drive():
        task = await scheduler.submit(
            "fixture", project_name="repo", conversation_name="Unfinished session",
        )
        for _ in range(100):
            watcher = scheduler._running.get(task.id)
            if watcher is None or watcher.done():
                return scheduler.get_task(task.id)
            await asyncio.sleep(0.02)
        raise AssertionError("Task execution did not finish")

    finished = asyncio.run(drive())
    assert finished is not None
    expected_status = TaskStatus.killed if returncode == 143 else TaskStatus.failed
    assert finished.status == expected_status
    assert finished.native_session_id == session_id
    conversation = scheduler.get_conversation(finished.conversation_id)
    assert conversation is not None
    assert conversation.native_session_id == session_id


def test_successful_sdk_task_waits_for_wrapper_to_publish_exit_after_worker_dies(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    (tmp_path / "accounts.conf").write_text(
        "NAME=one TYPE=claude CLAUDE_BACKEND=sdk\n", encoding="utf-8",
    )
    (tmp_path / "projects.conf").write_text(
        f"NAME=repo ACCOUNT=one PATH={repo}\n", encoding="utf-8",
    )
    monkeypatch.setattr(docker_mgr, "is_container_running", lambda _: True)

    class DelayedExitRuntime(FakeRuntime):
        exit_path: Path | None = None
        exit_publication: asyncio.Task | None = None

        async def publish_exit(self) -> None:
            await asyncio.sleep(0.05)
            assert self.exit_path is not None
            self.exit_path.write_text("0", encoding="utf-8")

        async def exec(self, container, command, env=None, workdir=""):
            if command[:3] == ["python3", "-I", "-c"]:
                if self.exit_publication is None:
                    self.exit_publication = asyncio.create_task(self.publish_exit())
                return FakeProcess(stdout_chunks=[b'{"alive":false}'])
            if "setsid" in command[-1]:
                request_path = next((repo / ".coderfleet-tasks").glob("*.sdk.json"))
                task_id = json.loads(request_path.read_text(encoding="utf-8"))["task_id"]
                self.exit_path = request_path.parent / f"{task_id}.exit"
                events = [
                    {"type": "system", "subtype": "init", "session_id": "new-session"},
                    {"type": "result", "subtype": "success", "is_error": False,
                     "session_id": "new-session", "result": "Complete answer"},
                ]
                (request_path.parent / f"{task_id}.log").write_text(
                    "\n".join(json.dumps(event) for event in events) + "\n",
                    encoding="utf-8",
                )
            return FakeProcess()

    runtime = DelayedExitRuntime()
    scheduler = Scheduler(tmp_path, runtime=runtime)

    async def drive():
        task = await scheduler.submit("fixture", project_name="repo")
        for _ in range(250):
            watcher = scheduler._running.get(task.id)
            if watcher is None or watcher.done():
                if runtime.exit_publication is not None:
                    await runtime.exit_publication
                return scheduler.get_task(task.id)
            await asyncio.sleep(0.02)
        raise AssertionError("Task execution did not finish")

    finished = asyncio.run(drive())
    assert finished is not None
    assert finished.status == TaskStatus.done
    assert "Complete answer" in scheduler.get_log_path(finished.id).read_text(encoding="utf-8")
