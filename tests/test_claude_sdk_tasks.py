"""Claude execution backend contracts through public account and Task interfaces."""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest

from coderfleet.server import main as server_main
from coderfleet.server import docker_mgr
from coderfleet.server.runtime import FakeProcess, FakeRuntime
from coderfleet.server.scheduler import Scheduler
from coderfleet.server.models import AccountType, Task, TaskResponse, TaskStatus


def test_sdk_recovery_keeps_unobservable_worker_busy_without_aborting_startup(tmp_path: Path) -> None:
    (tmp_path / "accounts.conf").write_text(
        "NAME=one TYPE=claude RUNTIME=local PROXY=off CLAUDE_BACKEND=sdk\n",
    )
    runtime = FakeRuntime().queue(FakeProcess(stdout_chunks=[b'{"error":"observation unavailable"}'], returncode=1))
    scheduler = Scheduler(tmp_path, local_runtime=runtime)
    task = Task(id="unknown-worker", status=TaskStatus.running, account="one", type=AccountType.claude,
                prompt="running", project=str(tmp_path), execution_backend="sdk", execution_runtime="local",
                ephemeral=True)
    task.save(scheduler.tasks_dir)

    assert asyncio.run(scheduler.reconcile_running_tasks()) == 0
    assert scheduler.get_task(task.id).status == TaskStatus.running
    assert runtime.runs == []
    assert runtime.removed == []


def test_sdk_stop_rechecks_when_container_exit_interrupts_the_observer(tmp_path: Path) -> None:
    (tmp_path / "accounts.conf").write_text("NAME=one TYPE=claude CLAUDE_BACKEND=sdk\n")
    runtime = FakeRuntime().queue(
        FakeProcess(stdout_chunks=[b'{"alive":true}']),
        FakeProcess(returncode=137),
        FakeProcess(stdout_chunks=[b'Error response from daemon: No such container: owned-sdk-container'], returncode=1),
    )
    scheduler = Scheduler(tmp_path, runtime=runtime)
    task = Task(id="exit-during-observation", status=TaskStatus.running, account="one", type=AccountType.claude,
                prompt="stop", project="ephemeral", execution_backend="sdk", execution_runtime="container",
                ephemeral=True, ephemeral_container_name="owned-sdk-container")
    task.save(scheduler.tasks_dir)

    stopped = asyncio.run(scheduler.kill_task(task.id))
    assert stopped.status == TaskStatus.killed
    assert len(runtime.execs) == 3


