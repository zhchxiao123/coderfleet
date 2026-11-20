"""
task_cmds.py — coderfleet task 子命令

通过 HTTP 调用 CoderFleet 调度服务 API，需先执行 coderfleet server 启动服务。
CODERFLEET_API 环境变量可覆盖服务地址（默认 http://localhost:8765）。
"""
from __future__ import annotations

import json
import os
import sys
import uuid
from pathlib import Path
from typing import Optional
from urllib.parse import quote

import click
import httpx
from coderfleet.api_client import api_headers


# ── 工具函数 ──────────────────────────────────────────────

def _api_base() -> str:
    return os.environ.get("CODERFLEET_API", "http://localhost:8765").rstrip("/")


def _require_server() -> str:
    """检查服务是否在运行，返回 api base url。失败则 abort。"""
    api = _api_base()
    try:
        httpx.get(f"{api}/api/health", timeout=3).raise_for_status()
    except Exception:
        raise click.ClickException(
            f"CoderFleet 服务未启动，请先执行：coderfleet server\n"
            f"（或设置 CODERFLEET_API=<地址> 指向远端服务）"
        )
    return api


def _http_error_detail(resp: httpx.Response) -> str:
    """从一个非 2xx 响应里抠出 detail 字段；不是 JSON 就原样返回响应体文本。"""
    if "json" in resp.headers.get("content-type", ""):
        return resp.json().get("detail", resp.text)
    return resp.text


def _resolve_project_field(prefer_project: str) -> tuple[str, str]:
    """
    判断 --project 值是路径还是项目名：
    - 绝对路径 / ~ 开头 / ./ 开头 → project 字段（路径匹配）
    - 其他字符串              → project_name 字段（名称匹配）
    返回 (field_name, value)
    """
    expanded = os.path.expanduser(prefer_project)
    if (
        os.path.isabs(expanded)
        or prefer_project.startswith("~")
        or prefer_project.startswith("./")
    ):
        return "project", str(Path(expanded).resolve())
    return "project_name", prefer_project


_STATUS_STYLE = {
    "running":   ("green",  "● 运行中"),
    "pending":   ("yellow", "○ 排队中"),
    "scheduled": ("blue",   "◷ 定时中"),
    "done":      ("cyan",   "✓ 完成  "),
    "failed":    ("red",    "✗ 失败  "),
    "killed":    ("yellow", "⊘ 已终止"),
}


# ── Click 命令组 ──────────────────────────────────────────

@click.group("task")
def task_group() -> None:
    """Task management commands (requires server running)."""
    pass


@task_group.command("fork")
@click.argument("conversation_id")
@click.option("--after-task", "task_id", required=True, help="从已完成的 Claude 任务末尾分叉")
@click.option("--name", default="", help="新会话名称")
def cmd_task_fork(conversation_id: str, task_id: str, name: str) -> None:
    """Create an independent conversation sharing the current project files."""
    api = _require_server()
    try:
        response = httpx.post(
            f"{api}/api/conversations/{conversation_id}/fork",
            json={"task_id": task_id, "name": name}, timeout=30,
            headers=api_headers(api),
        )
    except httpx.RequestError as err:
        raise click.ClickException(f"请求失败：{err}") from err
    if response.status_code != 201:
        raise click.ClickException(f"分叉失败：{_http_error_detail(response)}")
    child = response.json()
    click.echo(f"新会话：{child['id']}（共享当前项目文件）")
    click.echo(f"续聊：coderfleet task run '你的消息' --conversation {child['id']}")


# ── task run ──────────────────────────────────────────────

