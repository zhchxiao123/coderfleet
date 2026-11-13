from __future__ import annotations

import json
from pathlib import Path

from coderfleet.server.models import AccountType, Task, TaskStatus


def add_task(root: Path, identifier: str, **updates: object) -> Task:
    values = dict(
        id=identifier,
        status=TaskStatus.done,
        account="alice",
        type=AccountType.claude,
        prompt=f"Question {identifier}",
        project="/project",
        project_name="project",
        created="2026-11-12T16:00:00Z",
        finished="2026-11-12T17:00:00Z",
    )
    values.update(updates)
    task = Task(**values)
    task.save(root / "tasks")
    (root / "tasks" / f"{identifier}.log").write_text(
        json.dumps(
            {"type": "result", "subtype": "success", "result": f"Answer {identifier}"}
        )
        + "\n"
    )
    return task


def test_snapshot_includes_all_project_tasks_and_uses_the_requested_timezone(tmp_path):
    from coderfleet.server.platform_activity import build_snapshot

    for index in range(13):
        add_task(tmp_path, f"task-{index}")
    add_task(tmp_path, "evening", finished="2026-11-13T02:00:00Z")
    snapshot = build_snapshot(
        tmp_path, "2026-11-12", "America/Los_Angeles", as_of="2026-11-13T08:00:00Z"
    )
    assert len(snapshot["tasks"]) == 14
    assert {item["task_id"] for item in snapshot["activities"]} == {
        f"task-{index}" for index in range(13)
    } | {"evening"}
    assert snapshot["window"]["start"] == "2026-11-12T08:00:00+00:00"
    assert snapshot["window"]["end"] == "2026-11-13T08:00:00+00:00"
    assert all(
        item["source"]["task_id"] == item["task_id"] for item in snapshot["activities"]
    )
    assert "Answer task-12" in "\n".join(
        item["text"] for item in snapshot["activities"]
    )


def test_cross_day_questions_answers_and_supplements_are_public_and_scoped(tmp_path):
    from coderfleet.server.platform_activity import build_snapshot

    task = add_task(
        tmp_path,
        "ongoing",
        status=TaskStatus.running,
        created="2026-11-11T18:00:00Z",
        finished=None,
    )
    events = [
        {
            "type": "system",
            "subtype": "coderfleet_message_accepted",
            "request_id": "m1",
            "timestamp": "2026-11-12T18:00:00Z",
            "text": "Please use option B",
        },
        {
            "type": "assistant",
            "timestamp": "2026-11-12T18:01:00Z",
            "message": {
                "id": "answer",
                "content": [
                    {"type": "thinking", "thinking": "PRIVATE_THOUGHT"},
                    {"type": "text", "text": "Public conclusion"},
                ],
            },
        },
        {
            "type": "assistant",
            "timestamp": "2026-11-12T18:02:00Z",
            "message": {
                "content": [
                    {
                        "type": "tool_use",
                        "id": "q1",
                        "name": "AskUserQuestion",
                        "input": {"questions": [{"question": "Which target?"}]},
                    }
                ]
            },
        },
        {
            "type": "user",
            "timestamp": "2026-11-12T18:03:00Z",
            "message": {
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "q1",
                        "content": '{"answers":{"Which target?":"Mac"}}',
                    }
                ]
            },
        },
        {
            "type": "assistant",
            "timestamp": "2026-11-13T18:04:00Z",
            "message": {"content": [{"type": "text", "text": "NEXT_DAY_REPLY"}]},
        },
    ]
    (tmp_path / "tasks" / f"{task.id}.log").write_text(
        "\n".join(json.dumps(event) for event in events) + "\n"
    )
    add_task(tmp_path, "foreign", project_name="another-project")
    snapshot = build_snapshot(
        tmp_path,
        "2026-11-12",
        "America/Los_Angeles",
        ["project"],
        as_of="2026-11-13T08:00:00Z",
    )
    text = "\n".join(item["text"] for item in snapshot["activities"])
    assert {"context", "supplement", "reply", "agent_question", "human_answer"} <= {
        item["kind"] for item in snapshot["activities"]
    }
    assert (
        "Please use option B" in text and "Public conclusion" in text and "Mac" in text
    )
    assert (
        "PRIVATE_THOUGHT" not in text
        and "NEXT_DAY_REPLY" not in text
        and "foreign" not in text
    )


def test_clock_frames_redaction_chunks_and_dst_boundary(tmp_path):
    import hashlib
    from coderfleet.server.platform_activity import build_snapshot

    task = add_task(
        tmp_path,
        "timed",
        created="2026-11-01T08:00:00Z",
        finished="2026-11-02T07:30:00Z",
        prompt="api_key=private-secret-token and " + ("hello " * 3000),
    )
    (tmp_path / "config.conf").write_text("API_KEY=private-secret-token\n")
    event = {
        "type": "assistant",
        "message": {
            "id": "m",
            "content": [{"type": "text", "text": "A public outcome"}],
        },
    }
    line = json.dumps(event)
    clock = {
        "type": "system",
        "subtype": "coderfleet_event_clock",
        "event_hash": hashlib.sha256(line.encode()).hexdigest(),
        "at": "2026-11-02T07:00:00Z",
    }
    (tmp_path / "tasks" / f"{task.id}.log").write_text(
        line + "\n" + json.dumps(clock) + "\n"
    )
    snapshot = build_snapshot(
        tmp_path, "2026-11-01", "America/Los_Angeles", as_of="2026-11-03T00:00:00Z"
    )
    assert snapshot["window"]["start"] == "2026-11-01T07:00:00+00:00"
    assert snapshot["window"]["end"] == "2026-11-02T08:00:00+00:00"  # 25-hour DST day
    assert len([row for row in snapshot["activities"] if row["kind"] == "question"]) > 1
    assert "private-secret-token" not in json.dumps(snapshot)
    reply = next(row for row in snapshot["activities"] if row["kind"] == "reply")
    assert reply["at"] == "2026-11-02T07:00:00+00:00" and not reply["time_estimated"]


