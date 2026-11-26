"""Exercise the SDK worker through its standalone process interface."""

from __future__ import annotations

from contextlib import suppress
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

import pytest

from coderfleet.claude_sdk import build_worker_command
from coderfleet.account_type_registry import claude_mcp_options


WORKER = Path(__file__).resolve().parents[1] / "coderfleet/data/scripts/coderfleet_claude_sdk_worker.py"


def test_doctor_reports_unavailable_without_sdk_instead_of_using_host_cli() -> None:
    result = subprocess.run(
        [sys.executable, "-S", str(WORKER), "--doctor"],
        capture_output=True, text=True, timeout=10,
        env={**os.environ, "PYTHONPATH": ""},
    )
    report = json.loads(result.stdout)
    assert result.returncode != 0
    assert report["ready"] is False
    assert report["execution_backend"] == "sdk"
    assert report["sdk_version"] == ""
    assert "claude-agent-sdk" in report["error"]
    assert "Traceback" not in result.stdout


def test_invalid_spec_fails_before_sdk_import_without_echoing_values(tmp_path: Path) -> None:
    request = tmp_path / "request.json"
    request.write_text(json.dumps({"task_id": "t1", "prompt": "private prompt", "cwd": str(tmp_path), "auto": "secret-not-a-bool"}))
    result = subprocess.run(
        [sys.executable, "-S", str(WORKER), "--spec", str(request)],
        capture_output=True, text=True, timeout=10,
    )
    event = json.loads(result.stdout)
    assert result.returncode == 2
    assert event["type"] == "result"
    assert event["subtype"] == "error_during_execution"
    assert event["is_error"] is True
    assert "auto must be a boolean" in event["result"]
    assert "private prompt" not in result.stdout + result.stderr
    assert "secret-not-a-bool" not in result.stdout + result.stderr


def test_missing_sdk_task_has_visible_failure_without_fake_session_identity(tmp_path: Path) -> None:
    request = tmp_path / "request.json"
    request.write_text(json.dumps({
        "task_id": "missing-sdk", "prompt": "private prompt", "cwd": str(tmp_path),
        "session_id": "33333333-3333-4333-8333-333333333333",
        "fork_session_id": "44444444-4444-4444-8444-444444444444",
        "resume_session_at": "55555555-5555-4555-8555-555555555555",
        "mcp_options": claude_mcp_options(allow_ask_user=True),
    }))
    result = subprocess.run([sys.executable, "-S", str(WORKER), "--spec", str(request)], capture_output=True, text=True, timeout=10)
    events = [json.loads(line) for line in result.stdout.splitlines()]
    assert result.returncode == 1
    assert len(events) == 1
    event = events[0]
    assert event["type"] == "result"
    assert event["subtype"] == "error_during_execution"
    assert event["is_error"] is True
    assert event["coderfleet_synthetic"] is True
    assert "claude-agent-sdk" in event["result"]
    assert not {"session_id", "usage", "cost_usd", "total_cost_usd"} & event.keys()
    assert "33333333" not in result.stdout
    assert "44444444" not in result.stdout
    assert "private prompt" not in result.stdout


@pytest.fixture
def sdk_python() -> str:
    selected = os.environ.get("CODERFLEET_TEST_SDK_PYTHON", "")
    if not selected:
        pytest.skip("Set CODERFLEET_TEST_SDK_PYTHON to the isolated SDK test environment")
    return selected


@pytest.fixture
def fake_cli(tmp_path: Path) -> Path:
    cli = tmp_path / "claude-fixture"
    cli.write_text(
        f"#!{sys.executable}\n" + (Path(__file__).parent / "fixtures/claude_sdk_protocol_cli.py").read_text(encoding="utf-8"), encoding="utf-8",
    )
    cli.chmod(0o755)
    return cli


def run_sdk_task(tmp_path: Path, sdk_python: str, fake_cli: Path, *, spec_changes: dict | None = None, **changes: object) -> tuple[subprocess.CompletedProcess[str], list[dict], dict]:
    spec = {
        "task_id": "worker-fixture", "prompt": "read my context", "cwd": str(tmp_path),
        "model": "fixture-model", "auto": False, "append_system_prompt": "File delivery hint",
        "images": ["/workspace/example.png"], "diagnostic_path": str(tmp_path / "diagnostic.log"),
        "state_path": str(tmp_path / "state.json"),
        "mcp_options": claude_mcp_options(allow_ask_user=not bool((spec_changes or {}).get("auto", False))),
        **(spec_changes or {}),
    }
    request = tmp_path / "request with spaces.json"
    request.write_text(json.dumps(spec), encoding="utf-8")
    env = {
        **os.environ, "CODERFLEET_CLAUDE_CLI_PATH": str(fake_cli),
        "CODERFLEET_CLAUDE_SDK_PYTHON": os.path.abspath(sdk_python),
        "FAKE_CLAUDE_CAPTURE": str(tmp_path / "capture.json"),
        "CODERFLEET_RELAY_IP": "127.0.0.2", "CODERFLEET_MCP_BRIDGE_PORT": "8765",
        **{key: str(value) for key, value in changes.items()},
    }
    command = build_worker_command(request, WORKER, "coderfleet-task-worker-fixture", local=True)
    result = subprocess.run(["bash", "-c", command], capture_output=True, text=True, timeout=20, env=env)
    events = [json.loads(line) for line in result.stdout.splitlines()]
    capture_path = tmp_path / "capture.json"
    capture = json.loads(capture_path.read_text()) if capture_path.exists() else {}
    return result, events, capture


