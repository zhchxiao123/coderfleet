from __future__ import annotations

import asyncio
import json

from click.testing import CliRunner
from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx

from coderfleet import task_cmds
from coderfleet.server.auth import AuthMiddleware
from coderfleet.server.models import ConversationResponse
from coderfleet.server.scheduler import Scheduler
from coderfleet.server.title_routes import build_title_router
from test_conversation_titles import make_conversation, make_task


def test_title_api_auth_conflicts_bounded_reads_and_regeneration(tmp_path):
    scheduler = Scheduler(tmp_path)
    make_conversation(scheduler)
    make_task(scheduler)
    app = FastAPI()
    app.add_middleware(AuthMiddleware, api_key="operator")
    app.include_router(build_title_router(lambda: scheduler))
    with TestClient(app) as client:
        assert client.get("/api/conversation-titles?ids=conv").status_code == 401
        client.headers["Authorization"] = "Bearer operator"
        row = client.get("/api/conversation-titles?ids=conv").json()[0]
        assert row["name"] == "首句截断…"
        assert "first_task_id" not in row["title"]
        assert client.get("/api/conversation-titles", params=[("ids", "conv")] * 51).status_code == 422
        assert client.post("/api/conversations/missing/title", json={}).status_code == 404
        assert client.post("/api/conversations/conv/title", json={"expected_revision": 42}).status_code == 409
        response = client.post("/api/conversations/conv/title", json={"expected_revision": 0, "expected_name": row["name"]})
        assert response.status_code == 202
        assert response.json()["title"]["source"] == "fallback"
        assert client.post("/api/conversations/conv/title", json={"expected_revision": 0}).status_code == 409
        # No configured system model: the old visible name survives with a useful status.
        for _ in range(50):
            result = client.get("/api/conversation-titles?ids=conv").json()[0]
            if result["title"]["status"] == "retryable_error":
                break
        assert result["name"] == "首句截断…"
        assert result["title"]["error"] == "not_configured"
        client.portal.call(scheduler.titles.close)


def test_cli_title_request_uses_current_revision_and_operator_credentials(tmp_path, monkeypatch):
    monkeypatch.setenv("CODERFLEET_WORKSPACE", str(tmp_path))
    monkeypatch.delenv("CODERFLEET_API_KEY", raising=False)
    (tmp_path / "api_key.txt").write_text("operator-cli")
    monkeypatch.setattr(task_cmds, "_require_server", lambda: "http://localhost:8767")
    calls = []
    payload = {"id": "conv", "name": "原名称", "title": {"revision": 7, "source": "manual", "status": "ready"}}
    def respond(request):
        assert request.headers["Authorization"] == "Bearer operator-cli"
        calls.append(request)
        return httpx.Response(200 if request.method == "GET" else 202, json=payload)
    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        monkeypatch.setattr(httpx, "get", client.get)
        monkeypatch.setattr(httpx, "post", client.post)
        result = CliRunner().invoke(task_cmds.task_group, ["title", "conv", "--regenerate", "--json"])
    assert result.exit_code == 0, result.output
    assert calls[-1].url.path == "/api/conversations/conv/title"
    assert json.loads(calls[-1].content) == {"expected_revision": 7, "expected_name": "原名称"}
    assert json.loads(result.output)["name"] == "原名称"


def test_title_fields_are_exposed_by_the_existing_conversation_response(tmp_path):
    scheduler = Scheduler(tmp_path)
    make_conversation(scheduler)
    renamed = scheduler.rename_conversation("conv", "人工固定标题")
    response = ConversationResponse.from_conversation(renamed)
    assert response.title.source == "manual"
    assert response.title.revision == 1