@task_group.command("title")
@click.argument("conversation_id")
@click.option("--name", default=None, help="手动命名并锁定标题")
@click.option("--regenerate", is_flag=True, help="使用当前会话上下文重新生成标题")
@click.option("--json", "as_json", is_flag=True, help="输出名称和命名状态 JSON")
def cmd_task_title(conversation_id: str, name: Optional[str], regenerate: bool, as_json: bool) -> None:
    """View or update a conversation title without submitting a coding Task."""
    if name is not None and regenerate:
        raise click.ClickException("--name 和 --regenerate 不能同时使用")
    api = _require_server()
    url = f"{api}/api/conversations/{quote(conversation_id, safe='')}"
    try:
        response = httpx.get(url, headers=api_headers(api), timeout=10)
        response.raise_for_status()
        current = response.json()
        if name is not None:
            response = httpx.patch(url, json={"name": name}, headers=api_headers(api), timeout=10)
        elif regenerate:
            response = httpx.post(url + "/title", json={"expected_revision": current.get("title", {}).get("revision", 0),
                                                     "expected_name": current["name"]},
                                  headers=api_headers(api), timeout=10)
        response.raise_for_status()
    except httpx.HTTPStatusError as error:
        raise click.ClickException(_http_error_detail(error.response)) from error
    except httpx.RequestError as error:
        raise click.ClickException(f"请求失败：{error}") from error
    value = response.json()
    title = value.get("title", {})
    if as_json:
        click.echo(json.dumps({"id": value["id"], "name": value["name"], "title": title}, ensure_ascii=False))
    else:
        click.echo(value["name"])
        click.echo(f"命名状态：{title.get('status', 'idle')} · 来源：{title.get('source', 'legacy')}")

@task_group.command("run")
@click.argument("prompt")
@click.option("--project", "prefer_project", default=None, help="项目名称或宿主机路径")
@click.option("--account", default=None, help="指定账号名")
@click.option("--type", "prefer_type", default=None,
              type=click.Choice(["codex", "claude", "opencode"]), help="指定账号类型")
@click.option("--auto", is_flag=True, help="全自动模式（跳过权限确认）")
@click.option("--model", default="", help="本次 Task 使用的模型名称")
@click.option("--sdk-options", type=click.Path(exists=True,dir_okay=False,path_type=Path), help="SDK 参数 JSON 文件（保存在 Task 快照）")
@click.option("--conversation", "conversation_id", default=None, help="续接已有任务链 ID")
@click.option("--new-chain", "conversation_name", default=None, help="新建任务链并命名")
@click.option("--auto-title", is_flag=True, help="新建会话并由系统模型自动命名")
@click.option("--at", "execute_at", default=None, help="定时执行时间（ISO 8601）")
@click.option("--ephemeral", is_flag=True, help="临时容器模式（docker run --rm，无需持久容器）")
@click.option("--secret", "raw_secrets", multiple=True, metavar="KEY=VAL",
              help="注入临时容器的 secret 环境变量（可多次使用）")
@click.option("--output", "output_dir", default=None, metavar="DIR",
              help="宿主机目录，挂载为容器内 /output（用于收集文件产出）")