def test_worker_runs_real_sdk_and_preserves_raw_business_events(tmp_path: Path, sdk_python: str, fake_cli: Path) -> None:
    result, events, capture = run_sdk_task(tmp_path, sdk_python, fake_cli)
    diagnostic = tmp_path / "diagnostic.log"
    assert result.returncode == 0, result.stdout + result.stderr + (diagnostic.read_text() if diagnostic.exists() else "")
    assert events[0]["subtype"] == "coderfleet_backend"
    assert events[0]["sdk_version"] == "0.2.186"
    assistant = next(event for event in events if event["type"] == "assistant")
    assert assistant["message"]["content"][0]["citations"] == [{"type": "fixture-citation"}]
    assert len(assistant["message"]["content"][0]["text"]) > 2 * 1024 * 1024
    assert any(event.get("extra") == {"keep": "unknown-business-field"} for event in events)
    assert not any(event.get("sdk_host_only") or event["type"].startswith("control_") for event in events)
    assert "control-secret" not in result.stdout
    assert capture["prompt"] == "read my context\n\n[Attached images:\n/workspace/example.png]"
    assert capture["task_id"] == "worker-fixture"
    assert capture["cwd"] == str(tmp_path)
    assert capture["options"]["permission_mode"] == "acceptEdits"
    assert capture["options"]["model"] == "fixture-model"
    assert capture["options"]["setting_sources"] == "user,project,local"
    assert "fixture diagnostic on stderr" not in result.stdout
    assert "fixture diagnostic on stderr" in diagnostic.read_text()


@pytest.mark.parametrize("mode,expected_code,expected_status", [("FAKE_CLAUDE_RESULT_ERROR", 1, "failed"), ("FAKE_CLAUDE_ABORT", 143, "cancelled")])
def test_sdk_error_or_cancel_result_does_not_become_success(
    tmp_path: Path, sdk_python: str, fake_cli: Path, mode: str, expected_code: int, expected_status: str,
) -> None:
    result, events, _ = run_sdk_task(tmp_path, sdk_python, fake_cli, **{mode: "1"})
    assert result.returncode == expected_code
    assert any(event["type"] == "result" for event in events)
    assert len([event for event in events if event["type"] == "result"]) == 1
    state = json.loads((tmp_path / "state.json").read_text())
    assert state["status"] == expected_status


@pytest.mark.parametrize("without_process_tools", [False, True])
def test_sigterm_stops_worker_and_owned_cli_children(tmp_path: Path, sdk_python: str, fake_cli: Path, without_process_tools: bool) -> None:
    request = tmp_path / "request.json"
    request.write_text(json.dumps({
        "task_id": "stop-fixture", "prompt": "run a long tool", "cwd": str(tmp_path),
        "state_path": str(tmp_path / "state.json"), "diagnostic_path": str(tmp_path / "diagnostic.log"),
        "mcp_options": claude_mcp_options(allow_ask_user=True),
    }))
    command = build_worker_command(request, WORKER, "coderfleet-task-stop-fixture", local=True)
    env = {
        **os.environ, "CODERFLEET_CLAUDE_SDK_PYTHON": os.path.abspath(sdk_python),
        "CODERFLEET_CLAUDE_CLI_PATH": str(fake_cli), "FAKE_CLAUDE_CAPTURE": str(tmp_path / "capture.json"),
        "FAKE_CLAUDE_WAIT": str(tmp_path / "child.json"),
        **({"PATH": "/missing-tools"} if without_process_tools else {}),
    }
    process = subprocess.Popen(["/bin/bash", "-c", command], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    try:
        deadline = time.monotonic() + 8
        while not (tmp_path / "child.json").exists() and time.monotonic() < deadline:
            assert process.poll() is None
            time.sleep(0.05)
        children = json.loads((tmp_path / "child.json").read_text())
        process.terminate()
        stdout, stderr = process.communicate(timeout=8)
        assert process.returncode == 143, stdout + stderr
        assert json.loads((tmp_path / "state.json").read_text())["status"] == "cancelled"
        for pid in children.values():
            result = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True)
            assert not result.stdout.strip() or result.stdout.strip().startswith("Z"), f"owned process {pid} is still running"
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        child_file = tmp_path / "child.json"
        if child_file.exists():
            for pid in json.loads(child_file.read_text()).values():
                with suppress(ProcessLookupError):
                    os.kill(pid, signal.SIGKILL)


