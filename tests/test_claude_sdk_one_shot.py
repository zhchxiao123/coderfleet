"""Standalone SDK Task lifecycle through the public scheduler interface."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from coderfleet.server import docker_mgr
from coderfleet.server.models import AccountRuntime, TaskStatus
from coderfleet.server.runtime import ContainerSpec, FakeProcess, FakeRuntime
from coderfleet.server.scheduler import Scheduler


def test_local_one_shot_sdk_task_can_be_stopped_without_a_conversation(tmp_path: Path) -> None:
    (tmp_path / "accounts.conf").write_text(
        "NAME=local-sdk TYPE=claude RUNTIME=local PROXY=off CLAUDE_BACKEND=sdk\n",
        encoding="utf-8",
    )

    class WaitingOutput:
        async def read(self, n: int = -1) -> bytes:
            await asyncio.Event().wait()
            return b""

    class WorkerRuntime(FakeRuntime):
        def __init__(self) -> None:
            super().__init__()
            self.started = asyncio.Event()
            self.state_path: Path | None = None

        async def run(self, spec: ContainerSpec) -> FakeProcess:
            await super().run(spec)
            request_path = next((Path(spec.workdir) / ".coderfleet-tasks").glob("*.sdk.json"))
            request = json.loads(request_path.read_text(encoding="utf-8"))
            self.state_path = Path(request["state_path"])
            self.state_path.write_text(
                json.dumps({"task_id": request["task_id"], "pid": 999999, "status": "running"}),
                encoding="utf-8",
            )
            process = FakeProcess(pid=999999)
            process.stdout = WaitingOutput()
            self.started.set()
            return process

        async def exec(
            self, container: str, command: list[str], env: dict[str, str] | None = None,
            workdir: str = "",
        ) -> FakeProcess:
            await super().exec(container, command, env=env, workdir=workdir)
            requested_state = next(Path(value) for value in command if value.endswith(".sdk-state.json"))
            assert requested_state == self.state_path
            return FakeProcess(stdout_chunks=[b'{"alive":false}'])

    runtime = WorkerRuntime()
    scheduler = Scheduler(tmp_path, local_runtime=runtime)

    async def drive() -> str:
        task = await scheduler.submit("stop standalone work", account_name="local-sdk", ephemeral=True)
        await asyncio.wait_for(runtime.started.wait(), timeout=2)
        await asyncio.sleep(0)
        assert task.conversation_id == ""
        stopped = await scheduler.kill_task(task.id)
        assert stopped.status == TaskStatus.killed
        return task.id

    task_id = asyncio.run(drive())
    persisted = scheduler.get_task(task_id)
    assert persisted is not None
    assert persisted.status == TaskStatus.killed
    assert runtime.removed == [persisted.ephemeral_container_name]


def test_stopping_sdk_task_uses_its_original_runtime_after_account_changes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    (tmp_path / "accounts.conf").write_text(
        "NAME=sdk-one TYPE=claude PROXY=off CLAUDE_BACKEND=sdk\n", encoding="utf-8",
    )
    (tmp_path / "projects.conf").write_text(
        f"NAME=repo ACCOUNT=sdk-one PATH={repo}\n", encoding="utf-8",
    )
    monkeypatch.setattr(docker_mgr, "is_container_running", lambda _: True)

    class OriginalRuntime(FakeRuntime):
        def __init__(self) -> None:
            super().__init__()
            self.started = asyncio.Event()
            self.worker_alive = False

        async def exec(
            self, container: str, command: list[str], env: dict[str, str] | None = None,
            workdir: str = "",
        ) -> FakeProcess:
            await super().exec(container, command, env=env, workdir=workdir)
            if "setsid" in " ".join(command):
                self.worker_alive = True
                self.started.set()
            if any(value.endswith(".sdk-state.json") for value in command):
                if command[-2] in {"term", "kill"}:
                    self.worker_alive = False
                payload = json.dumps({"alive": self.worker_alive}).encode()
                return FakeProcess(stdout_chunks=[payload])
            return FakeProcess()

    original_runtime = OriginalRuntime()
    local_runtime = FakeRuntime().queue(FakeProcess(stdout_chunks=[b'{"alive":false}']))
    scheduler = Scheduler(tmp_path, runtime=original_runtime, local_runtime=local_runtime)

    async def drive() -> None:
        task = await scheduler.submit("keep ownership", project_name="repo", conversation_name="Owned")
        await asyncio.wait_for(original_runtime.started.wait(), timeout=2)
        account = scheduler.get_accounts()[0]
        scheduler.save_account(
            account.name, account.type, account.auth, account.proxy, AccountRuntime.local,
            claude_backend="sdk",
        )
        stopped = await scheduler.kill_task(task.id)
        assert stopped.status == TaskStatus.killed
        assert original_runtime.worker_alive is False
        assert local_runtime.execs == []

    asyncio.run(drive())


def test_sdk_final_output_written_during_exit_probe_is_preserved(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    (tmp_path / "accounts.conf").write_text(
        "NAME=sdk-one TYPE=claude PROXY=off CLAUDE_BACKEND=sdk\n", encoding="utf-8",
    )
    (tmp_path / "projects.conf").write_text(
        f"NAME=repo ACCOUNT=sdk-one PATH={repo}\n", encoding="utf-8",
    )
    monkeypatch.setattr(docker_mgr, "is_container_running", lambda _: True)

    class CompletionDuringProbeRuntime(FakeRuntime):
        def __init__(self) -> None:
            super().__init__()
            self.request: dict[str, str] | None = None
            self.completed = False

        async def exec(
            self, container: str, command: list[str], env: dict[str, str] | None = None,
            workdir: str = "",
        ) -> FakeProcess:
            await super().exec(container, command, env=env, workdir=workdir)
            if "setsid" in " ".join(command):
                request_path = next((repo / ".coderfleet-tasks").glob("*.sdk.json"))
                self.request = json.loads(request_path.read_text(encoding="utf-8"))
            if any(value.endswith(".sdk-state.json") for value in command):
                assert self.request is not None
                if not self.completed:
                    # The worker appends and exits after the watcher's source read,
                    # while its asynchronous liveness observation is in flight.
                    task_id = self.request["task_id"]
                    events = [
                        {"type": "system", "subtype": "init", "session_id": "late-session"},
                        {"type": "result", "subtype": "success", "is_error": False,
                         "session_id": "late-session", "result": "final output during probe",
                         "total_cost_usd": 0.019},
                    ]
                    source = repo / ".coderfleet-tasks" / f"{task_id}.log"
                    source.write_text(
                        "\n".join(json.dumps(event) for event in events) + "\n", encoding="utf-8",
                    )
                    (source.with_suffix(".exit")).write_text("0", encoding="utf-8")
                    self.completed = True
                return FakeProcess(stdout_chunks=[b'{"alive":false}'])
            return FakeProcess()

    scheduler = Scheduler(tmp_path, runtime=CompletionDuringProbeRuntime())

    async def drive() -> str:
        task = await scheduler.submit("preserve final output", project_name="repo")
        async with asyncio.timeout(7):
            while scheduler.get_task(task.id).status == TaskStatus.running:
                await asyncio.sleep(0.02)
        return task.id

    task_id = asyncio.run(drive())
    finished = scheduler.get_task(task_id)
    assert finished is not None
    assert finished.status == TaskStatus.done
    assert finished.native_session_id == "late-session"
    assert finished.cost_usd == 0.019
    assert "final output during probe" in scheduler.get_log_path(task_id).read_text(encoding="utf-8")


def test_pending_sdk_task_keeps_its_submission_runtime_when_account_changes(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    (tmp_path / "accounts.conf").write_text(
        "NAME=sdk-one TYPE=claude RUNTIME=local PROXY=off CLAUDE_BACKEND=sdk\n",
        encoding="utf-8",
    )
    (tmp_path / "projects.conf").write_text(
        f"NAME=repo ACCOUNT=sdk-one PATH={repo}\n", encoding="utf-8",
    )

    class WaitingOutput:
        async def read(self, n: int = -1) -> bytes:
            await asyncio.Event().wait()
            return b""

    class QueueRuntime(FakeRuntime):
        def __init__(self) -> None:
            super().__init__()
            self.started = asyncio.Event()

        async def run(self, spec: ContainerSpec) -> FakeProcess:
            await super().run(spec)
            if len(self.runs) == 1:
                process = FakeProcess(pid=999999)
                process.stdout = WaitingOutput()
                self.started.set()
                return process
            result = {"type": "result", "subtype": "success", "is_error": False,
                      "session_id": "queue-local-session", "result": "queued local output"}
            return FakeProcess(stdout_chunks=[(json.dumps(result) + "\n").encode()])

        async def exec(
            self, container: str, command: list[str], env: dict[str, str] | None = None,
            workdir: str = "",
        ) -> FakeProcess:
            await super().exec(container, command, env=env, workdir=workdir)
            return FakeProcess(stdout_chunks=[b'{"alive":false}'])

    local_runtime = QueueRuntime()
    container_runtime = FakeRuntime()
    scheduler = Scheduler(tmp_path, runtime=container_runtime, local_runtime=local_runtime)

    async def drive() -> str:
        first = await scheduler.submit("hold queue", project_name="repo", conversation_name="Queue")
        await asyncio.wait_for(local_runtime.started.wait(), timeout=2)
        second = await scheduler.submit("queued local work", conversation_id=first.conversation_id)
        assert second.status == TaskStatus.pending
        account = scheduler.get_accounts()[0]
        scheduler.save_account(
            account.name, account.type, account.auth, account.proxy, AccountRuntime.container,
            claude_backend="sdk",
        )
        await scheduler.kill_task(first.id)
        await scheduler.schedule_next_tasks()
        async with asyncio.timeout(3):
            while scheduler.get_task(second.id).status in {TaskStatus.pending, TaskStatus.running}:
                await asyncio.sleep(0.02)
        return second.id

    second_id = asyncio.run(drive())
    finished = scheduler.get_task(second_id)
    assert finished is not None
    assert finished.status == TaskStatus.done
    assert len(local_runtime.runs) == 2
    assert container_runtime.runs == []
    assert "queued local output" in scheduler.get_log_path(second_id).read_text(encoding="utf-8")
