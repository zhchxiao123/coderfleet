"""Operator CLI for scoped platform reports and day-scoped questions."""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import quote
import uuid

import click
import httpx

from coderfleet.api_client import api_headers
from coderfleet.task_cmds import _require_server


def _call(method: str, path: str = "", **kwargs: Any) -> Any:
    api = _require_server()
    try:
        response = httpx.request(
            method,
            api + "/api/platform" + path,
            headers=api_headers(api),
            timeout=180,
            **kwargs,
        )
        response.raise_for_status()
        return response.json()
    except httpx.HTTPStatusError as error:
        raise click.ClickException(error.response.text) from error
    except httpx.RequestError as error:
        raise click.ClickException(
            "连接结果不确定；提交操作请用原 request-id 查询或重试：" + str(error)
        ) from error


def _print(value: Any) -> None:
    click.echo(json.dumps(value, ensure_ascii=False, indent=2))


@click.group("platform")
def platform_group() -> None:
    """Platform conversations, work reports and explicit MCP operations."""


@platform_group.command("status")
def status() -> None:
    _print(_call("GET"))


@platform_group.command("configure")
@click.option("--account")
@click.option("--timezone")
@click.option("--model")
@click.option("--image", help="SDK-ready Docker image")
@click.option(
    "--mcp-server",
    multiple=True,
    help="Enable a named account HTTP/SSE MCP; repeat for multiple servers",
)
@click.option("--clear-mcp", is_flag=True, help="Disconnect all platform MCP servers")
@click.option("--max-turns", type=click.IntRange(2, 100))
@click.option("--max-budget-usd", type=click.FloatRange(0, 20, min_open=True))
@click.option(
    "--auto-time", help="HH:MM in selected timezone; does not enable scheduling"
)
def configure(**changes: Any) -> None:
    names = changes.pop("mcp_server", ())
    clear = changes.pop("clear_mcp", False)
    if names and clear:
        raise click.ClickException("--mcp-server 与 --clear-mcp 不能同时使用")
    if names or clear:
        changes["mcp_servers"] = list(names)
    settings = _call("GET")["settings"]
    settings.update({key: value for key, value in changes.items() if value is not None})
    _print(_call("PUT", "/settings", json=settings))


def _request(
    date: str,
    timezone: str | None,
    projects: tuple[str, ...],
    question: str,
    request_id: str | None,
) -> dict[str, Any]:
    return {
        "date": date,
        "timezone": timezone,
        "projects": list(projects) if projects else None,
        "kind": "query" if question else "daily",
        "question": question,
        "request_id": request_id or str(uuid.uuid4()),
    }


@platform_group.command("preview")
@click.argument("date")
@click.option("--timezone")
@click.option("--project", "projects", multiple=True)
def preview(date: str, timezone: str | None, projects: tuple[str, ...]) -> None:
    _print(_call("POST", "/preview", json=_request(date, timezone, projects, "", None)))


@platform_group.command("run")
@click.argument("date")
@click.option("--timezone")
@click.option("--project", "projects", multiple=True)
@click.option(
    "--question",
    default="",
    help="Ask about this date instead of generating a daily report",
)
@click.option(
    "--request-id",
    help="Reuse this ID and the same payload after an uncertain submission",
)
@click.option(
    "--after",
    default="",
    help="Continue after a platform reply; inherit its frozen snapshot",
)
def run(
    date: str,
    timezone: str | None,
    projects: tuple[str, ...],
    question: str,
    request_id: str | None,
    after: str = "",
) -> None:
    body = _request(date, timezone, projects, question, request_id)
    if after:
        body["parent_run_id"] = after
    click.echo("request-id: " + body["request_id"], err=True)
    _print(_call("POST", "/runs", json=body))


@platform_group.command("list")
@click.option("--date", default="")
def list_runs(date: str) -> None:
    _print(_call("GET", "/runs", params={"date": date}))


@platform_group.command("get")
@click.argument("identifier")
@click.option(
    "--request-id", is_flag=True, help="Look up the original client request ID"
)
def get(identifier: str, request_id: bool) -> None:
    _print(
        _call("GET", "/requests", params={"request_id": identifier})
        if request_id
        else _call("GET", "/runs/" + quote(identifier, safe=""))
    )


@platform_group.command("source")
@click.argument("identifier")
@click.argument("source_id")
def source(identifier: str, source_id: str) -> None:
    _print(
        _call(
            "GET",
            "/runs/"
            + quote(identifier, safe="")
            + "/sources/"
            + quote(source_id, safe=""),
        )
    )


@platform_group.command("cancel")
@click.argument("identifier")
def cancel(identifier: str) -> None:
    _print(_call("POST", "/runs/" + quote(identifier, safe="") + "/cancel"))


@platform_group.command("logs")
@click.argument("identifier")
def logs(identifier: str) -> None:
    record = _call("GET", "/runs/" + quote(identifier, safe=""))
    if not record["task_id"]:
        click.echo("此运行尚无执行日志。")
        return
    from coderfleet.task_cmds import cmd_task_logs

    context = click.get_current_context()
    context.invoke(cmd_task_logs, task_id=record["task_id"], follow=False)


@platform_group.command("thread")
@click.argument("identifier")
def thread(identifier: str) -> None:
    """Read the full platform conversation leading to this reply."""
    _print(_call("GET", "/runs/" + quote(identifier, safe="") + "/thread"))
