"""Claude backend configuration and task metadata through public CLI commands."""
from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from click.testing import CliRunner

from coderfleet import config_cmds, task_cmds


@pytest.mark.parametrize('command', ['backend', 'sdk-status'])
def test_sdk_account_commands_authenticate_against_the_local_server(tmp_path: Path, monkeypatch, command: str) -> None:
    monkeypatch.setenv('CODERFLEET_WORKSPACE', str(tmp_path))
    monkeypatch.delenv('CODERFLEET_API_KEY', raising=False)
    (tmp_path / 'api_key.txt').write_text('local-test-key')
    monkeypatch.setattr(task_cmds, '_require_server', lambda: 'http://127.0.0.1:8767')

    def respond(request: httpx.Request) -> httpx.Response:
        if request.headers.get('Authorization') != 'Bearer local-test-key':
            return httpx.Response(401, json={'detail': 'unauthorized'})
        if command == 'backend':
            return httpx.Response(200, json=[{'name': 'alice', 'type': 'claude', 'claude_backend': 'sdk'}])
        return httpx.Response(200, json={'ready': True, 'sdk_version': '0.2.180', 'cli_version': '2.1.321'})

    client = httpx.Client
    monkeypatch.setattr(httpx, 'Client', lambda **kwargs: client(transport=httpx.MockTransport(respond), **kwargs))
    result = CliRunner().invoke(config_cmds.account_group, [command, 'alice'])
    assert result.exit_code == 0, result.output


@pytest.mark.parametrize('explicit_key,expected', [(None, ''), ('remote-test-key', 'Bearer remote-test-key'), ('', '')])
def test_remote_sdk_commands_never_implicitly_forward_local_api_keys(tmp_path: Path, monkeypatch, explicit_key, expected) -> None:
    monkeypatch.setenv('CODERFLEET_WORKSPACE', str(tmp_path))
    (tmp_path / 'api_key.txt').write_text('private-local-key')
    if explicit_key is None:
        monkeypatch.delenv('CODERFLEET_API_KEY', raising=False)
    else:
        monkeypatch.setenv('CODERFLEET_API_KEY', explicit_key)
    monkeypatch.setattr(task_cmds, '_require_server', lambda: 'https://remote.example')

    def respond(request: httpx.Request) -> httpx.Response:
        assert request.headers.get('Authorization', '') == expected
        return httpx.Response(200, json=[{'name': 'alice', 'type': 'claude', 'claude_backend': 'sdk'}])

    client = httpx.Client
    monkeypatch.setattr(httpx, 'Client', lambda **kwargs: client(transport=httpx.MockTransport(respond), **kwargs))
    result = CliRunner().invoke(config_cmds.account_group, ['backend', 'alice'])
    assert result.exit_code == 0, result.output


def test_account_backend_reads_and_updates_the_shared_account_api(monkeypatch) -> None:
    monkeypatch.setattr(task_cmds, "_require_server", lambda: "http://test")
    requests = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.method == "GET":
            return httpx.Response(200, json=[{"name": "alice", "type": "claude", "claude_backend": "cli"}])
        return httpx.Response(200, json={"ok": True})

    transport = httpx.MockTransport(respond)
    client = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda **kwargs: client(transport=transport, **kwargs))
    runner = CliRunner()
    result = runner.invoke(config_cmds.account_group, ["backend", "alice"])
    assert result.exit_code == 0, result.output
    assert "alice: cli" in result.output
    result = runner.invoke(config_cmds.account_group, ["backend", "alice", "sdk"])
    assert result.exit_code == 0, result.output
    assert requests[-1].method == "PUT"
    assert requests[-1].url.path == "/api/accounts/alice"
    assert requests[-1].content == b'{"claude_backend":"sdk"}'
    assert "sdk" in result.output


def test_account_sdk_status_reports_readiness_without_hiding_errors(monkeypatch) -> None:
    monkeypatch.setattr(task_cmds, "_require_server", lambda: "http://test")

    def respond(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/accounts/alice/claude-sdk-status"
        return httpx.Response(200, json={
            "ready": False, "sdk_version": "0.2.180", "cli_version": "",
            "python_path": "/opt/sdk/bin/python", "error": "CLI not installed",
        })

    client = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda **kwargs: client(transport=httpx.MockTransport(respond), **kwargs))
    result = CliRunner().invoke(config_cmds.account_group, ["sdk-status", "alice"])
    assert result.exit_code == 1, result.output
    assert "未就绪" in result.output
    assert "0.2.180" in result.output
    assert "CLI not installed" in result.output


def test_account_add_persists_sdk_and_rejects_non_claude(tmp_path: Path) -> None:
    runner = CliRunner()
    result = runner.invoke(
        config_cmds.account_group,
        ["add", "alice", "TYPE=claude", "--claude-backend", "sdk"],
        obj={"workspace": tmp_path},
    )
    assert result.exit_code == 0, result.output
    assert "CLAUDE_BACKEND=sdk" in (tmp_path / "accounts.conf").read_text()
    result = runner.invoke(
        config_cmds.account_group,
        ["add", "bob", "TYPE=codex", "--claude-backend", "sdk"],
        obj={"workspace": tmp_path},
    )
    assert result.exit_code != 0
    assert "NAME=bob" not in (tmp_path / "accounts.conf").read_text()


def test_task_status_shows_actual_backend_and_versions(monkeypatch) -> None:
    monkeypatch.setattr(task_cmds, "_require_server", lambda: "http://test")
    monkeypatch.setattr(httpx, "get", lambda *_args, **_kwargs: httpx.Response(200, json={
        "id": "task-1", "status": "done", "account": "alice", "type": "claude",
        "project": "/srv/project", "created": "2026-11-09T00:00:00Z", "prompt": "hello",
        "execution_backend": "sdk", "sdk_version": "0.2.180", "cli_version": "2.1.321",
    }))
    result = CliRunner().invoke(task_cmds.task_group, ["status", "task-1"])
    assert result.exit_code == 0, result.output
    assert "后端：    sdk" in result.output
    assert "SDK 0.2.180" in result.output
    assert "CLI 2.1.321" in result.output
