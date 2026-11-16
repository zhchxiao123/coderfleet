"""Read the same work and attention views used by the Web UI."""
from __future__ import annotations

import json

import click
import httpx

from coderfleet.api_client import api_headers
from coderfleet.task_cmds import _http_error_detail, _require_server


def _show_work(project: str, view: str, limit: int, offset: int, as_json: bool) -> None:
    api = _require_server()
    try:
        response = httpx.get(
            f"{api}/api/workbench", headers=api_headers(api), timeout=15,
            params={"project_name": project, "view": view, "limit": limit, "offset": offset},
        )
        response.raise_for_status()
    except httpx.HTTPStatusError as error:
        raise click.ClickException(_http_error_detail(error.response)) from error
    except httpx.RequestError as error:
        raise click.ClickException(f"请求失败：{error}") from error
    data = response.json()
    if as_json:
        click.echo(json.dumps(data, ensure_ascii=False, indent=2))
        return
    if not data["items"]:
        click.echo("暂无待处理事项。" if view == "attention" else "暂无工作，选择项目后可以直接问答。")
    for item in data["items"]:
        labels = " / ".join(attention["label"] for attention in item["attention"]) or item["status"]
        projects = ", ".join(item["project_names"]) or "未配置项目"
        click.echo(f"{item['id']}  [{labels}] {item['title']}  · {projects}")
        if item.get("conversation_id"):
            click.echo(f"  会话：{item['conversation_id']}")
        if item.get("task_id"):
            click.echo(f"  Task：{item['task_id']}  · coderfleet task status {item['task_id']}")
        if item.get("workflow_run_id"):
            click.echo(f"  工作流：{item['workflow_run_id']}")
        for attention in item["attention"]:
            if attention["detail"]:
                click.echo(f"  {attention['label']}：{attention['detail']}")
    shown = offset + len(data["items"])
    click.echo(f"显示 {min(offset + 1, shown)}–{shown} / {data['total']}")
    if shown < data["total"]:
        click.echo(f"下一页：--offset {shown}")


@click.group("work")
def work_group() -> None:
    """Work and attention views; ordinary project chat remains available."""


@work_group.command("list")
@click.option("--project", default="", help="筛选项目名")
@click.option("--view", type=click.Choice(["all", "attention", "running", "review", "blocked"]), default="all")
@click.option("--limit", default=50, type=click.IntRange(1, 200))
@click.option("--offset", default=0, type=click.IntRange(min=0))
@click.option("--json", "as_json", is_flag=True, help="输出完整 JSON 与原执行引用")
def work_list(project: str, view: str, limit: int, offset: int, as_json: bool) -> None:
    """List conversations, standalone tasks, workflows and existing cards."""
    _show_work(project, view, limit, offset, as_json)


@work_group.command("inbox")
@click.option("--project", default="", help="筛选项目名")
@click.option("--limit", default=50, type=click.IntRange(1, 200))
@click.option("--offset", default=0, type=click.IntRange(min=0))
@click.option("--json", "as_json", is_flag=True, help="输出完整 JSON 与原执行引用")
def work_inbox(project: str, limit: int, offset: int, as_json: bool) -> None:
    """Show pending questions, permissions, approvals, reviews and failures."""
    _show_work(project, "attention", limit, offset, as_json)
