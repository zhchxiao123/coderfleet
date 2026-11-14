"""Time-scoped public activity snapshots for the platform's read-only agent."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
import hashlib
import json
from pathlib import Path
import re
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from coderfleet.server.models import Task
from coderfleet.data.scripts.coderfleet_platform_tools import ACTIVITY_CHUNK_CHARS


def _instant(value: str | None) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return (
            parsed.replace(tzinfo=timezone.utc)
            if parsed.tzinfo is None
            else parsed.astimezone(timezone.utc)
        )
    except ValueError:
        return None


def _redact(text: str, secrets: list[str]) -> str:
    for secret in secrets:
        text = text.replace(secret, "[REDACTED]")
    text = re.sub(
        r"-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----",
        "[REDACTED PRIVATE KEY]",
        text,
    )
    text = re.sub(
        r"\b(?:sk-ant-|sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}", "[REDACTED]", text
    )
    text = re.sub(r"(?i)\bBearer\s+[A-Za-z0-9._~+/-]+=*", "Bearer [REDACTED]", text)
    return re.sub(
        r'(?i)((?:api[_-]?key|access[_-]?token|password|secret|auth[_-]?token)["\x27]?\s*[:=]\s*["\x27]?)[^\s"\x27,;}]+',
        r"\1[REDACTED]",
        text,
    )


def _public_events(
    path: Path,
    warnings: list[str],
    provider: str = "claude",
    max_bytes: int | None = None,
) -> tuple[list[dict[str, Any]], int]:
    rows: list[dict[str, Any]] = []
    clocks: dict[str, datetime] = {}
    questions: set[str] = set()
    parts: list[str] = []
    message_id = ""
    consumed = 0
    from coderfleet.account_type_registry import get_spec, TextChunk, FinalText

    classifier = (
        get_spec(provider).parse_output_events if provider != "claude" else None
    )
    if provider != "claude" and classifier is None:
        warnings.append(
            f"{path.stem}: 该供应商日志没有公开回复结构，仅纳入Task问题和状态"
        )
    with path.open("rb") as stream:
        limit = path.stat().st_size
        if max_bytes is not None:
            if limit < max_bytes:
                warnings.append(f"{path.stem}: 日志在目录建立后被截短，存在资料缺口")
            limit = min(limit, max_bytes)
        index = 0
        while consumed < limit:
            raw = stream.readline(min(16 * 1024 * 1024 + 1, limit - consumed))
            if not raw:
                break
            consumed += len(raw)
            index += 1
            if len(raw) > 16 * 1024 * 1024:
                warnings.append(f"{path.stem}: 日志事件过大，未纳入该事件")
                while raw and not raw.endswith(b"\n") and consumed < limit:
                    raw = stream.readline(min(1024 * 1024, limit - consumed))
                    consumed += len(raw)
                continue
            try:
                event = json.loads(raw)
            except (ValueError, UnicodeDecodeError):
                if raw.lstrip().startswith(b"{"):
                    warnings.append(f"{path.stem}: 未完整解析日志第{index}行")
                continue
            if not isinstance(event, dict) or event.get("parent_tool_use_id"):
                continue
            digest = hashlib.sha256(raw.rstrip(b"\r\n")).hexdigest()
            at = _instant(event.get("timestamp"))
            subtype = event.get("subtype")
            if subtype == "coderfleet_event_clock":
                clock = _instant(event.get("at"))
                if clock and isinstance(event.get("event_hash"), str):
                    clocks.setdefault(event["event_hash"], clock)
                continue

            def add(kind: str, text: str, key: str) -> None:
                rows.append(
                    {
                        "kind": kind,
                        "text": text,
                        "key": key,
                        "hash": digest,
                        "at": at,
                        "line": index,
                    }
                )

            if provider != "claude":
                if classifier:
                    try:
                        for number, public in enumerate(classifier(event)):
                            if isinstance(public, (TextChunk, FinalText)):
                                add("reply", public.text, digest + str(number))
                    except (ValueError, TypeError, KeyError, AttributeError):
                        warnings.append(f"{path.stem}: 无法解析供应商事件第{index}行")
                continue
            content = (
                event.get("message", {}).get("content", [])
                if isinstance(event.get("message"), dict)
                else []
            )
            if not isinstance(content, list):
                content = []
            if event.get("type") == "assistant":
                identifier = (
                    event.get("message", {}).get("id", "")
                    if isinstance(event.get("message"), dict)
                    else ""
                )
                if not identifier or identifier != message_id:
                    parts = []
                    message_id = identifier
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") == "text" and isinstance(
                        block.get("text"), str
                    ):
                        parts.append(block["text"])
                        add("reply", block["text"], digest + str(len(parts)))
                    if block.get("type") == "tool_use" and block.get("name") in {
                        "AskUserQuestion",
                        "mcp__coderfleet__ask_user_question",
                    }:
                        key = block.get("id")
                        arguments = block.get("input", {})
                        if isinstance(key, str) and isinstance(arguments, dict):
                            questions.add(key)
                            add(
                                "agent_question",
                                json.dumps(
                                    arguments.get("questions", []), ensure_ascii=False
                                ),
                                "question:" + key,
                            )
            elif event.get("type") == "user":
                for block in content:
                    if (
                        isinstance(block, dict)
                        and isinstance(block.get("tool_use_id"), str)
                        and block["tool_use_id"] in questions
                    ):
                        value = block.get("content", "")
                        add(
                            "human_answer",
                            value
                            if isinstance(value, str)
                            else json.dumps(value, ensure_ascii=False),
                            "answer:" + block["tool_use_id"],
                        )
            elif event.get("type") == "result" and isinstance(event.get("result"), str):
                if event["result"] not in [
                    "\n".join(parts),
                    "".join(parts),
                    "\n\n".join(parts),
                ]:
                    add("reply", event["result"], digest)
            elif subtype == "coderfleet_message_accepted":
                add(
                    "supplement",
                    str(event.get("text", "")),
                    "message:" + str(event.get("request_id", digest)),
                )
            elif subtype == "coderfleet_question_pending":
                key = str(event.get("tool_call_id", digest))
                questions.add(key)
                add(
                    "agent_question",
                    json.dumps(event.get("questions", []), ensure_ascii=False),
                    "question:" + key,
                )
            elif subtype == "coderfleet_human_answer":
                add(
                    "human_answer",
                    json.dumps(event.get("answers", {}), ensure_ascii=False),
                    "answer:" + str(event.get("tool_call_id", digest)),
                )
            elif subtype == "coderfleet_human_decision":
                add(
                    "approval",
                    json.dumps(
                        {
                            key: event.get(key)
                            for key in ("tool_name", "decision", "message")
                        },
                        ensure_ascii=False,
                    ),
                    digest,
                )
    for row in rows:
        row["at"] = row["at"] or clocks.get(row["hash"])
    return rows, limit


def build_snapshot(
    workspace: Path,
    day: str,
    timezone_name: str,
    projects: list[str] | None = None,
    *,
    as_of: str | None = None,
    task_ids: list[str] | None = None,
    task_records: list[Task] | None = None,
    log_limits: dict[str, int] | None = None,
) -> dict[str, Any]:
    try:
        zone = ZoneInfo(timezone_name)
        selected = date.fromisoformat(day)
    except (ValueError, ZoneInfoNotFoundError) as error:
        raise ValueError("日期或时区无效") from error
    start = datetime.combine(selected, time.min, zone).astimezone(timezone.utc)
    end = datetime.combine(selected + timedelta(days=1), time.min, zone).astimezone(
        timezone.utc
    )
    observed_now = datetime.now(timezone.utc)
    cutoff = min(_instant(as_of) or observed_now, end)
    activities: list[dict[str, Any]] = []
    inventory: list[dict[str, Any]] = []
    warnings: list[str] = []
    from coderfleet.config import load_config

    secrets = [
        value
        for key, value in load_config(workspace).items()
        if any(word in key.upper() for word in ("KEY", "TOKEN", "PASSWORD", "SECRET"))
        and len(value) >= 8
    ]
    key_path = workspace / "api_key.txt"
    if key_path.is_file():
        secrets.append(key_path.read_text().strip())
    secrets = [value for value in secrets if len(value) >= 8]
    from coderfleet.config import parse_conf

    tasks = [
        task
        for task in (
            Task.load_all(workspace / "tasks") if task_records is None else task_records
        )
        if not task.platform_run_id
    ]
    known_projects = {
        task.project_name or Path(task.project).name or "unassigned" for task in tasks
    }
    known_projects.update(
        record["NAME"]
        for record in parse_conf(workspace / "projects.conf")
        if record.get("NAME")
    )
    if projects is not None and set(projects) - known_projects:
        raise ValueError(
            "项目范围包含未知项目：" + ", ".join(sorted(set(projects) - known_projects))
        )
    source_bytes = 0
    for task in sorted(tasks, key=lambda item: item.id):
        if task_ids is not None and task.id not in task_ids:
            continue
        if getattr(task, "platform_run_id", ""):
            continue
        project = task.project_name or Path(task.project).name or "unassigned"
        if projects is not None and project not in projects:
            continue
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", task.id):
            warnings.append("发现无效Task标识，未读取日志")
            continue
        created, finished = _instant(task.created), _instant(task.finished)
        if (
            created is None
            or created >= cutoff
            or (finished is not None and finished < start)
        ):
            continue
        source = {
            "task_id": task.id,
            "conversation_id": task.conversation_id,
            "project_name": project,
        }
        inventory.append(
            {
                **source,
                "status": task.status.value
                if not finished or finished < cutoff
                else "running",
                "tokens_input": task.tokens_input,
                "tokens_output": task.tokens_output,
                "cost_usd": task.cost_usd,
                "resource_scope": "cumulative_task",
                "needs_answer": bool(task.pending_intervention),
            }
        )

        def append(
            kind: str,
            text: str,
            at: datetime,
            key: str,
            estimated: bool = False,
            line: int = 0,
        ) -> None:
            text = _redact(text, secrets)
            if not text.strip() or not start <= at < cutoff:
                return
            identity = hashlib.sha256(key.encode()).hexdigest()[:20]
            for offset in range(0, len(text), ACTIVITY_CHUNK_CHARS):
                activities.append(
                    {
                        "id": f"{task.id}:{identity}:{offset // ACTIVITY_CHUNK_CHARS}",
                        **source,
                        "source": source,
                        "kind": kind,
                        "task_status": inventory[-1]["status"],
                        "needs_answer": inventory[-1]["needs_answer"],
                        "at": at.isoformat(),
                        "time_estimated": estimated,
                        "line": line,
                        "text": text[offset : offset + ACTIVITY_CHUNK_CHARS],
                    }
                )

        append("question", task.prompt, created, "initial")
        if created < start:
            append(
                "context", "跨日任务原始要求：" + task.prompt, start, "carryover", True
            )
        log = workspace / "tasks" / f"{task.id}.log"
        if not log.exists():
            warnings.append(f"{task.id}: 缺少日志")
            continue
        rows, size = _public_events(
            log, warnings, task.type.value, (log_limits or {}).get(task.id)
        )
        source_bytes += size
        if created < start and any(row["at"] is None for row in rows):
            warnings.append(
                f"{task.id}: 跨日历史日志没有事件时间，相关内容仅作上下文，无法精确归日"
            )
        unique: dict[str, dict[str, Any]] = {}
        for row in rows:
            previous = unique.get(row["key"])
            if previous is None or (previous["at"] is None and row["at"] is not None):
                unique[row["key"]] = row
        undated_omitted = False
        for row in unique.values():
            known = row["at"]
            if known is None and (
                (finished is not None and finished >= cutoff)
                or (finished is None and cutoff < observed_now)
            ):
                undated_omitted = True
                continue
            when = known or finished or created
            kind = row["kind"]
            if known is None and created < start:
                when = start
                kind = "context"
            append(kind, row["text"], when, row["key"], known is None, row["line"])
        if undated_omitted:
            warnings.append(
                f"{task.id}: 无时间帧且Task未在截止前完成，无法定位的回复未纳入该日期"
            )
    activities.sort(key=lambda item: (item["at"], item["id"]))
    result: dict[str, Any] = {
        "version": 1,
        "date": day,
        "timezone": timezone_name,
        "window": {
            "start": start.isoformat(),
            "end": end.isoformat(),
            "as_of": cutoff.isoformat(),
        },
        "projects": sorted({item["project_name"] for item in inventory}),
        "tasks": inventory,
        "activities": activities,
        "coverage": {
            "tasks": len(inventory),
            "activities": len(activities),
            "warnings": warnings,
            "estimated_timestamps": sum(item["time_estimated"] for item in activities),
            "source_bytes": source_bytes,
        },
    }
    serialized = json.dumps(result, sort_keys=True, ensure_ascii=False).encode()
    if len(serialized) > 32 * 1024 * 1024:
        raise ValueError("活动快照超过32MiB，请选择较小的项目范围")
    result["fingerprint"] = hashlib.sha256(serialized).hexdigest()
    return result
