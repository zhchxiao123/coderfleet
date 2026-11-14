"""Bounded progress and actionable termination metadata for analysis runs."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def read_progress(directory: Path, task_id: str, fingerprint: str) -> dict[str, Any]:
    path = (
        directory / "workspace/.coderfleet-tasks" / f"{task_id}.platform-progress.json"
    )
    try:
        if path.stat().st_size > 16384:
            return {}
        value = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    if (
        not isinstance(value, dict)
        or value.get("task_id") != task_id
        or value.get("snapshot_fingerprint") != fingerprint
    ):
        return {}
    read, total = value.get("read"), value.get("total")
    if type(read) is not int or type(total) is not int or not 0 <= read <= total:
        return {}
    return {
        key: value[key]
        for key in (
            "read",
            "total",
            "phase",
            "mode",
            "turns_used",
            "max_turns",
            "updated_at",
        )
        if key in value
    }


def failed_output(
    log: Path, task_id: str, settings: dict[str, Any], fingerprint: str
) -> dict[str, Any]:
    native: dict[str, Any] = {}
    receipt: dict[str, Any] = {}
    try:
        with log.open(encoding="utf-8", errors="replace") as stream:
            for line in stream:
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(event, dict) or event.get("parent_tool_use_id"):
                    continue
                if event.get("type") == "result" and not event.get(
                    "coderfleet_synthetic"
                ):
                    native = event
                if (
                    event.get("subtype") == "coderfleet_platform_coverage"
                    and event.get("task_id") == task_id
                    and event.get("snapshot_fingerprint") == fingerprint
                ):
                    receipt = event
    except OSError:
        return {
            "failure_reason": "missing_log",
            "error": "执行日志缺失，无法核实生成结果；不会自动重放调用。",
        }
    reason = native.get("terminal_reason") or native.get("subtype", "execution_error")
    if not isinstance(reason, str):
        reason = "execution_error"
    coverage = {}
    ids = receipt.get("source_ids")
    total = receipt.get("total")
    if (
        isinstance(ids, list)
        and all(isinstance(item, str) for item in ids)
        and type(total) is int
        and 0 <= len(set(ids)) <= total
    ):
        coverage = {"read": len(set(ids)), "total": total, "complete": False}
    if reason in {"max_turns", "error_max_turns"}:
        reason = "max_turns"
        message = f"已达到 {settings['max_turns']} 轮读取/生成上限，未产出最终回答"
    elif reason in {"max_budget_usd", "error_max_budget_usd"}:
        reason = "max_budget_usd"
        message = f"已达到 ${settings['max_budget_usd']:g} 费用上限，未产出最终回答"
    else:
        message = "平台任务执行失败，未产出有效回答；可展开执行日志查看详情"
    if coverage:
        message += f"（已读取 {coverage['read']}/{coverage['total']} 条活动）"
    message += "。可新建对话缩小项目范围；系统不会自动重放模型调用。"
    return {"failure_reason": reason, "error": message, "coverage": coverage}


def resolve_citations(ids: Any, sources: dict[str, Any]) -> tuple[list[str], int]:
    """Accept chunk IDs or aliases that expand only into delivered evidence."""
    if not isinstance(ids, list):
        return [], 1
    accepted: list[str] = []
    unresolved = 0
    for item in ids:
        if not isinstance(item, str) or not item:
            unresolved += 1
            continue
        matches = (
            [item]
            if item in sources
            else [
                key
                for key, row in sources.items()
                if item in {row.get("task_id"), row.get("conversation_id")}
            ]
        )
        if not matches:
            unresolved += 1
        accepted.extend(matches)
    return list(dict.fromkeys(accepted)), unresolved
