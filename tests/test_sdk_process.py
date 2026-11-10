"""SDK ownership and cleanup through the public runtime control seam."""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import signal
import subprocess
import sys

import pytest

from coderfleet.server.runtime import ContainerSpec, FakeProcess, FakeRuntime, LocalRuntime
from coderfleet.server.sdk_process import _CONTROLLER, control_sdk_process


WORKER = '''import json, os, signal, sys, time
from pathlib import Path
if os.getpgrp() != os.getpid():
    os.setsid()
request = Path(sys.argv[sys.argv.index('--spec') + 1])
task_id = request.name.removesuffix('.sdk.json')
state = request.with_name(task_id + '.sdk-state.json')
signal.signal(signal.SIGTERM, lambda *args: None)
state.write_text(json.dumps({'task_id': task_id, 'pid': os.getpid(), 'pgid': os.getpgrp(), 'status': 'running'}))
print('ready', flush=True)
while True:
    time.sleep(1)
'''


ORPHAN_WORKER = '''import json, os, subprocess, sys, time
from pathlib import Path
os.setsid()
request = Path(sys.argv[sys.argv.index('--spec') + 1])
task_id = request.name.removesuffix('.sdk.json')
os.environ['CODERFLEET_TASK_ID'] = task_id
os.environ['CODERFLEET_SDK_OWNER_TOKEN'] = 'a' * 32
child_code = "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)" if 'ignore-term' in sys.argv else "import time; time.sleep(60)"
child_pid_path = request.with_suffix('.child-pid')
if 'clean-env-child' in sys.argv:
    grandchild_code = 'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)'
    child_code = ('import subprocess,sys,time; from pathlib import Path; '
                  'child=subprocess.Popen([sys.executable,"-I","-c",' + repr(grandchild_code) + '], env={}); '
                  'Path(' + repr(str(child_pid_path)) + ').write_text(str(child.pid)); time.sleep(60)')
child = subprocess.Popen([sys.executable, '-I', '-c', child_code], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
state = {'task_id': task_id, 'pid': os.getpid(), 'pgid': os.getpgrp(),
         'cli_pid': child.pid, 'ownership_token': 'a' * 32, 'status': 'running'}
request.with_name(task_id + '.sdk-state.json').write_text(json.dumps(state))
if 'clean-env-child' in sys.argv:
    while not child_pid_path.exists():
        time.sleep(0.01)
print('ready', flush=True)
while True:
    time.sleep(1)
'''