def cmd_task_run(
    prompt: str,
    sdk_options: Optional[Path],
    model: str,
    prefer_project: Optional[str],
    account: Optional[str],
    prefer_type: Optional[str],
    auto: bool,
    conversation_id: Optional[str],
    conversation_name: Optional[str],
    auto_title: bool,
    execute_at: Optional[str],
    ephemeral: bool,
    raw_secrets: tuple,
    output_dir: Optional[str],
) -> None:
    """Submit a task for execution."""
    api = _require_server()

    body: dict = {"prompt": prompt, "auto": auto}
    if auto_title:
        if conversation_id or conversation_name:
            raise click.ClickException("--auto-title 仅用于新会话，不能与 --conversation/--new-chain 同用")
        body["conversation_auto_title"] = True
    if model.strip():
        body["model"] = model.strip()
    if sdk_options is not None:
        from coderfleet.data.scripts.coderfleet_sdk_features import validate_options
        try:
            body["sdk_options"] = validate_options(json.loads(sdk_options.read_text()))
        except (OSError,ValueError) as error:
            raise click.ClickException(str(error)) from error

    if prefer_project:
        field, value = _resolve_project_field(prefer_project)
        body[field] = value
    if account:
        body["account"] = account
    if prefer_type:
        body["type"] = prefer_type
    if conversation_id:
        body["conversation_id"] = conversation_id
    if conversation_name:
        body["conversation_name"] = conversation_name
    if execute_at:
        body["execute_at"] = execute_at
    if ephemeral:
        body["ephemeral"] = True
    if raw_secrets:
        parsed: dict[str, str] = {}
        for s in raw_secrets:
            if "=" not in s:
                raise click.ClickException(f"--secret 格式错误（应为 KEY=VAL）：{s}")
            k, v = s.split("=", 1)
            parsed[k.strip()] = v
        body["secrets"] = parsed
    if output_dir:
        body["output_dir"] = str(Path(output_dir).expanduser().resolve())

    try:
        r = httpx.post(f"{api}/api/tasks", json=body, timeout=10, headers=api_headers(api))
    except httpx.RequestError as e:
        raise click.ClickException(f"请求失败：{e}")

    if r.status_code != 201:
        raise click.ClickException(f"提交失败（HTTP {r.status_code}）：{_http_error_detail(r)}")

    d = r.json()
    conv = d.get("conversation_id", "")
    project_label = d["project"].split("/")[-1] if d.get("project") else d.get("project_name", "")

    click.secho(f"✓ 任务已提交：{d['id']}", fg="green")
    mode_label = "  [临时容器]" if d.get("ephemeral") else ""
    click.echo(f"  项目：{project_label}  账号：{d['account']} ({d['type']}){mode_label}")
    if d.get("status") == "scheduled":
        click.echo(f"  定时：{d.get('execute_at')}")
    elif d.get("status") == "pending":
        click.secho(f"  状态：排队中（账号忙碌）", fg="yellow")
    if conv:
        click.echo(f"  任务链：{conv}")
    click.echo(f"  查看日志：coderfleet task logs {d['id']}")
    click.echo(f"  实时跟踪：coderfleet task logs {d['id']} -f")


# ── task list ─────────────────────────────────────────────

@task_group.command("list")
@click.option("--account", default=None, help="按账号名过滤")
@click.option("--status", "status_filter", default=None,
              type=click.Choice(["running", "pending", "scheduled", "done", "failed", "killed"]),
              help="按状态过滤")
@click.option("--limit", default=200, show_default=True, help="最多显示条数")
@click.option("--all", "include_archived", is_flag=True, help="包含已归档的任务")
def cmd_task_list(
    account: Optional[str],
    status_filter: Optional[str],
    limit: int,
    include_archived: bool,
) -> None:
    """List tasks."""
    api = _require_server()

    params: dict = {"limit": limit}
    if account:
        params["account"] = account
    if status_filter:
        params["status"] = status_filter
    if include_archived:
        params["include_archived"] = "true"

    try:
        r = httpx.get(f"{api}/api/tasks", params=params, timeout=10, headers=api_headers(api))
    except httpx.RequestError as e:
        raise click.ClickException(f"请求失败：{e}")

    if r.status_code != 200:
        raise click.ClickException(f"获取任务列表失败（HTTP {r.status_code}）")

    tasks = r.json()
    if not tasks:
        click.secho("⚠ 暂无任务记录", fg="yellow")
        return

    click.echo()
    click.echo("  ── 任务列表 " + "─" * 62)
    click.echo(f"  {'任务 ID':<22} {'状态':<10} {'账号':<18} {'类型':<8}  任务描述")
    click.echo("  " + "─" * 80)

    for t in tasks:
        color, label = _STATUS_STYLE.get(t["status"], ("white", t["status"]))
        prompt = t["prompt"]
        if len(prompt) > 38:
            prompt = prompt[:38] + "…"
        status_str = click.style(f"{label:<10}", fg=color)
        click.echo(f"  {t['id']:<22} {status_str}  {t['account']:<18} {t['type']:<8}  {prompt}")

    click.echo()


# ── task status ───────────────────────────────────────────

