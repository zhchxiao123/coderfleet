"""Task-bound read-only MCP service. No operator API key enters a worker."""

import hmac
import json
from typing import Any
from mcp.server.fastmcp import FastMCP
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Scope, Receive, Send
from coderfleet.server.scheduler import Scheduler

from coderfleet.server.models import Task, TaskStatus
from coderfleet.server.platform_retrieval import PlatformReader


def authorize(scheduler: Scheduler, run_id: str, token: str) -> PlatformReader:
    from coderfleet.server.platform_agent import PlatformHarness

    directory = PlatformHarness(scheduler)._path(run_id)
    try:
        expected = json.loads((directory / "access.json").read_text())["token"]
    except (OSError, ValueError, KeyError) as error:
        raise ValueError("无效平台访问凭证") from error
    if not token or not hmac.compare_digest(token, expected):
        raise ValueError("无效平台访问凭证")
    record = json.loads((directory / "run.json").read_text())
    task = (
        scheduler.get_task(record["task_id"])
        if record["task_id"]
        else next(
            (
                t
                for t in Task.load_all(scheduler.tasks_dir)
                if t.platform_run_id == run_id
            ),
            None,
        )
    )
    if not task or task.platform_run_id != run_id or task.status != TaskStatus.running:
        raise ValueError("平台 Task 已结束或尚未执行")
    return PlatformReader(scheduler, run_id)


class PlatformMCPAuth:
    def __init__(self, app: ASGIApp, scheduler: Scheduler) -> None:
        self.app, self.scheduler = app, scheduler

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            headers = dict(scope.get("headers", []))
            try:
                from starlette.concurrency import run_in_threadpool

                await run_in_threadpool(
                    authorize,
                    self.scheduler,
                    headers.get(b"x-coderfleet-run-id", b"").decode(),
                    headers.get(b"authorization", b"").decode().removeprefix("Bearer "),
                )
            except (ValueError, OSError, KeyError, UnicodeDecodeError):
                await JSONResponse(
                    {"detail": "平台 MCP 凭证无效或任务已结束"}, status_code=401
                )(scope, receive, send)
                return
        await self.app(scope, receive, send)


def build_platform_mcp(scheduler: Scheduler) -> FastMCP:
    server = FastMCP(
        "fleet", streamable_http_path="/", stateless_http=True, json_response=True
    )

    async def call(name: str, args: dict[str, Any]) -> dict[str, Any]:
        request = server.get_context().request_context.request
        if request is None:
            raise ValueError("需要平台 MCP HTTP 请求")
        from starlette.concurrency import run_in_threadpool

        reader = await run_in_threadpool(
            authorize,
            scheduler,
            request.headers.get("x-coderfleet-run-id", ""),
            request.headers.get("authorization", "").removeprefix("Bearer "),
        )
        return await run_in_threadpool(reader.call, name, args)

    @server.tool()
    async def catalog() -> dict[str, Any]:
        """Get authorized date, cutoff, projects and Task count without reading chat logs."""
        return await call("catalog", {})

    @server.tool()
    async def select_period(start_date: str, end_date: str) -> dict[str, Any]:
        """Select/refresh inclusive ISO dates for this question (week/month/custom range). Keeps authorized projects unchanged; freezes a fresh view at selection time, never loads chat logs. Call before weekly or monthly retrieval."""
        return await call(
            "select_period", {"start_date": start_date, "end_date": end_date}
        )

    @server.tool()
    async def list_tasks(
        query: str = "", project: str = "", offset: int = 0, limit: int = 20
    ) -> dict[str, Any]:
        """Find Tasks/chats by question/title and project. Returns Conversation IDs. Paginate until next_offset is null."""
        return await call("list_tasks", locals())

    @server.tool()
    async def get_task(task_id: str) -> dict[str, Any]:
        """Read Task status and question preview. Use read_task for full public messages."""
        return await call("get_task", locals())

    @server.tool()
    async def search_chats(
        query: str, project: str = "", offset: int = 0, limit: int = 20
    ) -> dict[str, Any]:
        """Search actual public questions/replies; excludes thinking, tools, secrets and out-of-scope Tasks. Returns bounded full chunks and citeable IDs."""
        return await call("search_chats", locals())

    @server.tool()
    async def read_task(
        task_id: str, offset: int = 0, limit: int = 20
    ) -> dict[str, Any]:
        """Read a selected Task's full public questions/replies in bounded pages. Task must be in this run's scope."""
        return await call("read_task", locals())

    @server.tool()
    async def read_chat(
        conversation_id: str, offset: int = 0, limit: int = 20
    ) -> dict[str, Any]:
        """Read public messages of a Conversation, constrained by this run's project/date/cutoff."""
        return await call("read_chat", locals())

    @server.tool()
    async def read_reply(run_id: str = "", offset: int = 0) -> dict[str, Any]:
        """Read earlier platform assistant reply on demand. Empty run_id means previous reply. Only this thread's ancestors are allowed."""
        return await call("read_reply", locals())

    return server
