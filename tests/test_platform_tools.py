from __future__ import annotations

import pytest


def test_read_tools_page_the_whole_snapshot_and_only_count_returned_sources():
    from coderfleet.data.scripts.coderfleet_platform_tools import ActivityReader

    snapshot = {
        "fingerprint": "fixture",
        "date": "2026-11-12",
        "timezone": "America/Los_Angeles",
        "window": {},
        "projects": ["one"],
        "tasks": [],
        "coverage": {},
        "activities": [
            {"id": f"e{index}", "project_name": "one", "text": f"Public {index}"}
            for index in range(25)
        ],
    }
    reader = ActivityReader(snapshot)
    reader.call("manifest", {})
    first = reader.call("read_activities", {"offset": 0, "limit": 20})
    assert first["next_offset"] == 20 and len(first["activities"]) == 20
    assert reader.coverage()["complete"] is False
    assert (
        len(reader.call("read_activities", {"offset": 20, "limit": 20})["activities"])
        == 5
    )
    assert reader.coverage() == {
        "snapshot_fingerprint": "fixture",
        "read": 25,
        "total": 25,
        "complete": True,
        "manifest_read": True,
        "read_limit_reached": False,
    }
    with pytest.raises(PermissionError):
        reader.call("read_activities", {"project": "other"})
    with pytest.raises(ValueError):
        reader.call("get_activity", {"id": "../../credentials.json"})
    with pytest.raises(ValueError):
        reader.call("execute", {"command": "touch /workspace/file"})


def test_pages_are_byte_bounded_so_sdk_tool_output_cannot_silently_drop_sources():
    import json
    from coderfleet.data.scripts.coderfleet_platform_tools import ActivityReader

    reader = ActivityReader(
        {
            "fingerprint": "large",
            "projects": ["one"],
            "activities": [
                {"id": str(index), "project_name": "one", "text": "汉字" * 1000}
                for index in range(20)
            ],
        }
    )
    reader.call("manifest", {})
    offset = 0
    seen = []
    while True:
        page = reader.call("read_activities", {"offset": offset, "limit": 20})
        assert len(json.dumps(page, ensure_ascii=False).encode()) < 20000
        seen.extend(item["id"] for item in page["activities"])
        if page["next_offset"] is None:
            break
        offset = page["next_offset"]
    assert seen == [str(index) for index in range(20)] and reader.coverage()["complete"]


def test_manifest_is_a_bounded_summary_not_an_unbounded_task_inventory():
    import json
    from coderfleet.data.scripts.coderfleet_platform_tools import ActivityReader

    reader = ActivityReader(
        {
            "fingerprint": "many",
            "projects": ["one"],
            "coverage": {},
            "activities": [],
            "tasks": [
                {
                    "task_id": str(index),
                    "project_name": "one",
                    "status": "done",
                    "needs_answer": False,
                    "tokens_input": 10,
                    "tokens_output": 5,
                    "cost_usd": 0.01,
                }
                for index in range(500)
            ],
        }
    )
    manifest = reader.call("manifest", {})
    assert "tasks" not in manifest and manifest["task_status_totals"] == {"done": 500}
    assert manifest["resources"]["tokens_input"] == 5000
    assert len(json.dumps(manifest).encode()) < 16000
    assert reader.coverage()["manifest_read"] and reader.coverage()["complete"]


def test_large_snapshot_has_a_parallel_read_plan_and_still_returns_every_text():
    import math
    from coderfleet.data.scripts.coderfleet_platform_tools import ActivityReader

    activities = [
        {
            "id": f"source-{i}",
            "text": "public conclusion " * 65,
            "project_name": "project",
            "kind": "reply",
            "task_status": "done",
            "source": {"private_host_metadata": "x" * 300},
        }
        for i in range(538)
    ]
    reader = ActivityReader(
        {
            "fingerprint": "large",
            "activities": activities,
            "tasks": [],
            "projects": ["project"],
            "coverage": {},
        }
    )
    manifest = reader.call("manifest", {})
    plan = manifest["reading_plan"]
    assert len(plan["pages"]) > 20 and plan["parallel_pages"] == 4
    assert math.ceil(len(plan["pages"]) / plan["parallel_pages"]) + 3 < 24
    seen = []
    for page in plan["pages"]:
        result = reader.call("read_activities", page)
        seen.extend(result["activities"])
    assert {row["id"] for row in seen} == {row["id"] for row in activities}
    assert all(
        row["text"] == activities[int(row["id"].split("-")[1])]["text"] for row in seen
    )
    assert all("source" not in row for row in seen)


def test_reader_reserves_answer_turns_and_reports_progress():
    from coderfleet.data.scripts.coderfleet_platform_tools import ActivityReader

    reader = ActivityReader(
        {
            "fingerprint": "bounded",
            "activities": [{"id": "one", "text": "evidence", "project_name": "p"}],
            "projects": ["p"],
        },
        max_turns=6,
    )
    progress = []
    reader.on_progress = progress.append
    reader.call("manifest", {})
    for number in range(3):
        reader.observe({"type": "assistant", "message": {"id": str(number)}})
        reader.observe({"type": "assistant", "message": {"id": str(number)}})
        reader.observe(
            {
                "type": "assistant",
                "parent_tool_use_id": "child",
                "message": {"id": "nested"},
            }
        )
    stopped = reader.call("read_activities", {"limit": 100})
    assert stopped["finish_now"] and reader.coverage()["read"] == 0
    assert reader.coverage()["read_limit_reached"]
    assert progress[-1]["phase"] == "composing" and progress[-1]["turns_used"] == 3
