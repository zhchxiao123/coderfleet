from __future__ import annotations
import json
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.testclient import TestClient
from coderfleet.server.auth import AuthMiddleware
from coderfleet.server.platform_mcp import build_platform_mcp, PlatformMCPAuth
from coderfleet.server.platform_retrieval import make_catalog
from coderfleet.server.models import Task, TaskStatus, AccountType
from coderfleet.server.scheduler import Scheduler
from coderfleet.server.runtime import FakeRuntime


def test_scoped_mcp_auth_search_read_and_revocation(tmp_path):
    scheduler = Scheduler(tmp_path, runtime=FakeRuntime())
    source = Task(
        id="source",
        account="alice",
        type=AccountType.claude,
        status=TaskStatus.done,
        prompt="修复检索",
        project="/demo",
        project_name="demo",
        conversation_id="chat",
        created="2026-11-12T10:00:00Z",
        finished="2026-11-12T10:01:00Z",
    )
    source.save(scheduler.tasks_dir)
    scheduler.get_log_path(source.id).write_text(
        json.dumps({"type": "result", "result": "已完成分页验证"}) + "\n"
    )
    run = "a" * 32
    directory = tmp_path / "platform/runs" / run
    directory.mkdir(parents=True)
    (directory / "access.json").write_text(json.dumps({"token": "scoped-token"}))
    (directory / "run.json").write_text(
        json.dumps(
            {
                "request": {"parent_run_id": ""},
                "scope": {"projects": ["demo"]},
                "task_id": "platform-task",
            }
        )
    )
    (directory / "catalog.json").write_text(
        json.dumps(make_catalog(scheduler, "2026-11-12", "UTC", ["demo"]))
    )
    platform = Task(
        id="platform-task",
        account="alice",
        type=AccountType.claude,
        status=TaskStatus.running,
        platform_run_id=run,
        prompt="summary",
        project="ephemeral",
    )
    platform.save(scheduler.tasks_dir)
    mcp = build_platform_mcp(scheduler)

    @asynccontextmanager
    async def lifespan(app):
        async with mcp.session_manager.run():
            yield

    app = FastAPI(lifespan=lifespan)
    app.add_middleware(AuthMiddleware, api_key="operator-key")
    app.mount("/platform-mcp", PlatformMCPAuth(mcp.streamable_http_app(), scheduler))
    with TestClient(app) as client:
        headers = {
            "Accept": "application/json, text/event-stream",
            "X-CoderFleet-Run-Id": run,
            "Authorization": "Bearer scoped-token",
        }
        body = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": "list_tasks", "arguments": {"query": "检索"}},
        }
        assert client.post("/platform-mcp/", json=body).status_code == 401
        assert (
            client.post(
                "/platform-mcp/",
                json=body,
                headers={**headers, "Authorization": "Bearer operator-key"},
            ).status_code
            == 401
        )
        response = client.post("/platform-mcp/", json=body, headers=headers)
        assert response.status_code == 200, response.text
        value = json.loads(response.json()["result"]["content"][0]["text"])
        assert value["tasks"][0]["id"] == "source"
        body["params"] = {"name": "read_chat", "arguments": {"conversation_id": "chat"}}
        response = client.post("/platform-mcp/", json=body, headers=headers)
        value = json.loads(response.json()["result"]["content"][0]["text"])
        assert any(row["text"] == "已完成分页验证" for row in value["activities"])
        body["params"] = {"name": "read_task", "arguments": {"task_id": "outside"}}
        assert client.post("/platform-mcp/", json=body, headers=headers).json()[
            "result"
        ]["isError"]
        platform.status = TaskStatus.done
        platform.save(scheduler.tasks_dir)
        assert (
            client.post("/platform-mcp/", json=body, headers=headers).status_code == 401
        )
        assert client.get("/api/platform").status_code == 401
