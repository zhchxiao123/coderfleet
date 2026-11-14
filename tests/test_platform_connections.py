from __future__ import annotations
import json
import pytest


def test_account_remote_connections_are_explicit_private_and_standalone(tmp_path):
    from coderfleet.server.platform_connections import (
        available_connections,
        resolve_connections,
    )

    directory = tmp_path / "accounts/alice"
    directory.mkdir(parents=True)
    (directory / ".claude.json").write_text(
        json.dumps(
            {
                "projects": {
                    "/workspace": {
                        "mcpServers": {
                            "reminis": {
                                "type": "http",
                                "url": "https://example.test/private-token",
                                "headers": {"Authorization": "secret"},
                            },
                            "host-command": {"command": "/Users/local/only"},
                        }
                    }
                }
            }
        )
    )
    available = available_connections(tmp_path, "alice")
    assert [c["name"] for c in available] == ["host-command", "reminis"]
    assert "private-token" not in json.dumps(available) and "secret" not in json.dumps(
        available
    )
    assert resolve_connections(tmp_path, "alice", []) == {}
    assert (
        resolve_connections(tmp_path, "alice", ["reminis"])["reminis"]["type"] == "http"
    )
    with pytest.raises(ValueError):
        resolve_connections(tmp_path, "alice", ["unknown"])
    with pytest.raises(ValueError):
        resolve_connections(tmp_path, "alice", ["host-command"])


def test_run_directory_protects_container_connection_configuration(
    tmp_path, monkeypatch
):
    import asyncio, stat
    from test_platform_agent import configured, ResultRuntime
    from coderfleet.server.platform_agent import PlatformRequest

    scheduler, harness = configured(tmp_path, monkeypatch, ResultRuntime(tmp_path))

    async def drive():
        record = await harness.create(
            PlatformRequest(
                request_id="private-config",
                kind="query",
                question="能力说明",
                date="2026-11-12",
            )
        )
        directory = tmp_path / "platform/runs" / record["id"]
        assert stat.S_IMODE(directory.stat().st_mode) == 0o700
        await asyncio.gather(*list(scheduler._running.values()))

    asyncio.run(drive())
