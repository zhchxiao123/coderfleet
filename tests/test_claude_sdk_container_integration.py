"""Opt-in real Docker + real SDK Task checks with a controlled, offline CLI.

SDK_TEST_IMAGE must name a locally available image with the pinned SDK venv.
No existing Account, credentials, project, or container is used.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

import pytest

from coderfleet.account_type_registry import AccountType
from coderfleet.server.models import AccountAuth, AccountProxy, Project, Task, TaskStatus
from coderfleet.server.runtime import ContainerSpec, DockerRuntime, Process
from coderfleet.server.scheduler import Scheduler


IMAGE = os.environ.get("SDK_TEST_IMAGE", "")
CLAUDE = AccountType("claude")
pytestmark = pytest.mark.skipif(not IMAGE, reason="Set SDK_TEST_IMAGE to opt in to isolated Docker SDK integration")
FIXTURE = Path(__file__).parent / "fixtures/claude_sdk_protocol_cli.py"


def docker(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["docker", *args], capture_output=True, text=True, check=check, timeout=20)


class OfflineDockerRuntime(DockerRuntime):
    """Keep the real Docker adapter while denying network in test containers."""

    async def run(self, spec: ContainerSpec) -> Process:
        return await super().run(replace(spec, network="none"))


@dataclass
class Harness:
    scheduler: Scheduler
    project: Project
    auth_dir: Path
    containers: set[str] = field(default_factory=set)

    def start_persistent(self) -> str:
        name = self.project.container_name(CLAUDE)
        env = self.scheduler.get_account_env(self.project.account)
        command = ["run", "--detach", "--network", "none", "--name", name,
                   "--volume", f"{self.project.path}:/workspace",
                   "--volume", f"{self.auth_dir}:/home/byclaw/.claude"]
        for key, value in env.items():
            command += ["--env", f"{key}={value}"]
        self.containers.add(name)
        docker(*command, "--entrypoint", "tail", IMAGE, "-f", "/dev/null")
        return name

    def close(self) -> None:
        for task in self.scheduler.list_tasks():
            if task.ephemeral_container_name:
                self.containers.add(task.ephemeral_container_name)
        for conversation in self.scheduler.list_conversations(include_archived=True):
            if conversation.ephemeral_container_name:
                self.containers.add(conversation.ephemeral_container_name)
        for name in self.containers:
            docker("rm", "-f", name, check=False)


@pytest.fixture
def harness(tmp_path: Path) -> Iterator[Harness]:
    docker("image", "inspect", IMAGE)
    root = tmp_path / "fleet"
    root.mkdir()
    (root / "config.conf").write_text("TASK_AUTO_RETRY=off DOCKER_SOCKET=off DIGEST_ENABLED=off\n")
    scheduler = Scheduler(root, runtime=OfflineDockerRuntime())
    name = f"sdk-proof-{uuid.uuid4().hex[:10]}"
    scheduler.save_account(name, CLAUDE, AccountAuth.env, AccountProxy.off, claude_backend="sdk")
    auth_dir = root / "accounts" / name
    auth_dir.chmod(0o777)
    cli = auth_dir / "claude-fixture"
    cli.write_text("#!/usr/bin/env python3\n" + FIXTURE.read_text(encoding="utf-8"), encoding="utf-8")
    cli.chmod(0o755)
    scheduler.set_account_env(name, {
        "CODERFLEET_CLAUDE_CLI_PATH": "/home/byclaw/.claude/claude-fixture",
        "FAKE_CLAUDE_CAPTURE": "/workspace/capture.json",
    })
    project_dir = tmp_path / "project"
    project_dir.mkdir(mode=0o777)
    project_dir.chmod(0o777)
    project = scheduler.save_project(name, name, str(project_dir), image=IMAGE, docker_socket="off")
    value = Harness(scheduler, project, auth_dir)
    try:
        yield value
    finally:
        value.close()


async def completed(scheduler: Scheduler, task: Task) -> Task:
    deadline = asyncio.get_running_loop().time() + 30
    while asyncio.get_running_loop().time() < deadline:
        saved = scheduler.get_task(task.id)
        if saved and saved.status in {TaskStatus.done, TaskStatus.failed, TaskStatus.killed}:
            # The public terminal notification follows usage/output extraction.
            if saved.terminal_notified:
                return saved
        await asyncio.sleep(0.05)
    raise AssertionError(f"Task {task.id} did not finish: {scheduler.get_log_path(task.id).read_text()[-3000:]}")


def assert_success(scheduler: Scheduler, task: Task) -> None:
    log = scheduler.get_log_path(task.id).read_text(encoding="utf-8")
    assert task.status == TaskStatus.done, log[-3000:]
    assert task.execution_backend == "sdk"
    assert task.sdk_version == "0.2.186"
    assert task.cli_version == "2.1.329"
    assert task.native_session_id == "11111111-1111-4111-8111-111111111111"
    assert task.tokens_input == 7
    assert task.tokens_output == 9
    assert task.cost_usd == pytest.approx(0.02)
    events = []
    for line in log.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict):
            events.append(event)
    assistant = next(event for event in events if event.get("type") == "assistant")
    assert len(assistant["message"]["content"][0]["text"]) > 2 * 1024 * 1024
    assert any(event.get("extra") == {"keep": "unknown-business-field"} for event in events)
    assert not any(event.get("sdk_host_only") or event.get("type", "").startswith("control_") for event in events)
    assert "control-secret" not in log


def test_persistent_sdk_task_runs_with_real_docker_and_sdk(harness: Harness) -> None:
    harness.start_persistent()

    async def run() -> Task:
        task = await harness.scheduler.submit("offline fixture", project_name=harness.project.name, model="fixture-model")
        return await completed(harness.scheduler, task)

    task = asyncio.run(run())
    assert_success(harness.scheduler, task)
    capture = json.loads((Path(harness.project.path) / "capture.json").read_text())
    assert capture["prompt"] == "offline fixture"
    assert capture["cwd"] == "/workspace"
    assert capture["task_id"] == task.id


def test_ephemeral_sdk_task_releases_its_container_after_completion(harness: Harness) -> None:
    async def run() -> Task:
        task = await harness.scheduler.submit(
            "ephemeral fixture", project_name=harness.project.name,
            execution_mode="ephemeral", model="fixture-model",
        )
        return await completed(harness.scheduler, task)

    task = asyncio.run(run())
    assert_success(harness.scheduler, task)
    assert task.ephemeral is True
    assert task.ephemeral_retention == "release_on_finish"
    assert task.ephemeral_container_name
    assert docker("container", "inspect", task.ephemeral_container_name, check=False).returncode != 0
    assert harness.scheduler.get_log_path(task.id).is_file()


@pytest.mark.parametrize("ephemeral", [False, True])
def test_sdk_error_result_is_a_failed_task_in_real_container(harness: Harness, ephemeral: bool) -> None:
    harness.scheduler.set_account_env(harness.project.account, {"FAKE_CLAUDE_RESULT_ERROR": "1"})
    if not ephemeral:
        harness.start_persistent()

    async def run() -> Task:
        task = await harness.scheduler.submit(
            "controlled SDK error", project_name=harness.project.name,
            execution_mode="ephemeral" if ephemeral else "persistent",
        )
        return await completed(harness.scheduler, task)

    task = asyncio.run(run())
    assert task.status == TaskStatus.failed
    assert task.execution_backend == "sdk"
    assert task.sdk_version == "0.2.186"
    assert task.native_session_id == "11111111-1111-4111-8111-111111111111"
    log = harness.scheduler.get_log_path(task.id).read_text()
    assert '"is_error": true' in log
    assert "[done]" not in log
    if ephemeral:
        assert docker("container", "inspect", task.ephemeral_container_name, check=False).returncode != 0


def test_retained_ephemeral_sdk_conversation_reuses_container_until_closed(harness: Harness) -> None:
    async def run() -> tuple[Task, Task, str]:
        first = await harness.scheduler.submit(
            "first retained fixture", project_name=harness.project.name,
            execution_mode="ephemeral", ephemeral_retention="keep_until_manual_close",
            model="fixture-model",
        )
        first = await completed(harness.scheduler, first)
        assert_success(harness.scheduler, first)
        container = first.ephemeral_container_name
        identity = docker("container", "inspect", "--format", "{{.Id}}", container).stdout.strip()
        second = await harness.scheduler.submit("second retained fixture", conversation_id=first.conversation_id)
        second = await completed(harness.scheduler, second)
        assert docker("container", "inspect", "--format", "{{.Id}}", container).stdout.strip() == identity
        return first, second, identity

    first, second, _identity = asyncio.run(run())
    assert_success(harness.scheduler, second)
    assert second.ephemeral_container_name == first.ephemeral_container_name
    capture = json.loads((Path(second.project) / "capture.json").read_text())
    assert capture["prompt"] == "second retained fixture"
    assert capture["options"]["resume"] == first.native_session_id
    assert harness.scheduler.close_ephemeral_conversation(first.conversation_id) is True
    assert docker("container", "inspect", first.ephemeral_container_name, check=False).returncode != 0
    assert harness.scheduler.get_log_path(first.id).is_file()
    assert harness.scheduler.get_log_path(second.id).is_file()


def test_expired_sdk_ephemeral_session_is_released_by_the_scheduler_loop(harness: Harness) -> None:
    async def run() -> Task:
        task = await harness.scheduler.submit(
            "TTL controlled fixture", project_name=harness.project.name,
            execution_mode="ephemeral", ephemeral_retention="keep_until_ttl",
            ephemeral_ttl_minutes=1,
        )
        task = await completed(harness.scheduler, task)
        assert_success(harness.scheduler, task)
        assert docker("container", "inspect", "--format", "{{.State.Running}}", task.ephemeral_container_name).stdout.strip() == "true"
        conversation = harness.scheduler.get_conversation(task.conversation_id)
        assert conversation and conversation.ephemeral_expires_at
        # Arrange an expired persisted record, then drive the public scheduler
        # loop rather than invoking the private expiry helper directly.
        conversation.ephemeral_expires_at = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
        conversation.save(harness.scheduler.conversations_dir)
        harness.scheduler.start_scheduling_loop()
        deadline = asyncio.get_running_loop().time() + 6
        while asyncio.get_running_loop().time() < deadline:
            current = harness.scheduler.get_conversation(task.conversation_id)
            if current and not current.ephemeral_container_name:
                break
            await asyncio.sleep(0.1)
        else:
            raise AssertionError("Expired SDK session container was not released")
        return task

    task = asyncio.run(run())
    assert docker("container", "inspect", task.ephemeral_container_name, check=False).returncode != 0
    assert harness.scheduler.get_log_path(task.id).is_file()
    saved = harness.scheduler.get_task(task.id)
    assert saved and saved.status == TaskStatus.done


@pytest.mark.parametrize("mode", ["persistent", "release", "keep"])
def test_stopping_sdk_task_cleans_owned_container_processes(harness: Harness, mode: str) -> None:
    harness.scheduler.set_account_env(harness.project.account, {
        "FAKE_CLAUDE_WAIT": "/home/byclaw/.claude/waiting.json",
    })
    container = harness.start_persistent() if mode == "persistent" else ""

    async def run() -> tuple[Task, str]:
        task = await harness.scheduler.submit(
            "long controlled tool", project_name=harness.project.name,
            execution_mode="persistent" if mode == "persistent" else "ephemeral",
            ephemeral_retention="keep_until_manual_close" if mode == "keep" else "release_on_finish",
        )
        waiting = harness.auth_dir / "waiting.json"
        deadline = asyncio.get_running_loop().time() + 10
        while asyncio.get_running_loop().time() < deadline:
            current = harness.scheduler.get_task(task.id)
            assert current and current.status == TaskStatus.running, harness.scheduler.get_log_path(task.id).read_text()[-2000:]
            if waiting.exists() and current.native_session_id:
                break
            await asyncio.sleep(0.05)
        assert waiting.exists(), harness.scheduler.get_log_path(task.id).read_text()[-2000:]
        current = harness.scheduler.get_task(task.id)
        assert current and current.native_session_id
        active_container = container or current.ephemeral_container_name
        pids = json.loads(waiting.read_text())
        stopped = await harness.scheduler.kill_task(task.id)
        assert stopped.status == TaskStatus.killed
        deadline = asyncio.get_running_loop().time() + 8
        while asyncio.get_running_loop().time() < deadline:
            inspection = docker("container", "inspect", active_container, check=False)
            if mode == "release" and inspection.returncode:
                break
            code = (
                "import json,pathlib; "
                f"pids={list(pids.values())!r}; "
                "print(json.dumps([p for p in pids if pathlib.Path('/proc/%s/stat'%p).exists() "
                "and pathlib.Path('/proc/%s/stat'%p).read_text().split()[2]!='Z']))"
            )
            probe = docker("exec", active_container, "python3", "-c", code, check=False)
            if probe.returncode == 0 and json.loads(probe.stdout) == []:
                break
            await asyncio.sleep(0.1)
        else:
            raise AssertionError(f"Owned processes were not cleaned: {pids}")
        await asyncio.sleep(0.1)
        saved = harness.scheduler.get_task(task.id)
        assert saved and saved.status == TaskStatus.killed
        assert saved.native_session_id == "11111111-1111-4111-8111-111111111111"
        return saved, active_container

    stopped, active_container = asyncio.run(run())
    if mode == "release":
        assert docker("container", "inspect", active_container, check=False).returncode != 0
    else:
        assert docker("container", "inspect", "--format", "{{.State.Running}}", active_container).stdout.strip() == "true"
    assert harness.scheduler.get_log_path(stopped.id).is_file()


def test_persistent_sdk_task_survives_watcher_process_restart_without_losing_output(harness: Harness) -> None:
    harness.scheduler.set_account_env(harness.project.account, {
        "FAKE_CLAUDE_GATE_READY": "/home/byclaw/.claude/gate-ready.json",
        "FAKE_CLAUDE_RELEASE_GATE": "/home/byclaw/.claude/release",
        "FAKE_CLAUDE_AFTER_OUTPUT_GATE": "/home/byclaw/.claude/finish",
    })
    harness.start_persistent()
    receipt = harness.scheduler.workspace_dir / "watcher-receipt.json"
    program = """