def _process_alive(pid: int) -> bool:
    stat_path = Path(f"/proc/{pid}/stat")
    if Path("/proc/self/stat").exists():
        try:
            return stat_path.read_text().rsplit(")", 1)[1].split()[0] != "Z"
        except FileNotFoundError:
            return False
    result = subprocess.run(["/bin/ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True)
    return result.returncode == 0 and bool(result.stdout.strip()) and "Z" not in result.stdout


@pytest.mark.parametrize("action", ["term", "kill"])
def test_controller_cleans_owned_cli_after_worker_is_killed(
    tmp_path: Path, action: str,
) -> None:
    script = tmp_path / "sdk-worker-2222222222222222.py"
    script.write_text(ORPHAN_WORKER)
    request = tmp_path / "orphan.sdk.json"
    request.write_text("{}")
    state = tmp_path / "orphan.sdk-state.json"
    runtime = LocalRuntime()

    async def drive() -> None:
        command = [sys.executable, "-I", str(script), "--spec", str(request)]
        if action == "kill":
            command.append("ignore-term")
        process = await runtime.run(ContainerSpec(
            image="", command=command, workdir=str(tmp_path),
        ))
        child_pid = 0
        try:
            assert await asyncio.wait_for(process.stdout.readline(), timeout=3) == b"ready\n"
            child_pid = json.loads(state.read_text())["cli_pid"]
            # SIGKILL bypasses the worker's own signal handlers/finally cleanup.
            process.kill()
            await asyncio.wait_for(process.wait(), timeout=3)
            worker_state = state.read_bytes()
            assert not await control_sdk_process(
                runtime, container="", state_path=str(state), task_id="orphan",
                action="probe_worker", local=True,
            )
            assert await control_sdk_process(
                runtime, container="", state_path=str(state), task_id="orphan", local=True,
            ), "A surviving managed CLI still occupies the Task"
            assert state.read_bytes() == worker_state
            await control_sdk_process(
                runtime, container="", state_path=str(state), task_id="orphan",
                action=action, local=True,
            )
            for _ in range(20):
                alive = await control_sdk_process(
                    runtime, container="", state_path=str(state), task_id="orphan", local=True,
                )
                if not alive:
                    break
                await asyncio.sleep(0.02)
            assert not alive
            assert not _process_alive(child_pid)
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()
            if child_pid:
                try:
                    os.kill(child_pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass

    asyncio.run(drive())


def test_controller_retains_verified_envless_descendant_after_both_parents_die(tmp_path: Path) -> None:
    script = tmp_path / "sdk-worker-3333333333333333.py"
    script.write_text(ORPHAN_WORKER)
    request = tmp_path / "descendants.sdk.json"
    request.write_text("{}")
    state = tmp_path / "descendants.sdk-state.json"
    runtime = LocalRuntime()

    async def drive() -> None:
        process = await runtime.run(ContainerSpec(
            image="", command=[sys.executable, "-I", str(script), "--spec", str(request), "clean-env-child"],
            workdir=str(tmp_path),
        ))
        children = []
        try:
            assert await asyncio.wait_for(process.stdout.readline(), timeout=3) == b"ready\n"
            child_pid = json.loads(state.read_text())["cli_pid"]
            grandchild_pid = int(request.with_suffix('.child-pid').read_text())
            children = [child_pid, grandchild_pid]
            process.kill()
            await asyncio.wait_for(process.wait(), timeout=3)
            assert await control_sdk_process(runtime, container="", state_path=str(state), task_id="descendants", local=True)
            os.kill(child_pid, signal.SIGKILL)
            await asyncio.sleep(0.05)
            assert _process_alive(grandchild_pid)
            final_state = {**json.loads(state.read_text()), "status": "failed"}
            state.write_text(json.dumps(final_state))
            # The grandchild cleared its environment; its proven OS identity must
            # survive losing both the worker and the token-bearing CLI parent.
            assert await control_sdk_process(runtime, container="", state_path=str(state), task_id="descendants", local=True)
            assert json.loads(state.read_text()) == final_state
            await control_sdk_process(runtime, container="", state_path=str(state), task_id="descendants", action="kill", local=True)
            for _ in range(20):
                if not _process_alive(grandchild_pid):
                    break
                await asyncio.sleep(0.02)
            assert not _process_alive(grandchild_pid)
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()
            for pid in children:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass

    asyncio.run(drive())


def test_controller_does_not_signal_saved_group_with_wrong_launch_token(tmp_path: Path) -> None:
    runtime = LocalRuntime()
    state = tmp_path / "wrong-token.sdk-state.json"

    async def drive() -> None:
        process = await runtime.run(ContainerSpec(
            image="", command=[sys.executable, "-I", "-c", "import time; time.sleep(60)",
                               "CODERFLEET_TASK_ID=wrong-token", "CODERFLEET_SDK_OWNER_TOKEN=" + "a" * 32],
            env={"CODERFLEET_TASK_ID": "wrong-token", "CODERFLEET_SDK_OWNER_TOKEN": "b" * 32},
            workdir=str(tmp_path),
        ))
        state.write_text(json.dumps({
            "task_id": "wrong-token", "pid": process.pid, "pgid": os.getpgid(process.pid),
            "cli_pid": process.pid, "ownership_token": "a" * 32, "status": "running",
        }))
        try:
            assert not await control_sdk_process(
                runtime, container="", state_path=str(state), task_id="wrong-token",
                action="kill", local=True, known_pid=process.pid,
            )
            assert process.returncode is None
            os.kill(process.pid, 0)
        finally:
            process.kill()
            await process.wait()

    asyncio.run(drive())


@pytest.mark.parametrize("action", ["term", "kill"])
def test_controller_revalidates_birth_before_signalling_and_preserves_newer_proof(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, action: str,
) -> None:
    """Controlled OS observations model PID reuse while a controller takes its lock."""
    state = tmp_path / "reused.sdk-state.json"
    token = "a" * 32
    state.write_text(json.dumps({"task_id": "reused", "pid": 7777, "pgid": 7777,
                                 "ownership_token": token}))
    sidecar = Path(str(state) + ".owned.json")
    # Another controller has already proved the replacement's newer identity.
    replacement_birth = "Mon Nov 9 00:00:01 2026"
    sidecar.write_text(json.dumps({"task_id": "reused", "ownership_token": token,
                                  "owned_processes": [{"pid": 7777, "birth": replacement_birth}]}))
    worker_args = f"{sys.executable} -I {tmp_path}/sdk-worker-4444444444444444.py --spec {tmp_path}/reused.sdk.json"
    observations = 0

    def observe(command, **kwargs):
        nonlocal observations
        if command[-1] == "pid=,ppid=,pgid=,stat=,lstart=,args=":
            observations += 1
            birth = "Mon Nov 9 00:00:00 2026" if observations == 1 else replacement_birth
            args = worker_args if observations == 1 else "python -c unrelated"
            output = (f"7777 1 7777 S {birth} {args}\n"
                      f"{os.getpid()} 1 {os.getpgrp()} S Mon Nov 9 00:00:00 2026 python controller\n")
        else:
            output = (f"7777 {worker_args} CODERFLEET_TASK_ID=reused CODERFLEET_SDK_OWNER_TOKEN={token}\n"
                      if observations == 1 else "7777 python -c unrelated\n")
        return subprocess.CompletedProcess(command, 0, stdout=output, stderr="")

    original_is_file = Path.is_file
    monkeypatch.setattr(Path, "is_file", lambda path: False if str(path) == "/proc/self/stat" else original_is_file(path))
    monkeypatch.setattr(subprocess, "run", observe)
    monkeypatch.setattr(sys, "argv", ["controller", str(state), "reused", action, "0"])
    signals = []
    monkeypatch.setattr(os, "kill", lambda pid, signum: signals.append((pid, signum)))
    exec(_CONTROLLER, {"__name__": "__main__"})
    assert signals == []
    assert json.loads(sidecar.read_text())["owned_processes"] == [
        {"pid": 7777, "birth": replacement_birth},
    ]


def test_controller_finds_preflight_worker_without_state_and_force_cleans_it(tmp_path: Path) -> None:
    script = tmp_path / "sdk-worker-1111111111111111.py"
    script.write_text(WORKER)
    request = tmp_path / "owned.sdk.json"
    request.write_text("{}")
    state = tmp_path / "owned.sdk-state.json"
    runtime = LocalRuntime()

    async def drive() -> None:
        process = await runtime.run(ContainerSpec(
            image="", command=[sys.executable, "-I", str(script), "--spec", str(request)],
            name="worker", workdir=str(tmp_path),
        ))
        try:
            assert await asyncio.wait_for(process.stdout.readline(), timeout=3) == b"ready\n"
            assert await control_sdk_process(runtime, container="ignored", state_path=str(state), task_id="owned", local=True)
            state.unlink()
            assert await control_sdk_process(runtime, container="ignored", state_path=str(state), task_id="owned", local=True)
            assert await control_sdk_process(runtime, container="ignored", state_path=str(state), task_id="owned", action="term", local=True)
            assert runtime.is_running("worker")
            await control_sdk_process(runtime, container="ignored", state_path=str(state), task_id="owned", action="kill", local=True)
            await asyncio.wait_for(process.wait(), timeout=3)
            assert not await control_sdk_process(runtime, container="ignored", state_path=str(state), task_id="owned", local=True)
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()

    asyncio.run(drive())


def test_controller_does_not_trust_reused_state_pid_or_signal_unrelated_python(tmp_path: Path) -> None:
    runtime = LocalRuntime()
    state = tmp_path / "other.sdk-state.json"

    async def drive() -> None:
        process = await runtime.run(ContainerSpec(
            image="", command=[sys.executable, "-I", "-c", "import time; time.sleep(30)"],
            name="unrelated", workdir=str(tmp_path),
        ))
        state.write_text(json.dumps({"task_id": "other", "pid": process.pid, "pgid": process.pid, "status": "running"}))
        try:
            assert not await control_sdk_process(runtime, container="", state_path=str(state), task_id="other", action="kill", local=True, known_pid=process.pid)
            assert runtime.is_running("unrelated")
        finally:
            process.kill()
            await process.wait()

    asyncio.run(drive())


def test_python_command_wrapper_is_not_mistaken_for_a_worker(tmp_path: Path) -> None:
    runtime = LocalRuntime()
    state = tmp_path / "wrapped.sdk-state.json"
    script = tmp_path / "sdk-worker-1111111111111111.py"
    request = tmp_path / "wrapped.sdk.json"

    async def drive() -> None:
        process = await runtime.run(ContainerSpec(
            image="", command=[sys.executable, "-I", "-c", "import time; time.sleep(30)",
                               "python", str(script), "--spec", str(request)],
            name="wrapper", workdir=str(tmp_path),
        ))
        state.write_text(json.dumps({"task_id": "wrapped", "pid": process.pid}))
        try:
            assert not await control_sdk_process(runtime, container="", state_path=str(state), task_id="wrapped", action="kill", local=True)
            await asyncio.sleep(0.05)
            assert process.returncode is None
        finally:
            if process.returncode is None:
                process.kill()
            await process.wait()

    asyncio.run(drive())


def test_worker_like_executable_suffix_does_not_prove_python_ownership(tmp_path: Path) -> None:
    runtime = LocalRuntime()
    executable = tmp_path / "notpython"
    executable.symlink_to(sys.executable)
    script = tmp_path / "sdk-worker-1111111111111111.py"
    script.write_text(WORKER)
    request = tmp_path / "suffix.sdk.json"
    request.write_text("{}")
    state = tmp_path / "suffix.sdk-state.json"

    async def drive() -> None:
        process = await runtime.run(ContainerSpec(
            image="", command=[str(executable), "-I", str(script), "--spec", str(request)],
            name="suffix", workdir=str(tmp_path),
        ))
        try:
            assert await asyncio.wait_for(process.stdout.readline(), timeout=3) == b"ready\n"
            assert not await control_sdk_process(runtime, container="", state_path=str(state), task_id="suffix", action="kill", local=True)
            await asyncio.sleep(0.05)
            assert process.returncode is None
        finally:
            if process.returncode is None:
                process.kill()
            await process.wait()

    asyncio.run(drive())


@pytest.mark.parametrize("payload,returncode", [(b'not json', 0), (b'{"alive":"false"}', 0), (b'{"alive":false}', 1)])
def test_controller_observation_failure_is_not_reported_as_dead(payload: bytes, returncode: int) -> None:
    runtime = FakeRuntime().queue(FakeProcess(stdout_chunks=[payload], returncode=returncode))

    async def drive() -> None:
        with pytest.raises(RuntimeError):
            await control_sdk_process(runtime, container="sdk-project", state_path="/workspace/.coderfleet-tasks/task.sdk-state.json", task_id="task")

    asyncio.run(drive())


@pytest.mark.parametrize("message", [
    "Error response from daemon: No such container: sdk-project",
    "Error response from daemon: Container sdk-project is not running",
    "Error response from daemon: Container " + "a" * 64 + " is not running",
])
def test_confirmed_missing_or_stopped_container_proves_worker_is_dead(message: str) -> None:
    runtime = FakeRuntime().queue(FakeProcess(stdout_chunks=[message.encode()], returncode=1))
    assert not asyncio.run(control_sdk_process(
        runtime, container="sdk-project", state_path="/workspace/.coderfleet-tasks/task.sdk-state.json", task_id="task",
    ))


@pytest.mark.parametrize("message", [
    "Error response from daemon: No such container: unrelated-project",
    "Cannot connect to the Docker daemon at unix:///run/docker.sock",
    "permission denied while trying to connect to the Docker daemon",
])
def test_unrelated_container_or_docker_observation_errors_remain_unknown(message: str) -> None:
    runtime = FakeRuntime().queue(FakeProcess(stdout_chunks=[message.encode()], returncode=1))
    with pytest.raises(RuntimeError):
        asyncio.run(control_sdk_process(
            runtime, container="sdk-project", state_path="/workspace/.coderfleet-tasks/task.sdk-state.json", task_id="task",
        ))