@task_group.command("status")
@click.argument("task_id")
def cmd_task_status(task_id: str) -> None:
    """Show task details."""
    api = _require_server()

    try:
        r = httpx.get(f"{api}/api/tasks/{task_id}", timeout=10, headers=api_headers(api))
    except httpx.RequestError as e:
        raise click.ClickException(f"请求失败：{e}")

    if r.status_code == 404:
        raise click.ClickException(f"任务 '{task_id}' 不存在")
    if r.status_code != 200:
        raise click.ClickException(f"查询失败（HTTP {r.status_code}）")

    d = r.json()
    color, label = _STATUS_STYLE.get(d["status"], ("white", d["status"]))
    if d.get('interrupted'):
        label = '已中断（会话可继续）'

    click.echo()
    click.echo(f"  ID：      {d['id']}")
    click.echo(f"  状态：    {click.style(label, fg=color)}")
    click.echo(f"  账号：    {d['account']} ({d['type']})")
    if d["type"] == "claude":
        click.echo(f"  后端：    {d.get('execution_backend') or 'cli'}")
        versions = [
            f"{label} {d[key]}"
            for key, label in (("sdk_version", "SDK"), ("cli_version", "CLI"))
            if d.get(key)
        ]
        if versions:
            click.echo(f"  版本：    {' · '.join(versions)}")
    click.echo(f"  项目：    {d['project']}")
    if d.get("project_name"):
        click.echo(f"  项目名：  {d['project_name']}")
    if d.get("git_branch"):
        worktree_suffix = " (worktree)" if d.get("git_worktree") else ""
        click.echo(f"  分支：    {d['git_branch']}{worktree_suffix}")
        added, removed = d.get("git_diff_added", 0), d.get("git_diff_removed", 0)
        if added or removed:
            diff_str = click.style(f"+{added}", fg="green") + " " + click.style(f"-{removed}", fg="red")
            click.echo(f"  变更：    {diff_str}")
    click.echo(f"  创建：    {d['created']}")
    click.echo(f"  完成：    {d.get('finished') or '-'}")
    if d.get("execute_at"):
        click.echo(f"  定时：    {d['execute_at']}")
    if d.get("conversation_id"):
        click.echo(f"  任务链：  {d['conversation_id']}")
    if d.get("native_session_id"):
        click.echo(f"  会话ID：  {d['native_session_id']}")
    if d.get("sdk_options"):
        click.echo("  SDK 参数：" + json.dumps(d["sdk_options"],ensure_ascii=False))
    if d.get("sdk_checkpoints"):
        click.echo("  文件检查点：" + ", ".join(d["sdk_checkpoints"]))
    click.echo(f"  任务描述：{d['prompt']}")
    pending = d.get("pending_intervention")
    if pending:
        click.echo()
        if pending.get('kind') == 'permission':
            click.secho('  ⏸ 待授权：' + pending.get('tool_name',''),fg='yellow')
            click.echo(json.dumps(pending.get('tool_input',{}),ensure_ascii=False))
            click.echo(f'    （coderfleet task approve {task_id} --decision allow|deny）')
        else:
            click.secho("  ⏸ 待回答：", fg="yellow")
            for q in pending.get("questions", []):
                click.echo(f"    - {q.get('question', '')}")
            click.echo(f"    （coderfleet task answer {task_id} --json '<回答 JSON>'）")
    click.echo()


# ── task logs ─────────────────────────────────────────────

@task_group.command("logs")
@click.argument("task_id")
@click.option("-f", "--follow", is_flag=True, help="实时跟踪日志（流式输出）")
def cmd_task_logs(task_id: str, follow: bool) -> None:
    """Show task logs. Use -f to stream in real time."""
    api = _require_server()

    if follow:
        click.secho("实时跟踪日志（Ctrl+C 退出）...", dim=True)
        url = f"{api}/api/tasks/{task_id}/logs/stream?tail=80"
        try:
            with httpx.stream("GET", url, timeout=None, headers=api_headers(api)) as r:
                if r.status_code == 404:
                    raise click.ClickException(f"任务 '{task_id}' 不存在")
                for line in r.iter_lines():
                    if line == "data: [DONE]":
                        break
                    if line.startswith("data: "):
                        click.echo(line[6:])
        except KeyboardInterrupt:
            pass
        except httpx.RequestError as e:
            raise click.ClickException(f"请求失败：{e}")
    else:
        try:
            r = httpx.get(f"{api}/api/tasks/{task_id}/logs", timeout=30, headers=api_headers(api))
        except httpx.RequestError as e:
            raise click.ClickException(f"请求失败：{e}")

        if r.status_code == 404:
            raise click.ClickException(f"任务 '{task_id}' 的日志不存在")
        if r.status_code != 200:
            raise click.ClickException(f"获取日志失败（HTTP {r.status_code}）")

        click.echo(r.text, nl=False)


