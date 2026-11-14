from __future__ import annotations

import asyncio
import json
from pathlib import Path

from coderfleet.server.models import AccountType, Task, TaskStatus
from coderfleet.server.runtime import FakeProcess, FakeRuntime
from coderfleet.server.scheduler import Scheduler


def test_platform_run_uses_an_isolated_readonly_snapshot_and_a_durable_task(
    tmp_path, monkeypatch
):
    from coderfleet.server.platform_agent import (
        PlatformHarness,
        PlatformRequest,
        PlatformSettings,
    )

    (tmp_path / "accounts.conf").write_text(
        "NAME=alice TYPE=claude PROXY=off CLAUDE_BACKEND=sdk\n"
    )
    seen = []

    class Runtime(FakeRuntime):
        async def exec(self, *args, **kwargs):
            return FakeProcess(stdout_chunks=[b'{"alive":false}'])

        async def run(self, spec):
            seen.append(spec)
            request = json.loads(
                next((tmp_path / "platform").rglob("*.sdk.json")).read_text()
            )
            snapshot = json.loads(
                next((tmp_path / "platform").rglob("snapshot.json")).read_text()
            )
            ids = [row["id"] for row in snapshot["activities"]]
            events = [
                {
                    "type": "system",
                    "subtype": "coderfleet_platform_coverage",
                    "task_id": request["task_id"],
                    "snapshot_fingerprint": snapshot["fingerprint"],
                    "manifest_read": True,
                    "source_ids": ids,
                    "read": len(ids),
                    "total": len(ids),
                    "complete": True,
                },
                {
                    "type": "result",
                    "subtype": "success",
                    "is_error": False,
                    "structured_output": {
                        "answer_markdown": "Reviewed work",
                        "source_ids": ids,
                    },
                },
            ]
            return FakeProcess(
                stdout_chunks=[
                    ("\n".join(json.dumps(row) for row in events) + "\n").encode()
                ]
            )

    scheduler = Scheduler(tmp_path, runtime=Runtime())
    monkeypatch.setattr(scheduler, "_get_ephemeral_network", lambda _account: None)
    source = Task(
        id="source-task",
        account="alice",
        type=AccountType.claude,
        status=TaskStatus.done,
        prompt="Review work",
        project="/business-project",
        project_name="business",
        created="2026-11-12T10:00:00Z",
        finished="2026-11-12T10:01:00Z",
    )
    source.save(scheduler.tasks_dir)
    scheduler.get_log_path(source.id).write_text(
        '{"type":"result","result":"Work result"}\n'
    )
    harness = PlatformHarness(scheduler)
    harness.configure(
        PlatformSettings(account="alice", timezone="UTC", image="fixture:platform")
    )
    request = PlatformRequest(request_id="one", date="2026-11-12")

    async def run():
        record = await harness.create(request)
        assert record["task_id"] != source.id
        await asyncio.gather(*list(scheduler._running.values()))
        return harness.get(record["id"])

    record = asyncio.run(run())
    assert record["status"] == "ready" and record["answer_markdown"] == "Reviewed work"
    assert record["coverage"]["read"] == record["coverage"]["total"]
    assert len(seen) == 1 and seen[0].image == "fixture:platform"
    assert "/business-project" not in str(seen[0].mounts)
    assert any(
        target == "/platform-data/snapshot.json:ro"
        for _source, target in seen[0].mounts
    )
    assert not any("docker.sock" in target for _source, target in seen[0].mounts)
    fresh = PlatformHarness(Scheduler(tmp_path, runtime=FakeRuntime()))
    assert fresh.get(record["id"])["answer_markdown"] == "Reviewed work"
    assert asyncio.run(fresh.create(request))["task_id"] == record["task_id"]


