"""Host-owned, scoped, lazy public chat retrieval for platform SDK Tasks."""

from __future__ import annotations
import hashlib
import json
from pathlib import Path
import threading
from typing import Any, TYPE_CHECKING

from coderfleet.server.models import Task
from coderfleet.server.platform_activity import build_snapshot, _instant, _redact
from coderfleet.config import load_config

if TYPE_CHECKING:
    from coderfleet.server.scheduler import Scheduler

_LOCKS: dict[str, threading.RLock] = {}


def _secrets(workspace: Path) -> list[str]:
    values = [
        v
        for k, v in load_config(workspace).items()
        if any(word in k.upper() for word in ("KEY", "TOKEN", "PASSWORD", "SECRET"))
        and len(v) >= 8
    ]
    path = workspace / "api_key.txt"
    if path.exists():
        values.append(path.read_text().strip())
    return [v for v in values if len(v) >= 8]


def make_catalog(
    scheduler: Scheduler,
    day: str,
    zone: str,
    projects: list[str] | None,
    as_of: str | None = None,
) -> dict[str, Any]:
    # task_ids=[] validates scope/time and reads zero execution logs.
    base = build_snapshot(
        scheduler.workspace_dir, day, zone, projects, as_of=as_of, task_ids=[]
    )
    start, cutoff = (_instant(base["window"][key]) for key in ("start", "as_of"))
    secrets = _secrets(scheduler.workspace_dir)
    tasks = []
    records: dict[str, Any] = {}
    for task in Task.load_all(scheduler.tasks_dir):
        project = task.project_name or Path(task.project).name or "unassigned"
        created, finished = _instant(task.created), _instant(task.finished)
        if (
            task.platform_run_id
            or not created
            or not cutoff
            or not start
            or created >= cutoff
            or (finished and finished < start)
            or (projects is not None and project not in projects)
        ):
            continue
        frozen = {
            key: value
            for key, value in task.model_dump(mode="json").items()
            if key
            in {
                "id",
                "account",
                "type",
                "status",
                "project",
                "project_name",
                "conversation_id",
                "created",
                "finished",
                "tokens_input",
                "tokens_output",
                "cost_usd",
            }
        }
        frozen["prompt"] = _redact(task.prompt, secrets)
        log = scheduler.get_log_path(task.id)
        records[task.id] = {
            "task": frozen,
            "log_bytes": log.stat().st_size if log.exists() else 0,
            "needs_answer": bool(task.pending_intervention),
        }
        tasks.append(
            {
                "id": task.id,
                "conversation_id": task.conversation_id,
                "project_name": project,
                "status": task.status.value
                if not finished or finished < cutoff
                else "running",
                "needs_answer": bool(task.pending_intervention),
                "created": task.created,
                "prompt": _redact(task.prompt, secrets)[:200],
            }
        )
    base.update(
        tasks=sorted(tasks, key=lambda t: t["id"]),
        projects=sorted({t["project_name"] for t in tasks}),
        mode="retrieval",
        task_records=records,
    )
    base["coverage"]["tasks"] = len(tasks)
    base.pop("fingerprint", None)
    raw = json.dumps(base, sort_keys=True, ensure_ascii=False).encode()
    if len(raw) > 8 * 1024 * 1024:
        raise ValueError("检索目录超过8MiB，请缩小项目范围")
    base["fingerprint"] = hashlib.sha256(raw).hexdigest()
    return base


