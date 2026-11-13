"""Progress provenance and native termination reasons use the Task boundary."""

from __future__ import annotations
import json

from coderfleet.server.platform_output import failed_output, read_progress


def test_progress_rejects_wrong_snapshot_invalid_counts_and_torn_json(tmp_path):
    directory = tmp_path / "workspace/.coderfleet-tasks"
    directory.mkdir(parents=True)
    path = directory / "task.platform-progress.json"
    valid = {
        "task_id": "task",
        "snapshot_fingerprint": "current",
        "read": 1,
        "total": 5,
        "phase": "reading",
    }
    for change in (
        {"snapshot_fingerprint": "old"},
        {"task_id": "another"},
        {"read": True},
        {"read": 6},
        {"total": -1},
    ):
        path.write_text(json.dumps({**valid, **change}))
        assert read_progress(tmp_path, "task", "current") == {}
    path.write_text("{")
    assert read_progress(tmp_path, "task", "current") == {}
    path.write_text(json.dumps({**valid, "text": "untrusted content"}))
    assert read_progress(tmp_path, "task", "current") == {
        "read": 1,
        "total": 5,
        "phase": "reading",
    }


def test_failure_keeps_native_budget_reason_ignores_synthetic_and_foreign_receipts(
    tmp_path,
):
    path = tmp_path / "task.log"
    native = {"type": "result", "subtype": "error_max_budget_usd", "is_error": True}
    receipt = {
        "type": "system",
        "subtype": "coderfleet_platform_coverage",
        "task_id": "task",
        "snapshot_fingerprint": "current",
        "source_ids": ["one", "one"],
        "total": 5,
    }
    events = [
        native,
        receipt,
        {**receipt, "snapshot_fingerprint": "other", "source_ids": []},
        {
            "type": "result",
            "coderfleet_synthetic": True,
            "subtype": "error_during_execution",
        },
    ]
    path.write_text("".join(json.dumps(e) + "\n" for e in events))
    result = failed_output(
        path, "task", {"max_turns": 24, "max_budget_usd": 2}, "current"
    )
    assert result["failure_reason"] == "max_budget_usd"
    assert result["coverage"] == {"read": 1, "total": 5, "complete": False}
    assert "$2" in result["error"] and "1/5" in result["error"]
    assert "不会自动重放" in result["error"]