# ── task kill ─────────────────────────────────────────────

@task_group.command("kill")
@click.argument("task_id")
def cmd_task_kill(task_id: str) -> None:
    """Kill a running or pending task."""
    api = _require_server()

    try:
        r = httpx.delete(f"{api}/api/tasks/{task_id}", timeout=10, headers=api_headers(api))
    except httpx.RequestError as e:
        raise click.ClickException(f"请求失败：{e}")

    if r.status_code == 200:
        click.secho(f"✓ 已终止任务 {task_id}", fg="green")
    elif r.status_code == 404:
        raise click.ClickException(f"任务 '{task_id}' 不存在")
    else:
        raise click.ClickException(f"终止失败（HTTP {r.status_code}）：{_http_error_detail(r)}")


# ── task answer（Intervention，见 issue #69） ────────────────

@task_group.command("answer")
@click.argument("task_id")
@click.option("--json", "answers_json", required=True,
              help='JSON 格式的回答，形如 \'{"问题原文": "选项label"}\'')
@click.option("--tool-call-id",default=None,help="与 --token 一起精确重试")
@click.option("--token",default=None,help="与 --tool-call-id 一起精确重试")
def cmd_task_answer(task_id: str, answers_json: str, tool_call_id: Optional[str], token: Optional[str]) -> None:
    """Answer a task's pending Intervention question."""
    api = _require_server()

    try:
        answers = json.loads(answers_json)
    except json.JSONDecodeError as e:
        raise click.ClickException(f"--json 不是合法的 JSON：{e}")

    if bool(tool_call_id) != bool(token): raise click.ClickException('--tool-call-id 和 --token 必须一起提供')
    pending = {'tool_call_id':tool_call_id,'token':token} if token else None
    if pending is None:
        try:
            r = httpx.get(f"{api}/api/tasks/{task_id}", timeout=10, headers=api_headers(api))
        except httpx.RequestError as e:
            raise click.ClickException(f"请求失败：{e}")

        if r.status_code == 404:
            raise click.ClickException(f"任务 '{task_id}' 不存在")
        if r.status_code != 200:
            raise click.ClickException(f"查询失败（HTTP {r.status_code}）")

        pending = r.json().get("pending_intervention")
        if not pending:
            raise click.ClickException(f"任务 '{task_id}' 当前没有待回答的问题")

    click.echo(f'问题标识: {pending["tool_call_id"]}  token: {pending["token"]}')

    try:
        r2 = httpx.post(
            f"{api}/api/tasks/{task_id}/answer", timeout=12, headers=api_headers(api),
            json={
                "tool_call_id": pending["tool_call_id"],
                "token": pending["token"],
                "answers": answers,
            },
        )
    except httpx.RequestError as e:
        raise click.ClickException("结果未知，请使用输出的问题标识、token 和原回答重试") from e

    if r2.status_code == 200:
        click.secho("✓ 已提交回答", fg="green")
    else:
        raise click.ClickException(f"提交失败（HTTP {r2.status_code}）：{_http_error_detail(r2)}")


def _sdk_command(task_id: str, action: str, request_id: Optional[str], text: Optional[str] = None, images: tuple[str,...] = ()) -> None:
    api = _require_server()
    identifier = request_id or uuid.uuid4().hex
    body: dict = {'request_id':identifier, **({'text':text} if text is not None else {})}
    if images: body['images'] = list(images)
    click.echo(f'请求 ID: {identifier}')
    try:
        response = httpx.post(f'{api}/api/tasks/{task_id}/{action}', json=body,
                              timeout=12, headers=api_headers(api))
    except httpx.RequestError as error:
        raise click.ClickException(f'结果未知，请用 task command-status {task_id} {identifier} 查询：{error}') from error
    if response.status_code != 200:
        raise click.ClickException(_http_error_detail(response))
    click.echo('✓ SDK 已接收；' + ('当前运行正在中断' if action == 'interrupt' else '消息将在 SDK 调度后处理'))