def configured(tmp_path, monkeypatch, runtime):
    from coderfleet.server.platform_agent import PlatformHarness, PlatformSettings

    (tmp_path / "accounts.conf").write_text(
        "NAME=alice TYPE=claude PROXY=off CLAUDE_BACKEND=sdk\n"
    )
    scheduler = Scheduler(tmp_path, runtime=runtime)
    monkeypatch.setattr(scheduler, "_get_ephemeral_network", lambda _account: None)
    task = Task(
        id="fixture",
        account="alice",
        type=AccountType.claude,
        status=TaskStatus.done,
        prompt="Original question",
        project="/business",
        project_name="business",
        created="2026-11-12T10:00:00Z",
        finished="2026-11-12T10:01:00Z",
    )
    task.save(scheduler.tasks_dir)
    scheduler.get_log_path(task.id).write_text('{"type":"result","result":"Answer"}\n')
    harness = PlatformHarness(scheduler)
    harness.configure(PlatformSettings(account="alice", image="fixture:platform"))
    return scheduler, harness


class ResultRuntime(FakeRuntime):
    def __init__(
        self, root, *, unread_citation=False, subset=False, read_limited=False
    ):
        super().__init__()
        self.root = root
        self.unread_citation = unread_citation
        self.subset = subset
        self.read_limited = read_limited

    async def exec(self, *args, **kwargs):
        return FakeProcess(stdout_chunks=[b'{"alive":false}'])

    async def run(self, spec):
        self.runs.append(spec)
        workspace = Path(
            next(source for source, target in spec.mounts if target == "/workspace")
        )
        request = json.loads(
            next((workspace / ".coderfleet-tasks").glob("*.sdk.json")).read_text()
        )
        if request.get("platform_snapshot"):
            snapshot = json.loads(
                Path(
                    next(
                        source
                        for source, target in spec.mounts
                        if target == "/platform-data/snapshot.json:ro"
                    )
                ).read_text()
            )
            ids = [item["id"] for item in snapshot["activities"]]
        else:
            from coderfleet.server.platform_retrieval import PlatformReader

            reader = PlatformReader(
                Scheduler(self.root, runtime=FakeRuntime()), workspace.parent.name
            )
            for task in reader.call("list_tasks", {})["tasks"]:
                reader.call(
                    "read_task",
                    {"task_id": task["id"], "limit": 1 if self.subset else 20},
                )
            ids = list(reader.sources())
            snapshot = reader.catalog
            if self.read_limited:
                (workspace.parent / "retrieval-status.json").write_text(
                    json.dumps({"read_limit_reached": True, "warnings": []})
                )
        read = ids[:1] if self.subset or self.unread_citation else ids
        events = [
            {
                "type": "system",
                "subtype": "coderfleet_platform_coverage",
                "task_id": request["task_id"],
                "snapshot_fingerprint": snapshot["fingerprint"],
                "manifest_read": True,
                "source_ids": read,
                "read_limit_reached": self.read_limited,
            },
            {
                "type": "result",
                "subtype": "success",
                "is_error": False,
                "structured_output": {
                    "answer_markdown": "Report",
                    "source_ids": ids if self.unread_citation else read,
                },
            },
        ]
        return FakeProcess(
            stdout_chunks=[
                ("\n".join(json.dumps(row) for row in events) + "\n").encode()
            ]
        )


def test_same_request_is_single_execution_conflicting_payload_is_rejected_and_artifact_survives_log_removal(
    tmp_path, monkeypatch
):
    from coderfleet.server.platform_agent import PlatformConflict, PlatformRequest
    import pytest

    runtime = ResultRuntime(tmp_path)
    scheduler, harness = configured(tmp_path, monkeypatch, runtime)
    request = PlatformRequest(request_id="same", date="2026-11-12")

    async def drive():
        first, second = await asyncio.gather(
            harness.create(request), harness.create(request)
        )
        assert first["id"] == second["id"]
        with pytest.raises(PlatformConflict):
            await harness.create(request.model_copy(update={"question": "different"}))
        await asyncio.gather(*list(scheduler._running.values()))
        record = harness.get(first["id"])
        assert record["status"] == "ready"
        # Completed artifacts are durable even if ordinary Task retention cleans logs/state.
        scheduler.get_log_path(record["task_id"]).unlink()
        (scheduler.tasks_dir / (record["task_id"] + ".json")).unlink()
        assert harness.get(record["id"])["answer_markdown"] == "Report"
        assert harness.source(record["id"], record["sources"][0]["id"])["text"]

    asyncio.run(drive())
    assert len(runtime.runs) == 1


