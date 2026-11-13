from __future__ import annotations

import asyncio
import json

from fastapi import FastAPI
from fastapi.testclient import TestClient
from click.testing import CliRunner
import httpx

from coderfleet.server.auth import AuthMiddleware
from coderfleet.server.platform_routes import build_platform_router
from coderfleet.server.runtime import FakeRuntime
from coderfleet.server.scheduler import Scheduler
from coderfleet import platform_cmds


def test_platform_routes_require_operator_auth_and_persist_empty_runs(tmp_path):
    scheduler = Scheduler(tmp_path, runtime=FakeRuntime())
    (tmp_path / "accounts.conf").write_text(
        "NAME=alice TYPE=claude PROXY=off CLAUDE_BACKEND=sdk\n"
    )
    app = FastAPI()
    app.add_middleware(AuthMiddleware, api_key="operator-test-key")
    app.include_router(build_platform_router(lambda: scheduler))
    with TestClient(app) as client:
        assert client.get("/api/platform").status_code == 401
        client.headers["Authorization"] = "Bearer operator-test-key"
        assert (
            client.put(
                "/api/platform/settings",
                json={"account": "alice", "timezone": "America/Los_Angeles"},
            ).status_code
            == 200
        )
        assert (
            client.post(
                "/api/platform/preview", json={"date": "invalid", "request_id": "p"}
            ).status_code
            == 422
        )
        body = {"date": "2026-11-10", "request_id": "same"}
        record = client.post("/api/platform/runs", json=body).json()
        assert record["status"] == "ready" and not record["task_id"]
        assert client.post("/api/platform/runs", json=body).json()["id"] == record["id"]
        assert (
            client.post(
                "/api/platform/runs", json={**body, "date": "2026-11-11"}
            ).status_code
            == 409
        )
        assert (
            client.get("/api/platform/requests", params={"request_id": "same"}).json()[
                "id"
            ]
            == record["id"]
        )
        assert client.get("/api/platform/runs").json()[0]["id"] == record["id"]
        assert client.get("/api/platform/runs/unknown").status_code == 422
        assert client.get("/api/platform/runs/" + "a" * 32).status_code == 404
        assert (
            client.post("/api/platform/runs/" + record["id"] + "/cancel").json()[
                "status"
            ]
            == "ready"
        )


def test_platform_cli_uses_scoped_auth_and_reuses_the_explicit_request_identity(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("CODERFLEET_WORKSPACE", str(tmp_path))
    monkeypatch.delenv("CODERFLEET_API_KEY", raising=False)
    (tmp_path / "api_key.txt").write_text("operator-cli-key")
    monkeypatch.setattr(
        platform_cmds, "_require_server", lambda: "http://localhost:8767"
    )
    requests = []

    def respond(request):
        requests.append(request)
        assert request.headers["Authorization"] == "Bearer operator-cli-key"
        return httpx.Response(201, json={"status": "running", "id": "one"})

    with httpx.Client(
        transport=httpx.MockTransport(respond), trust_env=False
    ) as client:
        monkeypatch.setattr(httpx, "request", client.request)
        result = CliRunner().invoke(
            platform_cmds.platform_group,
            [
                "run",
                "2026-11-12",
                "--timezone",
                "America/Los_Angeles",
                "--project",
                "one",
                "--question",
                "未完成事项？",
                "--request-id",
                "same",
            ],
        )
    assert result.exit_code == 0, result.output
    assert json.loads(requests[0].content) == {
        "date": "2026-11-12",
        "timezone": "America/Los_Angeles",
        "projects": ["one"],
        "kind": "query",
        "question": "未完成事项？",
        "request_id": "same",
    }
    assert "same" in result.output
