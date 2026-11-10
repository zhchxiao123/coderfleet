"""Opt-in real LocalRuntime + real SDK with an offline, controlled CLI."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

from coderfleet.server.models import AccountAuth, AccountProxy, AccountRuntime, AccountType, Project, Task, TaskStatus
from coderfleet.server.runtime import LocalRuntime
from coderfleet.server.scheduler import Scheduler
from coderfleet.server.sdk_process import control_sdk_process


SDK_PYTHON = os.environ.get("CODERFLEET_TEST_SDK_PYTHON", "")
pytestmark = pytest.mark.skipif(not SDK_PYTHON, reason="Set CODERFLEET_TEST_SDK_PYTHON for offline real-SDK local acceptance")
PROTOCOL = Path(__file__).parent / "fixtures/claude_sdk_protocol_cli.py"


@dataclass
class LocalHarness:
    scheduler: Scheduler
    runtime: LocalRuntime
    project: Project
    auth_root: Path
    capture: Path


@pytest.fixture
def local_harness(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root = tmp_path / "fleet"
    root.mkdir()
    (root / "config.conf").write_text("TASK_AUTO_RETRY=off DIGEST_ENABLED=off DOCKER_SOCKET=off\n")
    runtime = LocalRuntime()
    scheduler = Scheduler(root, local_runtime=runtime)
    account = scheduler.save_account("local-one", AccountType.claude, AccountAuth.env, AccountProxy.off,
                                     runtime=AccountRuntime.local, claude_backend="sdk")
    auth_root = scheduler.local_auth_dir(account)
    cli = tmp_path / "claude-local-fixture"
    # This wrapper only simulates the native transcript side effect of the CLI.
    # It does not modify the shared protocol fixture or read existing credentials.
    cli.write_text(
        f"#!{sys.executable}\n"
        "import builtins, json, os, runpy, sys, uuid\n"
        "from pathlib import Path\n"
        "original_print = builtins.print\n"
        "def print_with_transcript(*values, **kwargs):\n"
        "    if len(values) == 1 and isinstance(values[0], str) and kwargs.get('file', sys.stdout) is sys.stdout:\n"
        "        try: event = json.loads(values[0])\n"
        "        except ValueError: event = None\n"
        "        if isinstance(event, dict) and event.get('type') == 'assistant':\n"
        "            event['uuid'] = str(uuid.uuid4())\n"
        "            transcript = Path(os.environ['CLAUDE_CONFIG_DIR']) / 'projects' / '-fixture' / (event['session_id'] + '.jsonl')\n"
        "            transcript.parent.mkdir(parents=True, exist_ok=True)\n"
        "            with transcript.open('a') as stream: stream.write(json.dumps(event) + '\\n')\n"
        "            values = (json.dumps(event, ensure_ascii=False),)\n"
        "    return original_print(*values, **kwargs)\n"
        "builtins.print = print_with_transcript\n"
        f"runpy.run_path({str(PROTOCOL)!r}, run_name='__main__')\n",
        encoding="utf-8",
    )
    cli.chmod(0o755)
    capture = tmp_path / "capture.json"
    scheduler.set_account_env(account.name, {
        "CODERFLEET_CLAUDE_SDK_PYTHON": os.path.abspath(SDK_PYTHON),
        "CODERFLEET_CLAUDE_CLI_PATH": str(cli),
        "FAKE_CLAUDE_CAPTURE": str(capture), "FAKE_ACCOUNT_MARKER": "local-one",
        "ANTHROPIC_API_KEY": "fixture-never-sent",
    })
    repo = tmp_path / "ordinary-project"
    repo.mkdir()
    project = scheduler.save_project("repo", account.name, str(repo))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "unrelated-global-claude"))
    harness = LocalHarness(scheduler, runtime, project, auth_root, capture)
    try:
        yield harness
    finally:
        async def cleanup() -> None:
            for task in scheduler.list_tasks():
                state = Path(task.project) / ".coderfleet-tasks" / f"{task.id}.sdk-state.json"
                try:
                    await control_sdk_process(runtime, container="", state_path=str(state), task_id=task.id,
                                              action="kill", local=True, known_pid=int(task.pid or "0"))
                except RuntimeError:
                    pass
        asyncio.run(cleanup())


async def completed(scheduler: Scheduler, task: Task) -> Task:
    deadline = asyncio.get_running_loop().time() + 20
    while asyncio.get_running_loop().time() < deadline:
        current = scheduler.get_task(task.id)
        if current and current.status in (TaskStatus.done, TaskStatus.failed, TaskStatus.killed) and current.terminal_notified:
            return current
        await asyncio.sleep(0.03)
    raise AssertionError(f"Task did not complete: {scheduler.get_log_path(task.id).read_text()[-1500:]}")


def test_local_ordinary_project_uses_real_sdk_and_keeps_large_unicode_metadata(local_harness: LocalHarness) -> None:
    h = local_harness

    async def drive() -> Task:
        task = await h.scheduler.submit("本地普通项目问答", project_name=h.project.name, conversation_name="Ordinary", model="fixture-model")
        return await completed(h.scheduler, task)

    task = asyncio.run(drive())
    log = h.scheduler.get_log_path(task.id).read_text()
    assert task.status == TaskStatus.done, log[-1500:]
    assert (task.sdk_version, task.cli_version) == ("0.2.180", "2.1.321")
    assert (task.tokens_input, task.tokens_output, task.cost_usd) == (7, 9, 0.02)
    assert task.project == h.project.path
    assert h.scheduler.get_conversation(task.conversation_id).ephemeral is False
    capture = json.loads(h.capture.read_text())
    assert capture["cwd"] == h.project.path
    assert capture["task_id"] == task.id
    assert capture["prompt"] == "本地普通项目问答"
    assert capture["claude_config_dir"] == str(h.auth_root)
    assert capture["account_marker"] == "local-one"
    events = [json.loads(line) for line in log.splitlines() if line.startswith('{')]
    assistant = next(event for event in events if event["type"] == "assistant")
    assert assistant["message"]["content"][0]["text"].startswith("中文 ")
    assert len(assistant["message"]["content"][0]["text"]) > 2 * 1024 * 1024
    assert assistant["message"]["content"][0]["citations"] == [{"type": "fixture-citation"}]
    assert "control-secret" not in log


def test_local_real_sdk_resumes_and_forks_from_the_accounts_native_transcript(local_harness: LocalHarness) -> None:
    h = local_harness

    async def drive():
        first = await completed(h.scheduler, await h.scheduler.submit("first", project_name=h.project.name, conversation_name="Source"))
        second = await completed(h.scheduler, await h.scheduler.submit("second", conversation_id=first.conversation_id))
        resume_capture = json.loads(h.capture.read_text())
        transcript = h.auth_root / "projects/-fixture" / f"{first.native_session_id}.jsonl"
        before = transcript.read_bytes()
        child = h.scheduler.fork_conversation(first.conversation_id, first.id, name="Alternative")
        branch = await completed(h.scheduler, await h.scheduler.submit("branch", conversation_id=child.id))
        return first, second, child, branch, resume_capture, before, transcript.read_bytes()

    first, second, child, branch, resume_capture, before, after = asyncio.run(drive())
    assert all(task.status == TaskStatus.done for task in (first, second, branch))
    assert second.native_session_id == first.native_session_id
    assert resume_capture["options"]["resume"] == first.native_session_id
    assert child.fork is not None
    assert branch.native_session_id == child.fork.target_session_id != first.native_session_id
    assert child.fork.inherited_task_ids == [first.id]
    assert before == after
    fork_capture = json.loads(h.capture.read_text())
    assert fork_capture["options"]["fork_session"] is True
    assert fork_capture["options"]["resume_session_at"] == child.fork.message_uuid
    assert fork_capture["options"]["session_id"] == child.fork.target_session_id


def test_local_stop_waits_for_real_worker_and_cli_children_to_exit(local_harness: LocalHarness, tmp_path: Path) -> None:
    h = local_harness
    child_file = tmp_path / "children.json"
    h.scheduler.set_account_env(h.project.account, {"FAKE_CLAUDE_WAIT": str(child_file)})

    async def drive() -> tuple[Task, dict]:
        task = await h.scheduler.submit("long local tool", project_name=h.project.name, conversation_name="Stop")
        deadline = asyncio.get_running_loop().time() + 10
        while not child_file.exists() and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.03)
        assert child_file.exists(), h.scheduler.get_log_path(task.id).read_text()[-1500:]
        saved = h.scheduler.get_task(task.id)
        state = json.loads((Path(task.project) / ".coderfleet-tasks" / f"{task.id}.sdk-state.json").read_text())
        assert state["pid"] == int(saved.pid), "Task PID must identify the worker, not an outer bash wrapper"
        children = json.loads(child_file.read_text())
        result = await h.scheduler.kill_task(task.id)
        return result, children

    result, children = asyncio.run(drive())
    assert result.status == TaskStatus.killed
    for pid in children.values():
        observed = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True, timeout=3)
        assert not observed.stdout.strip() or observed.stdout.strip().startswith("Z"), f"owned process {pid} still executes"


def test_local_worker_crash_cleans_cli_and_tool_children_before_failing_task(local_harness: LocalHarness, tmp_path: Path) -> None:
    h = local_harness
    child_file = tmp_path / "crashed-worker-children.json"
    h.scheduler.set_account_env(h.project.account, {"FAKE_CLAUDE_WAIT": str(child_file)})

    async def drive() -> tuple[Task, dict]:
        task = await h.scheduler.submit("crash fixture", project_name=h.project.name, conversation_name="Crash")
        deadline = asyncio.get_running_loop().time() + 10
        while not child_file.exists() and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.03)
        assert child_file.exists()
        saved = h.scheduler.get_task(task.id)
        children = json.loads(child_file.read_text())
        os.kill(int(saved.pid), 9)
        return await completed(h.scheduler, task), children

    task, children = asyncio.run(drive())
    assert task.status == TaskStatus.failed
    for pid in children.values():
        observed = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True, timeout=3)
        assert not observed.stdout.strip() or observed.stdout.strip().startswith("Z"), f"orphan process {pid} still executes"


@pytest.mark.parametrize("gate", ["sandbox", "root"])
def test_local_sdk_auto_keeps_existing_sandbox_and_root_gates(local_harness: LocalHarness, monkeypatch: pytest.MonkeyPatch, gate: str) -> None:
    h = local_harness
    account = h.scheduler.get_accounts()[0]
    h.scheduler.save_account(account.name, account.type, account.auth, account.proxy,
                             runtime=account.runtime, claude_backend="sdk", sandbox_confirmed=gate == "root")
    if gate == "root":
        monkeypatch.setattr(Scheduler, "_running_as_root", staticmethod(lambda: True))

    async def drive() -> Task:
        return await completed(h.scheduler, await h.scheduler.submit("must not start", project_name=h.project.name, auto=True))

    task = asyncio.run(drive())
    assert task.status == TaskStatus.failed
    assert not h.capture.exists()
    log = h.scheduler.get_log_path(task.id).read_text()
    assert "沙箱" in log if gate == "sandbox" else "root" in log