def test_incomplete_daily_report_is_partial_and_unread_citations_fail_closed(
    tmp_path, monkeypatch
):
    from coderfleet.server.platform_agent import PlatformRequest

    async def drive():
        runtime = ResultRuntime(tmp_path, subset=True)
        scheduler, harness = configured(tmp_path, monkeypatch, runtime)
        record = await harness.create(
            PlatformRequest(request_id="partial", date="2026-11-12")
        )
        await asyncio.gather(*list(scheduler._running.values()))
        record = harness.get(record["id"])
        assert record["status"] == "partial"
        assert record["coverage"]["read"] == 1 and record["coverage"]["total"] == 2
        runtime.unread_citation = True
        record = await harness.create(
            PlatformRequest(request_id="bad-citation", date="2026-11-12")
        )
        await asyncio.gather(*list(scheduler._running.values()))
        record = harness.get(record["id"])
        assert record["status"] == "error"
        assert "未读取" in record["error"]

    asyncio.run(drive())


def test_cancellation_during_snapshot_preparation_never_submits_task(
    tmp_path, monkeypatch
):
    from coderfleet.server.platform_agent import PlatformRequest
    import threading
    import coderfleet.server.platform_agent as module

    started = threading.Event()
    release = threading.Event()
    original = module.build_snapshot

    def delayed(*args, **kwargs):
        started.set()
        assert release.wait(5)
        return original(*args, **kwargs)

    scheduler, harness = configured(tmp_path, monkeypatch, FakeRuntime())
    monkeypatch.setattr(module, "build_snapshot", delayed)

    async def drive():
        create = asyncio.create_task(
            harness.create(PlatformRequest(request_id="cancel", date="2026-11-12"))
        )
        assert await asyncio.to_thread(started.wait, 3)
        identifier = next((tmp_path / "platform/runs").iterdir()).name
        assert (await harness.cancel(identifier))["status"] == "cancelled"
        release.set()
        record = await create
        assert record["status"] == "cancelled" and not record["task_id"]

    asyncio.run(drive())
    assert len(scheduler.list_tasks()) == 1


def test_auto_reports_are_disabled_by_default_and_use_durable_ids_when_enabled(
    tmp_path, monkeypatch
):
    from coderfleet.server.platform_agent import PlatformRequest

    scheduler, harness = configured(tmp_path, monkeypatch, FakeRuntime())
    calls = []

    async def create(request):
        calls.append(request)
        return {}

    monkeypatch.setattr(harness, "create", create)
    asyncio.run(harness.tick())
    assert calls == []
    (tmp_path / "config.conf").write_text("DIGEST_ENABLED=on\n")
    asyncio.run(harness.tick())
    assert len(calls) == 1 and calls[0].request_id.startswith("auto:UTC:")


def test_cancel_running_platform_task_uses_existing_task_kill_and_keeps_snapshot(
    tmp_path, monkeypatch
):
    from coderfleet.server.platform_agent import PlatformRequest

    class Waiting:
        async def read(self, n=-1):
            await asyncio.Event().wait()
            return b""

    class Runtime(FakeRuntime):
        def __init__(self):
            super().__init__()
            self.started = asyncio.Event()

        async def run(self, spec):
            self.runs.append(spec)
            self.started.set()
            process = FakeProcess()
            process.stdout = Waiting()
            return process

        async def exec(self, *args, **kwargs):
            return FakeProcess(stdout_chunks=[b'{"alive":false}'])

    runtime = Runtime()
    scheduler, harness = configured(tmp_path, monkeypatch, runtime)

    async def drive():
        record = await harness.create(
            PlatformRequest(request_id="stop-running", date="2026-11-12")
        )
        await asyncio.wait_for(runtime.started.wait(), 2)
        assert harness.get(record["id"])["status"] == "running"
        stopped = await harness.cancel(record["id"])
        assert stopped["status"] == "cancelled"
        assert scheduler.get_task(stopped["task_id"]).status == TaskStatus.killed
        assert (tmp_path / "platform/runs" / record["id"] / "snapshot.json").exists()
        assert runtime.removed

    asyncio.run(drive())


