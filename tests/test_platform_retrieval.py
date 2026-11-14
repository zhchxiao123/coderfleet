from __future__ import annotations
import asyncio, json
from pathlib import Path
import pytest
from test_platform_agent import configured, ResultRuntime
from coderfleet.server.platform_agent import PlatformRequest


def test_agent_can_search_read_and_cite_without_eagerly_loading_chat_logs(
    tmp_path, monkeypatch
):
    from coderfleet.server.platform_retrieval import PlatformReader

    scheduler, harness = configured(tmp_path, monkeypatch, ResultRuntime(tmp_path))
    # A query must create only a catalog; no full snapshot scan at submission.
    import coderfleet.server.platform_agent as module

    monkeypatch.setattr(
        module, "build_snapshot", lambda *a, **k: pytest.fail("eager full-log scan")
    )

    async def drive():
        record = await harness.create(
            PlatformRequest(
                request_id="retrieval",
                kind="query",
                question="查找 Original 的聊天",
                date="2026-11-12",
            )
        )
        task = scheduler.get_task(record["task_id"])
        reader = PlatformReader(scheduler, record["id"])
        assert (
            reader.call("list_tasks", {"query": "Original"})["tasks"][0]["id"]
            == "fixture"
        )
        page = reader.call("read_task", {"task_id": "fixture"})
        assert any(row["text"] == "Answer" for row in page["activities"])
        assert reader.sources()[page["activities"][0]["id"]]["task_id"] == "fixture"
        with pytest.raises(ValueError):
            reader.call("read_task", {"task_id": "outside"})
        assert "Original question" not in task.prompt and len(task.prompt) < 3000
        await asyncio.gather(*list(scheduler._running.values()), return_exceptions=True)

    asyncio.run(drive())


def test_catalog_keeps_original_question_and_log_prefix_after_task_changes(
    tmp_path, monkeypatch
):
    from coderfleet.server.platform_retrieval import PlatformReader, make_catalog
    from coderfleet.server.platform_agent import _write
    from coderfleet.server.models import TaskStatus

    scheduler, harness = configured(tmp_path, monkeypatch, ResultRuntime(tmp_path))
    task = scheduler.get_task("fixture")
    task.status = TaskStatus.pending
    task.finished = None
    task.save(scheduler.tasks_dir)
    identifier = "b" * 32
    directory = harness._path(identifier)
    catalog = make_catalog(scheduler, "2026-11-12", "UTC", None)
    _write(directory / "catalog.json", catalog)
    _write(
        directory / "run.json",
        {
            "request": {"parent_run_id": ""},
            "scope": {"projects": None},
            "task_id": "",
            "settings": {"max_turns": 24},
        },
    )
    task.prompt = "AFTER CUTOFF edit"
    task.save(scheduler.tasks_dir)
    with scheduler.get_log_path(task.id).open("a") as stream:
        stream.write('{"type":"result","result":"AFTER CUTOFF append"}\n')
    reader = PlatformReader(scheduler, identifier)
    result = reader.call("read_task", {"task_id": "fixture"})
    assert result["activities"][0]["text"] == "Original question"
    assert all("AFTER CUTOFF" not in row["text"] for row in result["activities"])
    assert "task_records" not in reader.call("catalog", {})


def test_frozen_retrieval_retains_needs_answer_without_control_secrets(
    tmp_path, monkeypatch
):
    from coderfleet.server.platform_retrieval import PlatformReader, make_catalog
    from coderfleet.server.platform_agent import _write
    from coderfleet.server.models import PendingIntervention

    scheduler, harness = configured(tmp_path, monkeypatch, ResultRuntime(tmp_path))
    task = scheduler.get_task("fixture")
    task.pending_intervention = PendingIntervention(
        tool_call_id="pending",
        token="private-control-token",
        deadline="2026-11-13T00:00:00Z",
    )
    task.save(scheduler.tasks_dir)
    identifier = "c" * 32
    directory = harness._path(identifier)
    catalog = make_catalog(scheduler, "2026-11-12", "UTC", None)
    assert "private-control-token" not in json.dumps(catalog)
    _write(directory / "catalog.json", catalog)
    _write(
        directory / "run.json",
        {
            "request": {"parent_run_id": ""},
            "scope": {"projects": None},
            "task_id": "",
            "settings": {"max_turns": 24},
        },
    )
    reader = PlatformReader(scheduler, identifier)
    assert reader.call("get_task", {"task_id": "fixture"})["needs_answer"]
    assert all(
        row["needs_answer"]
        for row in reader.call("read_task", {"task_id": "fixture"})["activities"]
    )


@pytest.mark.parametrize("remove_source", [False, True])
def test_legacy_daily_frozen_content_survives_two_query_followups(
    tmp_path, monkeypatch, remove_source
):
    from coderfleet.server.platform_retrieval import PlatformReader

    scheduler, harness = configured(tmp_path, monkeypatch, ResultRuntime(tmp_path))

    async def drive():
        root = await harness.create(
            PlatformRequest(request_id="legacy-root", date="2026-11-12")
        )
        await asyncio.gather(*list(scheduler._running.values()))
        root = harness.get(root["id"])
        task = scheduler.get_task("fixture")
        task.prompt = "AFTER daily cutoff edit"
        task.save(scheduler.tasks_dir)
        if remove_source:
            (scheduler.tasks_dir / "fixture.json").unlink()
            scheduler.get_log_path("fixture").unlink()
        for identity in ("legacy-query1", "legacy-query2"):
            child = await harness.create(
                PlatformRequest(
                    request_id=identity,
                    kind="query",
                    question="读原问题",
                    date="2026-11-12",
                    parent_run_id=root["id"],
                )
            )
            await asyncio.gather(*list(scheduler._running.values()))
            root = harness.get(child["id"])
            assert PlatformReader(scheduler, root["id"]).call("catalog", {})[
                "projects"
            ] == ["business"]
            rows = PlatformReader(scheduler, root["id"]).call(
                "read_task", {"task_id": "fixture"}
            )["activities"]
            assert rows[0]["text"] == "Original question"

    asyncio.run(drive())


def test_agent_can_select_a_week_without_loading_logs_or_widening_project_scope(
    tmp_path, monkeypatch
):
    from coderfleet.server.platform_retrieval import PlatformReader

    scheduler, harness = configured(tmp_path, monkeypatch, ResultRuntime(tmp_path))

    async def drive():
        record = await harness.create(
            PlatformRequest(
                request_id="weekly",
                kind="query",
                question="分析这周工作",
                date="2026-11-12",
                projects=["business"],
            )
        )
        reader = PlatformReader(scheduler, record["id"])
        value = reader.call(
            "select_period", {"start_date": "2026-11-10", "end_date": "2026-11-16"}
        )
        assert value["start_date"] == "2026-11-10" and value["end_date"] == "2026-11-16"
        assert reader.call("list_tasks", {})["tasks"][0]["project_name"] == "business"
        assert not (reader.directory / "retrieval").exists()
        reader.call("read_task", {"task_id": "fixture"})
        assert harness.get(record["id"])["progress"]["read"] > 0
        await asyncio.gather(*list(scheduler._running.values()))

    asyncio.run(drive())
