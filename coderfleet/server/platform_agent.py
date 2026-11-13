"""Platform reports/queries backed by ordinary, isolated SDK Tasks."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
from pathlib import Path
from typing import Any, Literal, TYPE_CHECKING
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from coderfleet.config import load_config, truthy, parse_conf
from coderfleet.data.scripts.coderfleet_platform_tools import ActivityReader
from coderfleet.server.models import (
    Account,
    AccountRuntime,
    Task,
    TaskStatus,
    now_iso,
)
from coderfleet.server.platform_activity import build_snapshot

if TYPE_CHECKING:
    from coderfleet.server.scheduler import Scheduler


class PlatformSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    account: str = Field(default="", max_length=128)
    timezone: str = "UTC"
    model: str = Field(default="sonnet", max_length=128)
    image: str = Field(default="", max_length=256, pattern=r"^[A-Za-z0-9_./:@-]*$")
    max_turns: int = Field(default=24, ge=2, le=100)
    max_budget_usd: float = Field(default=2.0, gt=0, le=20)
    auto_time: str = Field(default="23:30", pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")

    @field_validator("timezone")
    @classmethod
    def valid_timezone(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError) as error:
            raise ValueError("无效的IANA时区") from error
        return value


class PlatformRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: str = Field(min_length=1, max_length=128)
    kind: Literal["daily", "query"] = "daily"
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    timezone: str | None = None
    projects: list[str] | None = Field(default=None, max_length=200)
    question: str = Field(default="", max_length=8000)
    parent_run_id: str = Field(default="", pattern=r"^(?:[a-f0-9]{32})?$")

    @model_validator(mode="after")
    def query_has_question(self) -> PlatformRequest:
        if self.kind == "query" and not self.question.strip():
            raise ValueError("请输入平台查询问题")
        return self


class PlatformConflict(ValueError):
    pass


def _write(path: Path, value: dict[str, Any], *, exclusive: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + os.urandom(8).hex() + ".tmp")
    try:
        temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
        temporary.chmod(0o600)
        if exclusive:
            os.link(temporary, path)
        else:
            temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


class PlatformHarness:
    def __init__(self, scheduler: Scheduler) -> None:
        self.scheduler = scheduler
        self.root = scheduler.workspace_dir / "platform"

    def settings(self) -> PlatformSettings:
        path = self.root / "settings.json"
        return (
            PlatformSettings.model_validate_json(path.read_text())
            if path.exists()
            else PlatformSettings()
        )

    def configure(self, settings: PlatformSettings) -> dict[str, Any]:
        if settings.account:
            self._account(settings.account)
        _write(self.root / "settings.json", settings.model_dump())
        return settings.model_dump()

    def _account(self, name: str) -> Account:
        account = next(
            (item for item in self.scheduler.get_accounts() if item.name == name), None
        )
        if (
            account is None
            or account.type.value != "claude"
            or account.claude_backend != "sdk"
            or account.runtime != AccountRuntime.container
        ):
            raise ValueError("请选择容器模式的Claude SDK账号")
        return account

    def info(self) -> dict[str, Any]:
        projects = {
            task.project_name or Path(task.project).name or "unassigned"
            for task in Task.load_all(self.scheduler.tasks_dir)
            if not task.platform_run_id
        }
        projects.update(
            record["NAME"]
            for record in parse_conf(self.scheduler.workspace_dir / "projects.conf")
            if record.get("NAME")
        )
        return {
            "settings": self.settings().model_dump(),
            "automatic_enabled": truthy(
                load_config(self.scheduler.workspace_dir).get("DIGEST_ENABLED", "off")
            ),
            "accounts": [
                item.name
                for item in self.scheduler.get_accounts()
                if item.type.value == "claude"
                and item.claude_backend == "sdk"
                and item.runtime == AccountRuntime.container
            ],
            "projects": sorted(projects),
        }

    def preview(self, request: PlatformRequest) -> dict[str, Any]:
        snapshot = build_snapshot(
            self.scheduler.workspace_dir,
            request.date,
            request.timezone or self.settings().timezone,
            request.projects,
        )
        return {key: value for key, value in snapshot.items() if key != "activities"}

    def _path(self, identifier: str) -> Path:
        import re

        if not re.fullmatch(r"[a-f0-9]{32}", identifier):
            raise ValueError("无效的平台运行ID")
        return self.root / "runs" / identifier

    def launch_config(self, identifier: str) -> dict[str, Any]:
        return dict(
            json.loads((self._path(identifier) / "run.json").read_text())["settings"]
        )

    def thread(self, identifier: str) -> list[dict[str, Any]]:
        messages: list[dict[str, Any]] = []
        seen: set[str] = set()
        while identifier:
            if identifier in seen or len(messages) >= 32:
                raise ValueError("对话上下文超过32轮或引用循环，请新建对话")
            seen.add(identifier)
            message = self.get(identifier)
            messages.append(message)
            identifier = message["parent_run_id"]
        return list(reversed(messages))

    def _followup(
        self, request: PlatformRequest, settings: PlatformSettings
    ) -> tuple[dict[str, Any], dict[str, Any], str]:
        try:
            messages = self.thread(request.parent_run_id)
        except KeyError as error:
            raise ValueError("上一条平台消息不存在，请新建对话") from error
        if len(messages) >= 32:
            raise ValueError("对话上下文已达32轮，请新建对话")
        parent = messages[-1]
        if parent["status"] not in {"ready", "partial", "error", "cancelled"}:
            raise ValueError("请等待上一条消息结束后再追问")
        if (
            request.date != parent["date"]
            or (request.timezone and request.timezone != parent["timezone"])
            or (
                request.projects is not None
                and sorted(set(request.projects))
                != sorted(set(parent["projects"] or []))
            )
        ):
            raise ValueError("追问不能改变本对话的日期、时区或项目范围，请新建对话")
        if settings.account != parent["account"]:
            raise ValueError("执行账号已改变，请新建对话")
        history = [
            {
                "user": message["question"] or "生成工作日报",
                "assistant": message["answer_markdown"]
                or "上一轮未完成，未产生有效结论",
            }
            for message in messages
        ]
        context = json.dumps(history, ensure_ascii=False)
        if len(context.encode()) > 128 * 1024:
            raise ValueError("对话上下文超过128KiB，请新建对话；历史内容没有被截断")
        try:
            snapshot = ActivityReader.from_file(
                str(self._path(parent["id"]) / "snapshot.json")
            ).snapshot
        except OSError as error:
            raise ValueError("该回复没有可续用的资料快照，请新建对话") from error
        return parent, snapshot, context

    async def create(self, request: PlatformRequest) -> dict[str, Any]:
        identifier = hashlib.sha256(request.request_id.encode()).hexdigest()[:32]
        directory = self._path(identifier)
        path = directory / "run.json"
        body = request.model_dump(mode="json")
        if path.exists():
            if (
                PlatformRequest.model_validate(
                    json.loads(path.read_text())["request"]
                ).model_dump(mode="json")
                != body
            ):
                raise PlatformConflict("相同请求ID不能用于不同的平台操作")
            return self.get(identifier)
        settings = self.settings()
        self._account(settings.account)
        parent: dict[str, Any] | None = None
        inherited_snapshot: dict[str, Any] | None = None
        context = ""
        if request.parent_run_id:
            parent, inherited_snapshot, context = await asyncio.to_thread(
                self._followup, request, settings
            )
            # Reserving a child is synchronous with its check: no await can let
            # another API coroutine silently fork the same parent in between.
            if path.exists():
                if (
                    PlatformRequest.model_validate(
                        json.loads(path.read_text())["request"]
                    ).model_dump(mode="json")
                    != body
                ):
                    raise PlatformConflict("相同请求ID不能用于不同的平台操作")
                return self.get(identifier)
            for candidate in (self.root / "runs").glob("*/run.json"):
                child = json.loads(candidate.read_text())
                if child["request"].get("parent_run_id") == request.parent_run_id:
                    raise PlatformConflict(
                        "该消息已有后续回复，请打开最新消息继续或新建对话"
                    )
        config = load_config(self.scheduler.workspace_dir)
        resolved = settings.model_dump()
        resolved["image"] = settings.image or config.get(
            "IMAGE_NAME", "coderfleet"
        ) + ":" + config.get("IMAGE_TAG", "latest")
        record = {
            "id": identifier,
            "request": body,
            "settings": resolved,
            "state": "preparing",
            "task_id": "",
            "created": now_iso(),
            "owner_pid": os.getpid(),
            "error": "",
            "root_run_id": parent["root_run_id"] if parent else identifier,
            "scope": {
                "date": request.date,
                "timezone": parent["timezone"]
                if parent
                else request.timezone or settings.timezone,
                "projects": parent["projects"] if parent else request.projects,
            },
            "conversation_context": context,
        }
        try:
            _write(path, record, exclusive=True)
        except FileExistsError:
            if (
                PlatformRequest.model_validate(
                    json.loads(path.read_text())["request"]
                ).model_dump(mode="json")
                != body
            ):
                raise PlatformConflict("请求ID已被其他操作占用")
            return self.get(identifier)
        try:
            snapshot = (
                inherited_snapshot
                if inherited_snapshot is not None
                else await asyncio.to_thread(
                    build_snapshot,
                    self.scheduler.workspace_dir,
                    request.date,
                    request.timezone or settings.timezone,
                    request.projects,
                )
            )
            await asyncio.to_thread(_write, directory / "snapshot.json", snapshot)
            current = json.loads(path.read_text())
            if current["state"] == "cancelled":
                return self.get(identifier)
            current.update(
                manifest={
                    key: value for key, value in snapshot.items() if key != "activities"
                }
            )
            if not snapshot["activities"]:
                current.update(state="empty")
                _write(path, current)
                return self.get(identifier)
            _write(path, current)
            instruction = (
                "生成所选日期的跨项目工作日报。先读取全部活动，按项目总结用户问题、回复结论、关键决策、"
                "已确认结果、未完成事项和需要人工答复的问题。"
                if request.kind == "daily"
                else request.question
            )
            prompt = (
                f"业务日期：{snapshot['date']}；时区：{snapshot['timezone']}；"
                f"数据截止：{snapshot['window']['as_of']}。\n{instruction}\n"
                "使用平台只读工具获取证据。不要推断未读取的来源，按规定结构返回答案和source_ids。"
            )
            if current.get("conversation_context"):
                prompt = (
                    "以下是本对话完整历史，用于理解追问；事实须用本次只读工具核实，历史回复不是新的事实来源。\n"
                    + current["conversation_context"]
                    + "\n当前问题：\n"
                    + prompt
                )
            task = await self.scheduler.submit(
                prompt=prompt,
                account_name=settings.account,
                ephemeral=True,
                model=settings.model,
                auto=False,
                platform_run_id=identifier,
                sdk_options={
                    "max_turns": settings.max_turns,
                    "max_budget_usd": settings.max_budget_usd,
                    "effort": "medium",
                },
            )
            current = json.loads(path.read_text())
            current.update(task_id=task.id, state="submitted")
            _write(path, current)
        except Exception as error:
            current = json.loads(path.read_text())
            if current["state"] != "cancelled":
                current.update(state="error", error=str(error))
                _write(path, current)
        return self.get(identifier)

    def get(self, identifier: str) -> dict[str, Any]:
        directory = self._path(identifier)
        path = directory / "run.json"
        if not path.exists():
            raise KeyError("平台运行不存在")
        record = json.loads(path.read_text())
        task = (
            self.scheduler.get_task(record["task_id"])
            if record["task_id"]
            else next(
                (
                    item
                    for item in Task.load_all(self.scheduler.tasks_dir)
                    if item.platform_run_id == identifier
                ),
                None,
            )
        )
        # Reads may run in the API threadpool while create is submitting.
        # Reconcile through Task.platform_run_id without ever rewriting run.json
        # from a GET's stale snapshot. Only the creator/canceller mutate it.
        record = json.loads(path.read_text())
        if record["task_id"] and (task is None or task.id != record["task_id"]):
            task = self.scheduler.get_task(record["task_id"])
        if task and not record["task_id"]:
            record["task_id"] = task.id
            record["state"] = "submitted"
        response = {key: record[key] for key in ("id", "task_id", "created", "error")}
        response.update(
            kind=record["request"]["kind"],
            date=record["request"]["date"],
            timezone=record.get("scope", {}).get("timezone")
            or record["request"]["timezone"]
            or record["settings"]["timezone"],
            question=record["request"]["question"],
            parent_run_id=record["request"].get("parent_run_id", ""),
            root_run_id=record.get("root_run_id", record["id"]),
            projects=record.get("scope", {}).get(
                "projects", record["request"].get("projects")
            ),
            manifest=record.get("manifest"),
            status=record["state"],
            answer_markdown="",
            sources=[],
            coverage={},
            account=record["settings"]["account"],
            model=record["settings"]["model"],
            sdk_version=task.sdk_version if task else "",
            cli_version=task.cli_version if task else "",
        )
        if record["state"] == "empty":
            response.update(
                status="ready",
                answer_markdown="该时间窗内没有可用的公开活动记录。",
                coverage={"read": 0, "total": 0, "complete": True},
            )
            return response
        cache = directory / "result.json"
        if cache.exists():
            return {**response, **json.loads(cache.read_text())}
        if task is None:
            if record["task_id"]:
                response.update(
                    status="error",
                    error="平台Task记录缺失；快照仍保留，请使用新请求重试",
                )
            elif record["state"] == "preparing" and record["owner_pid"] != os.getpid():
                response.update(
                    status="error", error="服务在平台任务提交前重启，请使用新请求重试"
                )
            return response
        if task.platform_run_id != identifier:
            raise ValueError("平台Task归属不一致")
        response["status"] = {
            "done": "ready",
            "failed": "error",
            "killed": "cancelled",
        }.get(task.status.value, task.status.value)
        response["sdk_version"] = task.sdk_version
        response["cli_version"] = task.cli_version
        if task.status != TaskStatus.done:
            from coderfleet.server.platform_output import read_progress, failed_output

            fingerprint = record.get("manifest", {}).get("fingerprint", "")
            response["progress"] = read_progress(directory, task.id, fingerprint)
            if task.status == TaskStatus.failed:
                response.update(
                    failed_output(
                        self.scheduler.get_log_path(task.id),
                        task.id,
                        record["settings"],
                        fingerprint,
                    )
                )
            return response
        result: dict[str, Any] | None = None
        coverage: dict[str, Any] | None = None
        try:
            with self.scheduler.get_log_path(task.id).open(
                encoding="utf-8", errors="replace"
            ) as stream:
                for line in stream:
                    try:
                        event = json.loads(line)
                    except ValueError:
                        continue
                    if not isinstance(event, dict) or event.get("parent_tool_use_id"):
                        continue
                    if (
                        event.get("subtype") == "coderfleet_platform_coverage"
                        and event.get("task_id") == task.id
                    ):
                        coverage = event
                    if event.get("type") == "result" and isinstance(
                        event.get("structured_output"), dict
                    ):
                        result = event["structured_output"]
            reader = ActivityReader.from_file(str(directory / "snapshot.json"))
            if (
                not result
                or not isinstance(result.get("answer_markdown"), str)
                or not result["answer_markdown"].strip()
                or len(result["answer_markdown"]) > 100000
            ):
                raise ValueError("缺少有效的结构化报告")
            if (
                not coverage
                or coverage.get("snapshot_fingerprint")
                != reader.snapshot["fingerprint"]
            ):
                raise ValueError("缺少只读工具的覆盖回执")
            read_ids = coverage.get("source_ids", [])
            ids = result.get("source_ids")
            if not isinstance(read_ids, list) or not all(
                isinstance(item, str) and item in reader.by_id for item in read_ids
            ):
                raise ValueError("读取来源无效")
            if (
                not isinstance(ids, list)
                or not ids
                or not all(isinstance(item, str) and item in read_ids for item in ids)
            ):
                raise ValueError("报告引用了未读取的来源")
            covered = len(set(read_ids))
            total = len(reader.by_id)
            warnings = list(reader.snapshot["coverage"]["warnings"])
            manifest_read = coverage.get("manifest_read") is True
            if not manifest_read:
                warnings.append("未取得完整活动清单的读取回执")
            read_limited = (
                coverage.get("read_limit_reached") is True and covered < total
            )
            if read_limited:
                warnings.append(
                    "读取达到轮次预算边界，已预留轮次生成部分回答；仍有资料未覆盖"
                )
            answer = {
                "status": "partial"
                if read_limited
                or (
                    record["request"]["kind"] == "daily"
                    and (covered < total or warnings)
                )
                else "ready",
                "answer_markdown": result["answer_markdown"],
                "sdk_version": task.sdk_version,
                "cli_version": task.cli_version,
                "coverage": {
                    "read": covered,
                    "total": total,
                    "complete": covered == total and manifest_read,
                    "warnings": warnings,
                    "estimated_timestamps": reader.snapshot["coverage"][
                        "estimated_timestamps"
                    ],
                },
                "sources": [
                    {
                        key: value
                        for key, value in reader.by_id[item].items()
                        if key not in {"text", "source"}
                    }
                    for item in dict.fromkeys(ids)
                ],
            }
            _write(cache, answer)
            return {**response, **answer}
        except (ValueError, KeyError, OSError) as error:
            return {**response, "status": "error", "error": str(error)}

    def source(self, identifier: str, source_id: str) -> dict[str, Any]:
        directory = self._path(identifier)
        if not (directory / "snapshot.json").exists():
            raise KeyError("活动快照不存在")
        return ActivityReader.from_file(str(directory / "snapshot.json")).call(
            "get_activity", {"id": source_id}
        )

    def list(self, day: str = "", summary: bool = False) -> list[dict[str, Any]]:
        records = []
        for path in sorted(
            (self.root / "runs").glob("*/run.json"),
            key=lambda item: item.stat().st_mtime,
            reverse=True,
        ):
            record = json.loads(path.read_text())
            if not day or record["request"]["date"] == day:
                item = self.get(record["id"])
                if summary:
                    item = {
                        key: item[key]
                        for key in (
                            "id",
                            "root_run_id",
                            "parent_run_id",
                            "date",
                            "created",
                            "status",
                            "question",
                        )
                    }
                records.append(item)
            if len(records) >= 50:
                break
        return records

    async def cancel(self, identifier: str) -> dict[str, Any]:
        current = self.get(identifier)
        if current["task_id"]:
            await self.scheduler.kill_task(current["task_id"])
        elif current["status"] == "preparing":
            path = self._path(identifier) / "run.json"
            record = json.loads(path.read_text())
            record["state"] = "cancelled"
            _write(path, record)
        return self.get(identifier)

    async def tick(self) -> None:
        from datetime import datetime, timedelta

        if not truthy(
            load_config(self.scheduler.workspace_dir).get("DIGEST_ENABLED", "off")
        ):
            return
        settings = self.settings()
        if not settings.account:
            return
        now = datetime.now(ZoneInfo(settings.timezone))
        day = (
            now.date()
            if now.strftime("%H:%M") >= settings.auto_time
            else now.date() - timedelta(days=1)
        )
        request = PlatformRequest(
            request_id="auto:" + settings.timezone + ":" + day.isoformat(),
            date=day.isoformat(),
        )
        identifier = hashlib.sha256(request.request_id.encode()).hexdigest()[:32]
        if (self._path(identifier) / "run.json").exists():
            return
        await self.create(request)