def test_auto_fork_keeps_checkpoint_and_mcp_identity(tmp_path: Path, sdk_python: str, fake_cli: Path) -> None:
    result, _events, capture = run_sdk_task(tmp_path, sdk_python, fake_cli, spec_changes={
        "auto": True, "session_id": "33333333-3333-4333-8333-333333333333",
        "fork_session_id": "44444444-4444-4444-8444-444444444444",
        "resume_session_at": "55555555-5555-4555-8555-555555555555",
    })
    assert result.returncode == 0
    options = capture["options"]
    assert options["permission_mode"] == "bypassPermissions"
    assert options["resume"] == "33333333-3333-4333-8333-333333333333"
    assert options["fork_session"] is True
    assert options["session_id"] == "44444444-4444-4444-8444-444444444444"
    assert options["resume_session_at"] == "55555555-5555-4555-8555-555555555555"
    assert options["disallowedTools"] == "mcp__coderfleet__ask_user_question"
    bridge = json.loads(options["mcp_config"])["mcpServers"]["coderfleet"]
    assert bridge == {"type": "http", "url": "http://${CODERFLEET_RELAY_IP:-127.0.0.1}:${CODERFLEET_MCP_BRIDGE_PORT:-0}/mcp/", "headers": {"X-CoderFleet-Task-Id": "${CODERFLEET_TASK_ID}"}}
    assert capture["task_id"] == "worker-fixture"


def test_stop_during_preflight_records_identity_and_never_starts_query(tmp_path: Path, sdk_python: str, fake_cli: Path) -> None:
    request = tmp_path / "request.json"
    request.write_text(json.dumps({"task_id": "preflight-stop", "prompt": "must not run", "cwd": str(tmp_path), "state_path": str(tmp_path / "state.json"), "mcp_options": claude_mcp_options(allow_ask_user=True)}))
    env = {
        **os.environ, "CODERFLEET_CLAUDE_SDK_PYTHON": os.path.abspath(sdk_python),
        "CODERFLEET_CLAUDE_CLI_PATH": str(fake_cli), "FAKE_CLAUDE_SLOW_VERSION": str(tmp_path / "version.json"),
        "FAKE_CLAUDE_CAPTURE": str(tmp_path / "capture.json"),
    }
    process = subprocess.Popen(["bash", "-c", build_worker_command(request, WORKER, "coderfleet-task-preflight-stop", local=True)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    try:
        deadline = time.monotonic() + 8
        while not (tmp_path / "version.json").exists() and time.monotonic() < deadline:
            assert process.poll() is None
            time.sleep(0.05)
        state = json.loads((tmp_path / "state.json").read_text())
        assert state["status"] == "starting"
        assert state["pid"] == process.pid
        assert state["pgid"] == process.pid
        process.terminate()
        process.communicate(timeout=5)
        assert process.returncode == 143
        assert json.loads((tmp_path / "state.json").read_text())["status"] == "cancelled"
        assert not (tmp_path / "capture.json").exists()
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)


def test_first_result_does_not_close_stdin_or_finish_background_agent_turns(tmp_path: Path, sdk_python: str, fake_cli: Path) -> None:
    request = tmp_path / "request.json"
    request.write_text(json.dumps({
        "task_id": "background-fixture", "prompt": "delegate controlled work", "cwd": str(tmp_path),
        "state_path": str(tmp_path / "state.json"), "mcp_options": claude_mcp_options(allow_ask_user=True),
    }))
    output = tmp_path / "events.jsonl"
    gate = tmp_path / "release-background"
    first_result = tmp_path / "first-result"
    early_eof = tmp_path / "early-eof"
    env = {
        **os.environ, "CODERFLEET_CLAUDE_SDK_PYTHON": os.path.abspath(sdk_python),
        "CODERFLEET_CLAUDE_CLI_PATH": str(fake_cli), "FAKE_CLAUDE_CAPTURE": str(tmp_path / "capture.json"),
        "FAKE_CLAUDE_BACKGROUND_GATE": str(gate), "FAKE_CLAUDE_FIRST_RESULT_READY": str(first_result),
        "FAKE_CLAUDE_EARLY_EOF": str(early_eof),
    }
    with output.open("w") as stream:
        process = subprocess.Popen(["/bin/bash", "-c", build_worker_command(request, WORKER, "coderfleet-task-background-fixture", local=True)], stdout=stream, stderr=subprocess.PIPE, text=True, env=env)
        try:
            deadline = time.monotonic() + 8
            while not first_result.exists() and time.monotonic() < deadline:
                assert process.poll() is None
                time.sleep(0.05)
            assert first_result.exists()
            time.sleep(0.2)
            assert process.poll() is None
            assert not early_eof.exists()
            assert json.loads((tmp_path / "state.json").read_text())["status"] == "running"
            events = [json.loads(line) for line in output.read_text().splitlines()]
            assert len([event for event in events if event["type"] == "result"]) == 1
            gate.write_text("background may complete")
            _stdout, stderr = process.communicate(timeout=10)
            assert process.returncode == 0, stderr
            events = [json.loads(line) for line in output.read_text().splitlines()]
            results = [event for event in events if event["type"] == "result"]
            assert len(results) == 2
            assert results[-1]["result"] == "background follow-up answer"
            assert not early_eof.exists()
            assert json.loads((tmp_path / "state.json").read_text())["status"] == "done"
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)