def test_claude_account_backend_roundtrips_through_api(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    scheduler = Scheduler(tmp_path, runtime=FakeRuntime())
    monkeypatch.setattr(server_main, "scheduler", scheduler)
    monkeypatch.setattr(docker_mgr, "is_container_running", lambda _: False)
    request = server_main.AccountCreateRequest(name="sdk-one", type="claude", claude_backend="sdk")
    asyncio.run(server_main.create_account(request))
    accounts = asyncio.run(server_main.list_accounts())
    assert accounts[0].model_dump()["claude_backend"] == "sdk"
    asyncio.run(server_main.update_account("sdk-one", server_main.AccountUpdateRequest(claude_backend="cli")))
    accounts = asyncio.run(server_main.list_accounts())
    assert accounts[0].model_dump()["claude_backend"] == "cli"


def test_scheduled_task_keeps_submission_backend_when_account_changes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    scheduler = Scheduler(tmp_path, runtime=FakeRuntime())
    monkeypatch.setattr(docker_mgr, "is_container_running", lambda _: True)
    (tmp_path / "accounts.conf").write_text("NAME=one TYPE=claude CLAUDE_BACKEND=sdk\n")
    repo = tmp_path / "repo"
    repo.mkdir()
    (tmp_path / "projects.conf").write_text(f"NAME=repo ACCOUNT=one PATH={repo}\n")
    scheduled = (datetime.now() + timedelta(hours=1)).isoformat()

    async def submit_and_change():
        task = await scheduler.submit("保留 SDK", project_name="repo", execute_at=scheduled)
        account = scheduler.get_accounts()[0]
        scheduler.save_account("one", account.type, account.auth, account.proxy, claude_backend="cli")
        return task

    task = asyncio.run(submit_and_change())
    loaded = scheduler.get_task(task.id)
    assert loaded is not None
    assert TaskResponse.from_task(loaded).execution_backend == "sdk"
    assert scheduler.get_accounts()[0].claude_backend == "cli"


def test_sdk_task_runs_through_runtime_and_exposes_versions_and_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    (tmp_path / "accounts.conf").write_text("NAME=one TYPE=claude CLAUDE_BACKEND=sdk\n")
    (tmp_path / "projects.conf").write_text(f"NAME=repo ACCOUNT=one PATH={repo}\n")
    monkeypatch.setattr(docker_mgr, "is_container_running", lambda _: True)

    class WorkerRuntime(FakeRuntime):
        async def exec(self, container, command, env=None, workdir=""):
            await super().exec(container, command, env=env, workdir=workdir)
            if len(command) >= 8 and command[-4].endswith(".sdk-state.json"):
                return FakeProcess(stdout_chunks=[b'{"alive":false}'])
            if "setsid" not in " ".join(command):
                return FakeProcess(returncode=0)
            if "--spec" not in " ".join(command):
                return FakeProcess(stdout_chunks=[b"expected SDK worker request"], returncode=1)
            requests = list((repo / ".coderfleet-tasks").glob("*.sdk.json"))
            assert len(requests) == 1
            spec = json.loads(requests[0].read_text())
            assert spec["prompt"] == "中文提问"
            events = [
                {"type":"system", "subtype":"coderfleet_backend", "task_id":spec["task_id"], "execution_backend":"sdk", "sdk_version":"0.2.180", "cli_version":"2.1.321"},
                {"type":"system", "subtype":"init", "session_id":"session-one"},
                {"type":"assistant", "uuid":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "session_id":"session-one", "message":{"content":[{"type":"text","text":"中文回答"}],"usage":{"input_tokens":12,"output_tokens":8}}},
                {"type":"result", "subtype":"success", "is_error":False,"session_id":"session-one","result":"中文回答","total_cost_usd":0.013},
            ]
            (repo / ".coderfleet-tasks" / f'{spec["task_id"]}.log').write_text("\n".join(json.dumps(event, ensure_ascii=False) for event in events) + "\n")
            (repo / ".coderfleet-tasks" / f'{spec["task_id"]}.exit').write_text("0")
            return FakeProcess(returncode=0)

    scheduler = Scheduler(tmp_path, runtime=WorkerRuntime())

    async def drive():
        task = await scheduler.submit("中文提问", project_name="repo")
        for _ in range(100):
            current = scheduler.get_task(task.id)
            if current.status != TaskStatus.running:
                return current
            await asyncio.sleep(0.02)
        raise AssertionError("Task did not finish")

    finished = asyncio.run(drive())
    assert finished.status == TaskStatus.done
    response = TaskResponse.from_task(finished)
    assert (response.execution_backend, response.sdk_version, response.cli_version) == ("sdk", "0.2.180", "2.1.321")
    assert response.native_session_id == "session-one"
    assert response.cost_usd == 0.013
    assert "中文回答" in scheduler.get_log_path(finished.id).read_text()


def test_sdk_status_uses_account_runtime_without_running_a_task(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    report = {"ready": True, "sdk_version": "0.2.180", "cli_version": "2.1.321", "python_path": "/isolated/bin/python", "error": ""}
    runtime = FakeRuntime().queue(FakeProcess(stdout_chunks=[json.dumps(report).encode()]))
    scheduler = Scheduler(tmp_path, local_runtime=runtime)
    (tmp_path / "accounts.conf").write_text("NAME=one TYPE=claude RUNTIME=local PROXY=off\n")
    monkeypatch.setattr(server_main, "scheduler", scheduler)
    result = asyncio.run(server_main.get_claude_sdk_status("one"))
    assert result["ready"] is True
    assert result["sdk_version"] == "0.2.180"
    assert scheduler.list_tasks() == []


def test_local_sdk_task_uses_real_project_and_account_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    (tmp_path / "accounts.conf").write_text("NAME=one TYPE=claude RUNTIME=local PROXY=off CLAUDE_BACKEND=sdk\n")
    (tmp_path / "projects.conf").write_text(f"NAME=repo ACCOUNT=one PATH={repo}\n")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "foreign-account-token")

    class WorkerRuntime(FakeRuntime):
        async def exec(self, container, command, env=None, workdir=""):
            return FakeProcess(stdout_chunks=[b'{"alive":false}'])

        async def run(self, spec):
            await super().run(spec)
            if "--spec" not in " ".join(spec.command):
                return FakeProcess(returncode=1)
            request = json.loads(next((repo / ".coderfleet-tasks").glob("*.sdk.json")).read_text())
            assert request["cwd"] == str(repo)
            events = [
                {"type":"system","subtype":"coderfleet_backend","execution_backend":"sdk","task_id":request["task_id"],"sdk_version":"0.2.180","cli_version":"2.1.321"},
                {"type":"result","subtype":"success","is_error":False,"session_id":"local-session","result":"本地结果"},
            ]
            return FakeProcess(stdout_chunks=[("\n".join(json.dumps(event,ensure_ascii=False) for event in events)+"\n").encode()])

    runtime = WorkerRuntime()
    scheduler = Scheduler(tmp_path, local_runtime=runtime)

    async def drive():
        task = await scheduler.submit("本地提问", project_name="repo", conversation_name="local")
        for _ in range(100):
            current = scheduler.get_task(task.id)
            if current.status != TaskStatus.running:
                return current
            await asyncio.sleep(0.02)
        raise AssertionError("local Task did not finish")

    finished = asyncio.run(drive())
    assert finished.status == TaskStatus.done
    assert finished.sdk_version == "0.2.180"
    assert runtime.runs[0].env["CLAUDE_CONFIG_DIR"] == str(tmp_path / "accounts/one/.claude")
    assert runtime.runs[0].env["ANTHROPIC_API_KEY"] == ""
    assert runtime.runs[0].workdir == str(repo)
    assert scheduler.get_conversation(finished.conversation_id).ephemeral is False


def test_stopping_local_sdk_task_uses_local_cleanup_and_keeps_killed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    (tmp_path / "accounts.conf").write_text("NAME=one TYPE=claude RUNTIME=local PROXY=off CLAUDE_BACKEND=sdk\n")
    (tmp_path / "projects.conf").write_text(f"NAME=repo ACCOUNT=one PATH={repo}\n")

    class PausedRuntime(FakeRuntime):
        async def exec(self, *args, **kwargs):
            return FakeProcess(stdout_chunks=[b'{"alive":false}'])

        async def run(self, spec):
            await super().run(spec)
            async def read(_size):
                await asyncio.Event().wait()
            return SimpleNamespace(pid=999999, stdout=SimpleNamespace(read=read))

    runtime = PausedRuntime()
    scheduler = Scheduler(tmp_path, local_runtime=runtime)

    def reject_docker(*args, **kwargs):
        raise AssertionError("local Task must not call Docker")

    async def drive():
        task = await scheduler.submit("等待停止", project_name="repo")
        await asyncio.sleep(0.02)
        monkeypatch.setattr("subprocess.run", reject_docker)
        await scheduler.kill_task(task.id)
        return scheduler.get_task(task.id)

    killed = asyncio.run(drive())
    assert killed.status == TaskStatus.killed
    assert runtime.removed == [killed.ephemeral_container_name]


def test_sdk_recovery_resumes_committed_log_cursor_without_loss_or_duplicates(
    tmp_path: Path,
) -> None:
    repo = tmp_path / "sdk-recovery-fixture"
    repo.mkdir()
    (tmp_path / "accounts.conf").write_text("NAME=one TYPE=claude CLAUDE_BACKEND=cli\n")
    (tmp_path / "projects.conf").write_text(f"NAME=sdk-recovery-fixture ACCOUNT=one PATH={repo}\n")
    runtime = FakeRuntime().queue(
        FakeProcess(stdout_chunks=[b'{"alive":false}']),
        FakeProcess(stdout_chunks=[b'{"alive":false}']),
    )
    scheduler = Scheduler(tmp_path, runtime=runtime)
    first = json.dumps({"type":"assistant","message":{"content":[{"type":"text","text":"已保存"}]}} ,ensure_ascii=False) + "\n"
    second = json.dumps({"type":"result","subtype":"success","is_error":False,"result":"重启期间的新输出"},ensure_ascii=False) + "\n"
    log_path = scheduler.get_log_path("recover-one")
    log_path.parent.mkdir(parents=True)
    committed = "=== Task ===\n" + first
    log_path.write_text(committed + "uncommitted partial tail")
    task = Task(
        id="recover-one",status=TaskStatus.running,account="one",type=AccountType.claude,
        prompt="recover",project=str(repo),project_name="sdk-recovery-fixture",execution_backend="sdk",
        sdk_source_offset=len(first.encode()),sdk_log_size=len(committed.encode()),
    )
    task.save(scheduler.tasks_dir)
    source = repo / ".coderfleet-tasks"
    source.mkdir()
    (source / f"{task.id}.log").write_text(first + second)
    (source / f"{task.id}.exit").write_text("0")

    async def recover():
        assert await scheduler.reconcile_running_tasks() == 1
        for _ in range(100):
            current = scheduler.get_task(task.id)
            if current.status != TaskStatus.running:
                return current
            await asyncio.sleep(0.02)
        raise AssertionError("Recovered task did not finish")

    recovered = asyncio.run(recover())
    assert recovered.status == TaskStatus.done
    text = log_path.read_text()
    assert text.count("已保存") == 1
    assert text.count("重启期间的新输出") == 1
    assert "uncommitted partial tail" not in text


def test_log_write_failure_stops_sdk_worker_before_failing_task(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    (tmp_path / "accounts.conf").write_text("NAME=one TYPE=claude CLAUDE_BACKEND=sdk\n")
    (tmp_path / "projects.conf").write_text(f"NAME=repo ACCOUNT=one PATH={repo}\n")
    monkeypatch.setattr(docker_mgr, "is_container_running", lambda _: True)

    class WorkerRuntime(FakeRuntime):
        alive = False

        async def exec(self, container, command, env=None, workdir=""):
            if command[:3] == ["python3", "-I", "-c"]:
                if command[-2] in ("term", "kill"):
                    self.alive = False
                return FakeProcess(stdout_chunks=[json.dumps({"alive": self.alive}).encode()])
            if "setsid" in " ".join(command):
                self.alive = True
                request = json.loads(next((repo/".coderfleet-tasks").glob("*.sdk.json")).read_text())
                scheduler.get_log_path(request["task_id"]).chmod(0o444)
                return FakeProcess(returncode=0)
            return FakeProcess(returncode=0)

    runtime = WorkerRuntime()
    scheduler = Scheduler(tmp_path, runtime=runtime)

    async def drive():
        task = await scheduler.submit("log failure", project_name="repo")
        for _ in range(100):
            current = scheduler.get_task(task.id)
            if current.status != TaskStatus.running:
                return current
            await asyncio.sleep(0.02)
        raise AssertionError("Task did not report log failure")

    failed = asyncio.run(drive())
    assert failed.status == TaskStatus.failed
    assert runtime.alive is False


def test_turns_of_the_node_backend_are_left_to_it(tmp_path: Path) -> None:
    """The desktop App's Node backend follows its own turns: no reattach, no stop, fields kept."""
    (tmp_path / "accounts.conf").write_text("NAME=one TYPE=claude CLAUDE_BACKEND=sdk\n")
    runtime = FakeRuntime()
    scheduler = Scheduler(tmp_path, runtime=runtime)
    node = {"launchedAt": "2026-11-23T14:00:00.000Z", "logOffset": 42, "controlReady": True}
    task = Task(id="node-turn", status=TaskStatus.running, account="one", type=AccountType.claude,
                prompt="running", project=str(tmp_path), execution_backend="sdk", execution_runtime="container",
                sdk_version="node", node=node)
    task.save(scheduler.tasks_dir)
    raw = json.loads((scheduler.tasks_dir / "node-turn.json").read_text())
    assert raw["node"] == node, "saving keeps the Node backend's follow state"

    assert asyncio.run(scheduler.reconcile_running_tasks()) == 0
    assert scheduler.get_task(task.id).status == TaskStatus.running
    assert runtime.runs == []
    with pytest.raises(RuntimeError, match="App"):
        asyncio.run(scheduler.kill_task(task.id))
    assert scheduler.get_task(task.id).status == TaskStatus.running