def test_platform_tasks_and_private_payloads_are_not_reingested(tmp_path):
    from coderfleet.server.platform_activity import build_snapshot

    add_task(
        tmp_path, "internal", platform_run_id="a" * 32, prompt="PRIVATE PLATFORM INPUT"
    )
    task = add_task(tmp_path, "business")
    events = [
        {"type": "assistant", "message": None},
        {
            "type": "assistant",
            "message": {
                "content": [
                    {"type": "tool_use", "name": "AskUserQuestion", "input": None}
                ]
            },
        },
        {
            "type": "user",
            "message": {
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": [],
                        "content": "PRIVATE TOOL OUTPUT",
                    }
                ]
            },
        },
        {
            "type": "assistant",
            "parent_tool_use_id": "agent",
            "message": {"content": [{"type": "text", "text": "PRIVATE CHILD CONTENT"}]},
        },
        {
            "type": "result",
            "result": "Public conclusion",
            "raw_payload": "PRIVATE RAW PAYLOAD",
        },
    ]
    (tmp_path / "tasks" / f"{task.id}.log").write_text(
        "\n".join(json.dumps(event) for event in events)
    )
    snapshot = build_snapshot(
        tmp_path, "2026-11-12", "UTC", as_of="2026-11-13T00:00:00Z"
    )
    assert len(snapshot["tasks"]) == 1
    assert "Public conclusion" in str(snapshot) and "PRIVATE" not in str(snapshot)


def test_other_provider_public_final_answers_are_included(tmp_path):
    from coderfleet.server.platform_activity import build_snapshot

    task = add_task(tmp_path, "codex", type=AccountType.codex)
    (tmp_path / "tasks" / f"{task.id}.log").write_text(
        json.dumps(
            {
                "type": "item.completed",
                "item": {"type": "agent_message", "text": "Codex conclusion"},
            }
        )
        + "\n"
    )
    snapshot = build_snapshot(
        tmp_path, "2026-11-12", "UTC", as_of="2026-11-13T00:00:00Z"
    )
    assert "Codex conclusion" in str(snapshot)


def test_unknown_project_scope_is_rejected_and_legacy_stats_exclude_report_tasks(
    tmp_path,
):
    import pytest
    from coderfleet.server.platform_activity import build_snapshot
    from coderfleet.server.digest import compute_daily_stats, list_active_dates

    add_task(tmp_path, "work")
    add_task(
        tmp_path,
        "internal-report",
        platform_run_id="a" * 32,
        created="2026-11-14T12:00:00Z",
        finished="2026-11-14T13:00:00Z",
    )
    with pytest.raises(ValueError, match="未知项目"):
        build_snapshot(
            tmp_path, "2026-11-12", "UTC", ["typo"], as_of="2026-11-13T00:00:00Z"
        )
    assert compute_daily_stats("2026-11-14", tmp_path / "tasks").total_done == 0
    assert list_active_dates(tmp_path / "tasks") == ["2026-11-12"]


def test_legacy_mcp_question_and_human_answer_are_not_lost(tmp_path):
    from coderfleet.server.platform_activity import build_snapshot

    task = add_task(tmp_path, "mcp-question")
    events = [
        {
            "type": "assistant",
            "message": {
                "content": [
                    {
                        "type": "tool_use",
                        "name": "mcp__coderfleet__ask_user_question",
                        "id": "legacy-q",
                        "input": {"questions": [{"question": "Which target?"}]},
                    }
                ]
            },
        },
        {
            "type": "user",
            "message": {
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "legacy-q",
                        "content": '{"answers":{"Which target?":"Mac"}}',
                    }
                ]
            },
        },
    ]
    (tmp_path / "tasks" / f"{task.id}.log").write_text(
        "\n".join(json.dumps(event) for event in events)
    )
    snapshot = build_snapshot(
        tmp_path, "2026-11-12", "UTC", as_of="2026-11-13T00:00:00Z"
    )
    assert {"agent_question", "human_answer"} <= {
        row["kind"] for row in snapshot["activities"]
    }
    assert "Which target?" in str(snapshot) and "Mac" in str(snapshot)


def test_undated_events_after_cutoff_are_excluded_and_reported_as_missing_coverage(
    tmp_path,
):
    from coderfleet.server.platform_activity import build_snapshot

    add_task(
        tmp_path,
        "later",
        created="2026-11-11T10:00:00Z",
        finished="2026-11-14T10:00:00Z",
    )
    (tmp_path / "tasks/later.log").write_text(
        '{"type":"result","result":"POST_CUTOFF_REPLY"}\n'
    )
    add_task(
        tmp_path,
        "spanning",
        created="2026-11-12T23:00:00Z",
        finished="2026-11-13T01:00:00Z",
    )
    snapshot = build_snapshot(
        tmp_path, "2026-11-12", "UTC", as_of="2026-11-13T00:00:00Z"
    )
    assert "POST_CUTOFF_REPLY" not in str(snapshot)
    assert any("spanning" in warning for warning in snapshot["coverage"]["warnings"])
    assert any("later" in warning for warning in snapshot["coverage"]["warnings"])