@task_group.command('interrupt')
@click.argument('task_id')
@click.option('--request-id', default=None, help='重试时使用相同 ID，避免重复投递')
def cmd_task_interrupt(task_id: str, request_id: Optional[str]) -> None:
    """Interrupt the current SDK run while preserving its native session."""
    _sdk_command(task_id, 'interrupt', request_id)


@task_group.command('send')
@click.argument('task_id')
@click.argument('text',default='')
@click.option('--image','images',multiple=True,help='已上传的 /workspace/.coderfleet-uploads/ 文件路径')
@click.option('--request-id', default=None, help='重试时使用相同 ID，避免重复投递')
def cmd_task_send(task_id: str, text: str, request_id: Optional[str], images: tuple[str,...]) -> None:
    """Send supplementary text to the running SDK Task."""
    _sdk_command(task_id, 'messages', request_id, text,images)


@task_group.command('approve')
@click.argument('task_id')
@click.option('--decision', type=click.Choice(['allow','deny']), required=True)
@click.option('--message', default='', help='拒绝理由或给模型的反馈')
@click.option('--input-json', default=None, help='批准时修改工具参数，必须为 JSON 对象')
@click.option('--tool-call-id', default=None, help='与 --token 一起用于精确重试')
@click.option('--token', default=None, help='与 --tool-call-id 一起用于精确重试')
def cmd_task_approve(task_id: str, decision: str, message: str, input_json: Optional[str], tool_call_id: Optional[str], token: Optional[str]) -> None:
    """Approve or deny one native tool/plan request."""
    api = _require_server()
    if bool(tool_call_id) != bool(token):
        raise click.ClickException('--tool-call-id 和 --token 必须一起提供')
    body: dict = {'decision':decision,'message':message}
    if input_json is not None:
        try:
            body['updated_input'] = json.loads(input_json)
            if not isinstance(body['updated_input'],dict): raise ValueError('必须为 JSON 对象')
        except ValueError as error:
            raise click.ClickException(str(error)) from error
    try:
        if not token:
            detail = httpx.get(f'{api}/api/tasks/{task_id}',headers=api_headers(api),timeout=10)
            if detail.status_code != 200: raise click.ClickException(_http_error_detail(detail))
            pending = detail.json().get('pending_intervention')
            if not pending or pending.get('kind') != 'permission': raise click.ClickException('当前没有待批准的工具')
            tool_call_id,token = pending['tool_call_id'],pending['token']
        click.echo(f'问题标识: {tool_call_id}  token: {token}')
        body.update(tool_call_id=tool_call_id,token=token)
        response = httpx.post(f'{api}/api/tasks/{task_id}/approval',json=body,headers=api_headers(api),timeout=12)
    except httpx.RequestError as error:
        raise click.ClickException('结果未知，请使用相同的问题标识、token 和决定重试') from error
    if response.status_code != 200: raise click.ClickException(_http_error_detail(response))
    click.echo('✓ 已提交授权决定')


@task_group.command('sdk')
@click.argument('task_id')
@click.argument('operation')
@click.option('--json', 'arguments_json', default='{}', help='SDK 操作参数 JSON 对象')
@click.option('--request-id', default=None, help='重试使用同一 ID')
def cmd_task_sdk(task_id: str, operation: str, arguments_json: str, request_id: Optional[str]) -> None:
    """Control the running SDK: model, permissions, MCP, context, or background tasks."""
    from coderfleet.data.scripts.coderfleet_sdk_control import validate_control, ControlError
    try:
        arguments = validate_control(operation,json.loads(arguments_json))
    except (ValueError, ControlError) as error:
        raise click.ClickException(str(error)) from error
    api = _require_server()
    identifier = request_id or uuid.uuid4().hex
    click.echo(f'请求 ID: {identifier}')
    try:
        response = httpx.post(f'{api}/api/tasks/{task_id}/sdk-control',headers=api_headers(api),timeout=12,
            json={'request_id':identifier,'operation':operation,'arguments':arguments})
    except httpx.RequestError as error:
        raise click.ClickException(f'结果未知，请用 task command-status {task_id} {identifier} 查询') from error
    if response.status_code != 200: raise click.ClickException(_http_error_detail(response))
    click.echo(json.dumps(response.json(),ensure_ascii=False))