def test_get_never_overwrites_newer_run_metadata_when_it_discovers_a_submitted_task(
    tmp_path, monkeypatch
):
    import hashlib
    from coderfleet.server.platform_agent import PlatformRequest

    scheduler, harness = configured(tmp_path, monkeypatch, FakeRuntime())
    identifier = hashlib.sha256(b"orphan").hexdigest()[:32]
    directory = tmp_path / "platform/runs" / identifier
    directory.mkdir(parents=True)
    path = directory / "run.json"
    record = {
        "id": identifier,
        "task_id": "",
        "created": "2026-11-12T10:00:00Z",
        "owner_pid": 0,
        "error": "",
        "state": "preparing",
        "request": PlatformRequest(request_id="orphan", date="2026-11-12").model_dump(),
        "settings": harness.settings().model_dump(),
    }
    path.write_text(json.dumps(record))
    task = Task(
        id="orphan-task",
        status=TaskStatus.running,
        account="alice",
        type=AccountType.claude,
        prompt="report",
        project="/private",
        platform_run_id=identifier,
    )

    def discover(_directory):
        current = json.loads(path.read_text())
        current["manifest"] = {"fingerprint": "newer-manifest"}
        path.write_text(json.dumps(current))
        return [task]

    monkeypatch.setattr(Task, "load_all", discover)
    response = harness.get(identifier)
    assert response["task_id"] == task.id
    assert json.loads(path.read_text())["manifest"]["fingerprint"] == "newer-manifest"


def test_get_follows_a_task_submitted_during_its_discovery_scan(tmp_path, monkeypatch):
    import hashlib
    from coderfleet.server.platform_agent import PlatformRequest

    scheduler, harness = configured(tmp_path, monkeypatch, FakeRuntime())
    identifier = hashlib.sha256(b"appears").hexdigest()[:32]
    directory = tmp_path / "platform/runs" / identifier
    directory.mkdir(parents=True)
    path = directory / "run.json"
    record = {
        "id": identifier,
        "task_id": "",
        "created": "2026-11-12T10:00:00Z",
        "owner_pid": 0,
        "error": "",
        "state": "preparing",
        "request": PlatformRequest(
            request_id="appears", date="2026-11-12"
        ).model_dump(),
        "settings": harness.settings().model_dump(),
    }
    path.write_text(json.dumps(record))
    task = Task(
        id="just-submitted",
        status=TaskStatus.running,
        account="alice",
        type=AccountType.claude,
        prompt="report",
        project="/private",
        platform_run_id=identifier,
    )

    def discover(_directory):
        task.save(scheduler.tasks_dir)
        current = json.loads(path.read_text())
        current.update(task_id=task.id, state="submitted")
        path.write_text(json.dumps(current))
        return []

    monkeypatch.setattr(Task, "load_all", discover)
    assert harness.get(identifier)["status"] == "running"