import asyncio,json,sys
from pathlib import Path
from coderfleet.server.runtime import DockerRuntime
from coderfleet.server.scheduler import Scheduler
async def main():
    scheduler=Scheduler(Path(sys.argv[1]),runtime=DockerRuntime())
    task=await scheduler.submit('restart controlled fixture',project_name=sys.argv[2])
    Path(sys.argv[3]).write_text(json.dumps({'task_id':task.id}))
    while True:
        await asyncio.sleep(1)
asyncio.run(main())
"""
    watcher = subprocess.Popen(
        [sys.executable, "-c", program, str(harness.scheduler.workspace_dir), harness.project.name, str(receipt)],
        cwd=Path(__file__).resolve().parents[1], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    try:
        deadline = time.monotonic() + 12
        task = None
        ready = harness.auth_dir / "gate-ready.json"
        while time.monotonic() < deadline:
            assert watcher.poll() is None
            if receipt.exists():
                task = harness.scheduler.get_task(json.loads(receipt.read_text())["task_id"])
                if ready.exists() and task and task.native_session_id and task.sdk_source_offset:
                    break
            time.sleep(0.05)
        assert task and task.native_session_id and ready.exists()
        assert task.status == TaskStatus.running
        cli_pid = json.loads(ready.read_text())["cli_pid"]
        state_path = Path(harness.project.path) / ".coderfleet-tasks" / f"{task.id}.sdk-state.json"
        worker_pid = json.loads(state_path.read_text())["pid"]
        watcher.terminate()
        watcher.wait(timeout=5)
        before_recovery = harness.scheduler.get_task(task.id)
        assert before_recovery and before_recovery.status == TaskStatus.running
        (harness.auth_dir / "release").touch()
        source = Path(harness.project.path) / ".coderfleet-tasks" / f"{task.id}.log"
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            lines = source.read_text(encoding="utf-8").splitlines()
            if any('"type": "assistant"' in line and line.endswith("}") for line in lines):
                break
            time.sleep(0.05)
        else:
            raise AssertionError("Worker did not continue writing while the host watcher was stopped")
        assert json.loads(state_path.read_text())["pid"] == worker_pid
        assert json.loads(ready.read_text())["cli_pid"] == cli_pid
        harness.scheduler.save_account(
            harness.project.account, CLAUDE, AccountAuth.env, AccountProxy.off, claude_backend="cli",
        )
        resumed = Scheduler(harness.scheduler.workspace_dir, runtime=OfflineDockerRuntime())

        async def recover() -> Task:
            assert task is not None
            assert await resumed.reconcile_running_tasks() == 1
            (harness.auth_dir / "finish").touch()
            return await completed(resumed, task)

        saved = asyncio.run(recover())
        assert_success(resumed, saved)
        assert len(resumed.list_tasks()) == 1
        assert json.loads(ready.read_text())["cli_pid"] == cli_pid
        events = []
        for line in resumed.get_log_path(saved.id).read_text().splitlines():
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if isinstance(event, dict):
                events.append(event)
        assert sum(event.get("type") == "assistant" for event in events) == 1
        assert sum(event.get("type") == "future_business_event" for event in events) == 1
        assert sum(event.get("subtype") == "coderfleet_backend" for event in events) == 1
    finally:
        if watcher.poll() is None:
            watcher.terminate()
            watcher.wait(timeout=5)