@task_group.command('session')
@click.argument('task_id')
@click.argument('operation')
@click.option('--json','arguments_json',default='{}',help='原生会话操作参数')
@click.option('--request-id',default=None,help='查询或重试必须保留同一 ID')
def cmd_task_session(task_id: str, operation: str, arguments_json: str, request_id: Optional[str]) -> None:
    """Inspect/manage the native session bound to this Task, in its account runtime."""
    from coderfleet.data.scripts.coderfleet_sdk_features import SESSION_SCHEMAS, validate
    if operation not in SESSION_SCHEMAS: raise click.ClickException('未知操作：' + ', '.join(SESSION_SCHEMAS))
    try:
        arguments = json.loads(arguments_json)
        validate(arguments,SESSION_SCHEMAS[operation],'arguments')
    except ValueError as error: raise click.ClickException(str(error)) from error
    api = _require_server()
    identifier = request_id or uuid.uuid4().hex
    click.echo('请求 ID: ' + identifier)
    try:
        r = httpx.post(f'{api}/api/tasks/{task_id}/sdk-session',headers=api_headers(api),timeout=55,
            json={'operation':operation,'arguments':arguments,'request_id':identifier})
    except httpx.RequestError as error:
        raise click.ClickException('结果未知，使用相同操作、参数和请求 ID 查询') from error
    if r.status_code != 200: raise click.ClickException(_http_error_detail(r))
    click.echo(json.dumps(r.json(),ensure_ascii=False,indent=2))


@task_group.command('rewind')
@click.argument('task_id')
@click.argument('checkpoint')
@click.option('--request-id',default=None,help='创建恢复 Task 的幂等 ID')
@click.option('--yes',is_flag=True,help='确认恢复所跟踪的文件修改')
def cmd_task_rewind(task_id: str, checkpoint: str, request_id: Optional[str], yes: bool) -> None:
    """Create a tracked recovery Task; conversation history is preserved."""
    if not yes: click.confirm('恢复检查点跟踪的文件？Bash、子 Agent 或外部副作用不在保证范围。',abort=True)
    api = _require_server()
    identifier = request_id or uuid.uuid4().hex
    click.echo('请求 ID: ' + identifier)
    try:
        r = httpx.post(f'{api}/api/tasks/{task_id}/sdk-rewind',headers=api_headers(api),timeout=15,
            json={'user_message_id':checkpoint,'request_id':identifier})
    except httpx.RequestError as error: raise click.ClickException('结果未知，保留同一请求 ID 重试') from error
    if r.status_code != 200: raise click.ClickException(_http_error_detail(r))
    click.echo('恢复 Task：' + r.json()['id'])


@task_group.command('command-status')
@click.argument('task_id')
@click.argument('request_id')
def cmd_task_command_status(task_id: str, request_id: str) -> None:
    """Read a durable SDK command receipt without replaying it."""
    api = _require_server()
    try:
        response = httpx.get(f'{api}/api/tasks/{task_id}/commands/{request_id}', timeout=10, headers=api_headers(api))
    except httpx.RequestError as error:
        raise click.ClickException(str(error)) from error
    if response.status_code != 200:
        raise click.ClickException(_http_error_detail(response))
    click.echo(json.dumps(response.json(), ensure_ascii=False))


# ── task clean ────────────────────────────────────────────

@task_group.command("clean")
@click.argument("keep", default=30, required=False)
def cmd_task_clean(keep: int) -> None:
    """Clean old task records, keeping the N most recent (default: 30)."""
    api = _require_server()

    try:
        r = httpx.post(f"{api}/api/tasks/clean", params={"keep": keep}, timeout=10, headers=api_headers(api))
    except httpx.RequestError as e:
        raise click.ClickException(f"请求失败：{e}")

    if r.status_code != 200:
        raise click.ClickException(f"清理失败（HTTP {r.status_code}）")

    d = r.json()
    click.secho(f"✓ 已清理 {d['cleaned']} 条历史记录（保留 {d['kept']} 条）", fg="green")