def test_limit_failure_exposes_the_real_reason_and_read_coverage(tmp_path, monkeypatch):
    from coderfleet.server.platform_agent import PlatformRequest

    class LimitedRuntime(ResultRuntime):
        async def run(self, spec):
            await super().run(spec)
            workspace = Path(
                next(src for src, dst in spec.mounts if dst == "/workspace")
            )
            request = json.loads(
                next((workspace / ".coderfleet-tasks").glob("*.sdk.json")).read_text()
            )
            snapshot = json.loads(
                Path(
                    next(
                        src
                        for src, dst in spec.mounts
                        if dst == "/platform-data/snapshot.json:ro"
                    )
                ).read_text()
            )
            events = [
                {
                    "type": "result",
                    "subtype": "error_max_turns",
                    "is_error": True,
                    "num_turns": 25,
                    "terminal_reason": "max_turns",
                },
                {
                    "type": "system",
                    "subtype": "coderfleet_platform_coverage",
                    "task_id": request["task_id"],
                    "snapshot_fingerprint": snapshot["fingerprint"],
                    "read": 1,
                    "total": 2,
                    "manifest_read": True,
                    "source_ids": [snapshot["activities"][0]["id"]],
                },
            ]
            return FakeProcess(
                returncode=1,
                stdout_chunks=[
                    ("\n".join(json.dumps(row) for row in events) + "\n").encode()
                ],
            )

    scheduler, harness = configured(tmp_path, monkeypatch, LimitedRuntime(tmp_path))

    async def drive():
        record = await harness.create(
            PlatformRequest(request_id="limited", date="2026-11-12")
        )
        await asyncio.gather(*list(scheduler._running.values()))
        result = harness.get(record["id"])
        assert result["status"] == "error" and result["failure_reason"] == "max_turns"
        assert (
            result["coverage"]["read"] == 1
            and "24" in result["error"]
            and "1/2" in result["error"]
        )

    asyncio.run(drive())


def test_query_that_stops_reading_for_budget_is_marked_partial(tmp_path, monkeypatch):
    from coderfleet.server.platform_agent import PlatformRequest

    scheduler, harness = configured(
        tmp_path, monkeypatch, ResultRuntime(tmp_path, subset=True, read_limited=True)
    )

    async def drive():
        record = await harness.create(
            PlatformRequest(
                request_id="partial",
                kind="query",
                question="今天做了哪些事情",
                date="2026-11-12",
            )
        )
        await asyncio.gather(*list(scheduler._running.values()))
        result = harness.get(record["id"])
        assert result["status"] == "partial" and result["answer_markdown"] == "Report"
        assert result["coverage"]["read"] == 1 and not result["coverage"]["complete"]
        assert any("轮次预算" in warning for warning in result["coverage"]["warnings"])

    asyncio.run(drive())


def test_task_id_citations_resolve_only_to_retrieved_chunks_and_keep_the_answer(
    tmp_path, monkeypatch
):
    from coderfleet.server.platform_output import resolve_citations

    rows = {
        "chunk-a": {"task_id": "task-a", "conversation_id": "chat-a"},
        "chunk-b": {"task_id": "task-a", "conversation_id": "chat-a"},
    }
    ids, unresolved = resolve_citations(["task-a", "unread-task", "chunk-a"], rows)
    assert ids == ["chunk-a", "chunk-b"] and unresolved == 1


def test_query_with_task_alias_and_one_bad_citation_keeps_answer_and_verified_links(
    tmp_path, monkeypatch
):
    from coderfleet.server.platform_agent import PlatformRequest

    class AliasRuntime(ResultRuntime):
        async def run(self, spec):
            process = await super().run(spec)
            events = [
                json.loads(line)
                for line in (await process.stdout.read()).decode().splitlines()
            ]
            events[-1]["structured_output"]["source_ids"] = ["fixture", "unread-task"]
            return FakeProcess(
                stdout_chunks=[
                    ("\n".join(json.dumps(e) for e in events) + "\n").encode()
                ]
            )

    scheduler, harness = configured(tmp_path, monkeypatch, AliasRuntime(tmp_path))

    async def drive():
        record = await harness.create(
            PlatformRequest(
                request_id="alias-query",
                kind="query",
                question="汇总工作",
                date="2026-11-12",
            )
        )
        await asyncio.gather(*list(scheduler._running.values()))
        record = harness.get(record["id"])
        assert record["status"] == "partial" and record["answer_markdown"] == "Report"
        assert len(record["sources"]) == 2 and all(
            s["task_id"] == "fixture" for s in record["sources"]
        )
        assert any("1 条引用" in w for w in record["coverage"]["warnings"])

    asyncio.run(drive())