@pytest.mark.parametrize("auto", [False, True])
def test_native_permission_fallback_denies_without_changing_preapproved_mcp_rules(tmp_path: Path, sdk_python: str, fake_cli: Path, auto: bool) -> None:
    probe = tmp_path / "permission-decisions.json"
    result, _events, capture = run_sdk_task(tmp_path, sdk_python, fake_cli, spec_changes={"auto": auto}, FAKE_CLAUDE_PERMISSION_PROBE=probe)
    assert result.returncode == 0
    decisions = json.loads(probe.read_text())
    assert decisions["UnapprovedTool"]["behavior"] == "deny"
    assert decisions["AskUserQuestion"]["behavior"] == "deny"
    assert "permission-input-must-not-leak" not in result.stdout
    assert capture["options"]["permission_prompt_tool"] == "stdio"
    allowed = capture["options"]["allowedTools"].split(",")
    assert "mcp__coderfleet__schedule_continuation" in allowed
    assert ("mcp__coderfleet__ask_user_question" in allowed) is not auto
    expected_mode = "bypassPermissions" if auto else "acceptEdits"
    assert capture["options"]["permission_mode"] == expected_mode


def test_platform_profile_exposes_only_scoped_read_tools_and_disables_project_settings(tmp_path: Path, sdk_python: str, fake_cli: Path) -> None:
    from coderfleet.server.platform_activity import build_snapshot
    snapshot=tmp_path/'snapshot.json'
    snapshot.write_text(json.dumps(build_snapshot(tmp_path,'2026-11-12','UTC')))
    tools=WORKER.with_name('coderfleet_platform_tools.py')
    probe=tmp_path/'decisions.json'
    result, events, capture=run_sdk_task(tmp_path,sdk_python,fake_cli,spec_changes={
        'platform_snapshot':str(snapshot),'platform_tools_module':str(tools),
        'sdk_options':{'max_turns':8,'max_budget_usd':0.5}},FAKE_CLAUDE_PERMISSION_PROBE=probe)
    assert result.returncode==0, result.stderr
    assert capture['options']['setting_sources']==''
    assert capture['options']['permission_mode']=='dontAsk'
    assert capture['options']['allowedTools']=='mcp__platform__manifest,mcp__platform__read_activities,mcp__platform__get_activity'
    argv=capture['argv']
    assert argv[argv.index('--tools')+1]=='' and '--strict-mcp-config' in argv
    assert 'coderfleet' not in json.loads(capture['options']['mcp_config'])['mcpServers']
    assert json.loads(probe.read_text())['UnapprovedTool']['behavior']=='deny'
    receipt=next(event for event in events if event.get('subtype')=='coderfleet_platform_coverage')
    assert not receipt['complete'] and not receipt['manifest_read'] and receipt['source_ids']==[]
    assert any(event.get('subtype')=='coderfleet_event_clock' for event in events)


def test_retrieval_profile_only_exposes_selected_remote_mcp(tmp_path,sdk_python,fake_cli):
    result,events,capture=run_sdk_task(tmp_path,sdk_python,fake_cli,spec_changes={
        'platform_tools_module':str(WORKER.with_name('coderfleet_platform_tools.py')),
        'sdk_options':{'max_turns':8,'max_budget_usd':0.5},
        'mcp_options':{'mcp_servers':{'fleet':{'type':'http','url':'http://127.0.0.1:9/platform-mcp/'}},'allowed_tools':[],'disallowed_tools':[]}})
    assert result.returncode==0,result.stderr
    assert capture['options']['allowedTools']=='mcp__fleet__*'
    assert capture['options']['setting_sources']==''
    assert capture['argv'][capture['argv'].index('--tools')+1]==''
    assert (tmp_path/'worker-fixture.platform-turns.json').is_file()