class PlatformReader:
    def __init__(self, scheduler: Scheduler, run_id: str):
        from coderfleet.server.platform_agent import PlatformHarness

        self.scheduler = scheduler
        self.directory = PlatformHarness(scheduler)._path(run_id)
        self.run_id = run_id
        self.record = json.loads((self.directory / "run.json").read_text())
        self.catalog = json.loads((self.directory / "catalog.json").read_text())
        self.tasks = {t["id"]: t for t in self.catalog["tasks"]}
        self.lock = _LOCKS.setdefault(str(self.directory), threading.RLock())

    def sources(self) -> dict[str, Any]:
        path = self.directory / "retrieved.json"
        return json.loads(path.read_text()) if path.exists() else {}

    def _remember(self, rows: list[dict[str, Any]]) -> None:
        from coderfleet.server.platform_agent import _write

        sources = self.sources()
        sources.update({row["id"]: row for row in rows})
        if len(json.dumps(sources, ensure_ascii=False).encode()) > 32 * 1024 * 1024:
            raise ValueError("本轮检索资料超过32MiB，请缩小范围")
        _write(self.directory / "retrieved.json", sources)
        task_id = self.record["task_id"] or next(
            (
                t.id
                for t in Task.load_all(self.scheduler.tasks_dir)
                if t.platform_run_id == self.run_id
            ),
            "",
        )
        if task_id:
            _write(
                self.directory
                / "workspace/.coderfleet-tasks"
                / f"{task_id}.platform-progress.json",
                {
                    "task_id": task_id,
                    "snapshot_fingerprint": self.catalog["fingerprint"],
                    "read": len(sources),
                    "total": len(sources),
                    "mode": "retrieval",
                    "phase": "reading",
                },
            )

    def status(self) -> dict[str, Any]:
        path = self.directory / "retrieval-status.json"
        return (
            json.loads(path.read_text())
            if path.exists()
            else {"warnings": [], "read_limit_reached": False}
        )

    def _stop_for_budget(self) -> bool:
        from coderfleet.server.platform_agent import _write

        task_id = self.record["task_id"] or next(
            (
                t.id
                for t in Task.load_all(self.scheduler.tasks_dir)
                if t.platform_run_id == self.run_id
            ),
            "",
        )
        path = (
            self.directory
            / "workspace/.coderfleet-tasks"
            / f"{task_id}.platform-turns.json"
        )
        try:
            turns = json.loads(path.read_text())["turns"]
        except (OSError, ValueError, KeyError):
            return False
        if type(turns) is not int or turns < max(
            2, self.record["settings"]["max_turns"] - 3
        ):
            return False
        status = self.status()
        status["read_limit_reached"] = True
        _write(self.directory / "retrieval-status.json", status)
        return True

    def _task_rows(self, identifier: str) -> list[dict[str, Any]]:
        from coderfleet.server.platform_agent import _write

        if identifier not in self.tasks:
            raise ValueError("Task 不在本轮授权范围内")
        import re

        if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", identifier):
            raise ValueError("无效 Task 标识")
        path = self.directory / "retrieval" / f"{identifier}.json"
        if not path.exists():
            snap = build_snapshot(
                self.scheduler.workspace_dir,
                self.catalog["date"],
                self.catalog["timezone"],
                None,
                as_of=self.catalog["window"]["as_of"],
                task_ids=[identifier],
                task_records=[
                    Task.model_validate(
                        self.catalog["task_records"][identifier]["task"]
                    )
                ],
                log_limits={
                    identifier: self.catalog["task_records"][identifier]["log_bytes"]
                },
            )
            for row in snap["activities"]:
                row["needs_answer"] = self.catalog["task_records"][identifier][
                    "needs_answer"
                ]
            _write(
                path, {"activities": snap["activities"], "coverage": snap["coverage"]}
            )
        snapshot = json.loads(path.read_text())
        status = self.status()
        status["warnings"] = list(
            dict.fromkeys([*status["warnings"], *snapshot["coverage"]["warnings"]])
        )
        _write(self.directory / "retrieval-status.json", status)
        return list(snapshot["activities"])

    @staticmethod
    def _page(rows: list[dict[str, Any]], offset: int, limit: int) -> dict[str, Any]:
        if (
            type(offset) is not int
            or type(limit) is not int
            or offset < 0
            or not 1 <= limit <= 100
        ):
            raise ValueError("无效分页")
        selected = []
        size = 0
        for row in rows[offset : offset + limit]:
            clean = {k: v for k, v in row.items() if k != "source"}
            amount = len(json.dumps(clean, ensure_ascii=False).encode())
            if amount > 14000:
                raise ValueError("单条检索结果过大，请分段读取")
            if size + amount > 14000:
                break
            selected.append(clean)
            size += amount
        end = offset + len(selected)
        return {
            "items": selected,
            "next_offset": end if end < len(rows) else None,
            "total": len(rows),
        }

    def _reply(self, identifier: str, offset: int) -> dict[str, Any]:
        from coderfleet.server.platform_agent import PlatformHarness

        allowed: set[str] = set()
        parent = self.record["request"].get("parent_run_id", "")
        while parent:
            if parent in allowed or len(allowed) >= 32:
                raise ValueError("历史引用循环或超过32轮")
            allowed.add(parent)
            record = json.loads(
                (self.directory.parent / parent / "run.json").read_text()
            )
            parent = record["request"].get("parent_run_id", "")
        if not identifier:
            identifier = self.record["request"].get("parent_run_id", "")
        if identifier not in allowed:
            raise ValueError("回复不在当前平台对话历史中")
        value = PlatformHarness(self.scheduler).get(identifier)
        text = value["answer_markdown"] or value["error"] or "该轮没有有效回答"
        if type(offset) is not int or offset < 0 or offset > len(text):
            raise ValueError("无效回复分页")
        excerpt = text[offset : offset + 4000]
        row = {
            "id": f"reply:{identifier}:{offset}",
            "task_id": value["task_id"],
            "conversation_id": value["root_run_id"],
            "project_name": "平台助手",
            "kind": "platform_reply",
            "at": value["created"],
            "time_estimated": False,
            "text": excerpt,
            "source_run_id": identifier,
        }
        self._remember([row])
        return {
            "run_id": identifier,
            "question": value["question"][:400],
            "answer_markdown": excerpt,
            "next_offset": offset + len(excerpt)
            if offset + len(excerpt) < len(text)
            else None,
            "source_ids": [row["id"]],
        }

    def call(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        with self.lock:
            if (
                name not in {"catalog", "list_tasks", "get_task"}
                and self._stop_for_budget()
            ):
                return {
                    "finish_now": True,
                    "instruction": "读取已到轮次预算边界，请用已读资料立即生成部分回答，说明缺口。",
                }
            offset, limit = args.get("offset", 0), args.get("limit", 20)
            project, query = args.get("project", ""), args.get("query", "")
            if (
                not isinstance(project, str)
                or not isinstance(query, str)
                or len(query) > 200
            ):
                raise ValueError("无效检索条件")
            if project and project not in self.catalog["projects"]:
                raise ValueError("项目不在本轮范围内")
            tasks = [
                t
                for t in self.tasks.values()
                if not project or t["project_name"] == project
            ]
            if name == "catalog":
                return {
                    k: v
                    for k, v in self.catalog.items()
                    if k not in {"tasks", "activities", "task_records"}
                }
            if name == "read_reply":
                return self._reply(args.get("run_id", ""), offset)
            if name == "list_tasks":
                rows = [
                    t
                    for t in tasks
                    if not query
                    or query.casefold() in json.dumps(t, ensure_ascii=False).casefold()
                ]
                page = self._page(rows, offset, limit)
                items = page.pop("items")
                return {**page, "tasks": items}
            if name == "get_task":
                identifier = args.get("task_id", "")
                if identifier not in self.tasks:
                    raise ValueError("Task 不在授权范围内")
                return dict(self.tasks[identifier])
            if name == "read_task":
                rows = self._task_rows(args.get("task_id", ""))
            elif name == "read_chat":
                identifier = args.get("conversation_id", "")
                if not identifier:
                    raise ValueError("需要 Conversation ID")
                chosen = [t for t in tasks if t["conversation_id"] == identifier]
                if not chosen:
                    raise ValueError("聊天不在授权范围内")
                rows = [row for task in chosen for row in self._task_rows(task["id"])]
            elif name == "search_chats":
                if not query:
                    raise ValueError("搜索聊天需要关键词；按项目浏览请使用 list_tasks")
                rows = [
                    row
                    for task in tasks
                    for row in self._task_rows(task["id"])
                    if query.casefold() in row["text"].casefold()
                ]
            else:
                raise ValueError("未知平台检索工具")
            page = self._page(rows, offset, limit)
            self._remember(page["items"])
            items = page.pop("items")
            return {**page, "activities": items}
