from __future__ import annotations

import asyncio
import json

import pytest

from test_platform_agent import ResultRuntime, configured
from coderfleet.server.platform_agent import (
    PlatformHarness,
    PlatformRequest,
    PlatformConflict,
)


def test_followups_inherit_the_snapshot_and_carry_the_actual_conversation(
    tmp_path, monkeypatch
):
    runtime = ResultRuntime(tmp_path)
    scheduler, harness = configured(tmp_path, monkeypatch, runtime)

    async def drive():
        first = await harness.create(
            PlatformRequest(
                request_id="chat-root",
                kind="query",
                question="What remains?",
                date="2026-11-12",
            )
        )
        await asyncio.gather(*list(scheduler._running.values()))
        first = harness.get(first["id"])
        # Newly arriving source text must not silently alter this conversation's data.
        scheduler.get_log_path("fixture").write_text(
            '{"type":"result","result":"NEW_SOURCE_AFTER_ROOT"}\n'
        )
        second_request = PlatformRequest(
            request_id="chat-reply",
            kind="query",
            question="Which one first?",
            date="2026-11-12",
            parent_run_id=first["id"],
        )
        second = await harness.create(second_request)
        await asyncio.gather(*list(scheduler._running.values()))
        second = harness.get(second["id"])
        assert (
            second["root_run_id"] == first["id"]
            and second["parent_run_id"] == first["id"]
        )
        assert second["manifest"]["fingerprint"] == first["manifest"]["fingerprint"]
        prompt = scheduler.get_task(second["task_id"]).prompt
        assert (
            "What remains?" not in prompt
            and "Report" not in prompt
            and "Which one first?" in prompt
        )
        assert (
            "NEW_SOURCE_AFTER_ROOT"
            not in (
                tmp_path / "platform/runs" / second["id"] / "catalog.json"
            ).read_text()
        )
        assert [row["id"] for row in harness.thread(second["id"])] == [
            first["id"],
            second["id"],
        ]
        assert (await harness.create(second_request))["task_id"] == second["task_id"]
        # One parent has one continuation; stale tabs cannot silently branch.
        with pytest.raises(PlatformConflict):
            await harness.create(
                second_request.model_copy(update={"request_id": "another-reply"})
            )
        with pytest.raises(ValueError, match="范围"):
            await harness.create(
                PlatformRequest(
                    request_id="different-scope",
                    kind="query",
                    question="Broaden?",
                    date="2026-11-13",
                    parent_run_id=second["id"],
                )
            )
        return first

    first = asyncio.run(drive())
    fresh = PlatformHarness(type(scheduler)(tmp_path, runtime=runtime))
    assert fresh.thread(first["id"])[0]["question"] == "What remains?"
    assert len(runtime.runs) == 2


def test_older_requests_remain_idempotent_and_context_limits_are_explicit(
    tmp_path, monkeypatch
):
    runtime = ResultRuntime(tmp_path)
    scheduler, harness = configured(tmp_path, monkeypatch, runtime)

    async def drive():
        request = PlatformRequest(
            request_id="legacy-chat",
            kind="query",
            question="Original?",
            date="2026-11-12",
        )
        record = await harness.create(request)
        await asyncio.gather(*list(scheduler._running.values()))
        directory = tmp_path / "platform/runs" / record["id"]
        path = directory / "run.json"
        stored = json.loads(path.read_text())
        stored["request"].pop("parent_run_id", None)
        stored.pop("root_run_id", None)
        path.write_text(json.dumps(stored))
        assert (await harness.create(request))["task_id"] == record["task_id"]
        # A large previous answer cannot be silently clipped into a false conversation.
        result = json.loads((directory / "result.json").read_text())
        result["answer_markdown"] = "长" * 50000
        (directory / "result.json").write_text(json.dumps(result))
        child = await harness.create(
            PlatformRequest(
                request_id="large-history",
                kind="query",
                question="Continue?",
                date="2026-11-12",
                parent_run_id=record["id"],
            )
        )
        from coderfleet.server.platform_retrieval import PlatformReader

        page = PlatformReader(scheduler, child["id"]).call("read_reply", {})
        assert len(page["answer_markdown"]) == 4000 and page["next_offset"] == 4000
        assert len(scheduler.get_task(child["task_id"]).prompt) < 3000
        await asyncio.gather(*list(scheduler._running.values()))

    asyncio.run(drive())
    assert len(runtime.runs) == 2


def test_concurrent_followups_cannot_fork_one_parent(tmp_path, monkeypatch):
    runtime = ResultRuntime(tmp_path)
    scheduler, harness = configured(tmp_path, monkeypatch, runtime)

    async def drive():
        root = await harness.create(
            PlatformRequest(request_id="serial", date="2026-11-12")
        )
        await asyncio.gather(*list(scheduler._running.values()))

        async def reply(identity):
            return await harness.create(
                PlatformRequest(
                    request_id=identity,
                    date="2026-11-12",
                    kind="query",
                    question="Next?",
                    parent_run_id=root["id"],
                )
            )

        results = await asyncio.gather(
            reply("serial-a"), reply("serial-b"), return_exceptions=True
        )
        assert sum(isinstance(value, dict) for value in results) == 1
        assert sum(isinstance(value, PlatformConflict) for value in results) == 1
        await asyncio.gather(*list(scheduler._running.values()))

    asyncio.run(drive())
    assert len(runtime.runs) == 2
    assert all("answer_markdown" not in item for item in harness.list(summary=True))


def test_followup_can_return_an_action_reply_without_fabricating_activity_citations(
    tmp_path, monkeypatch
):
    from coderfleet.server.runtime import FakeProcess

    class ActionRuntime(ResultRuntime):
        action = False

        async def run(self, spec):
            if not self.action:
                return await super().run(spec)
            workspace = next(src for src, dst in spec.mounts if dst == "/workspace")
            from pathlib import Path

            request = json.loads(
                next(
                    (Path(workspace) / ".coderfleet-tasks").glob("*.sdk.json")
                ).read_text()
            )
            snapshot = json.loads((Path(workspace).parent / "catalog.json").read_text())
            events = [
                {
                    "type": "system",
                    "subtype": "coderfleet_platform_coverage",
                    "task_id": request["task_id"],
                    "snapshot_fingerprint": snapshot["fingerprint"],
                    "manifest_read": False,
                    "source_ids": [],
                },
                {
                    "type": "result",
                    "subtype": "success",
                    "is_error": False,
                    "structured_output": {
                        "answer_markdown": "尚未连接记录服务，未保存。",
                        "source_ids": [],
                    },
                },
            ]
            return FakeProcess(
                stdout_chunks=[
                    ("\n".join(json.dumps(e) for e in events) + "\n").encode()
                ]
            )

    runtime = ActionRuntime(tmp_path)
    scheduler, harness = configured(tmp_path, monkeypatch, runtime)

    async def drive():
        root = await harness.create(
            PlatformRequest(request_id="action-root", date="2026-11-12")
        )
        await asyncio.gather(*list(scheduler._running.values()))
        root = harness.get(root["id"])
        runtime.action = True
        child = await harness.create(
            PlatformRequest(
                request_id="save-action",
                kind="query",
                question="帮我保存到我的记录里面去",
                date="2026-11-12",
                parent_run_id=root["id"],
            )
        )
        await asyncio.gather(*list(scheduler._running.values()))
        child = harness.get(child["id"])
        assert (
            child["status"] == "ready"
            and child["answer_markdown"] == "尚未连接记录服务，未保存。"
        )
        assert child["sources"] == [] and child["coverage"]["read"] == 0

    asyncio.run(drive())


def test_cancel_during_submit_is_not_overwritten_by_creator(tmp_path, monkeypatch):
    import hashlib

    runtime = ResultRuntime(tmp_path)
    scheduler, harness = configured(tmp_path, monkeypatch, runtime)

    async def drive():
        entered = asyncio.Event()
        release = asyncio.Event()
        original = scheduler.submit

        async def delayed(*args, **kwargs):
            entered.set()
            await release.wait()
            return await original(*args, **kwargs)

        monkeypatch.setattr(scheduler, "submit", delayed)
        pending = asyncio.create_task(
            harness.create(
                PlatformRequest(
                    request_id="cancel-submit",
                    kind="query",
                    question="Search",
                    date="2026-11-12",
                )
            )
        )
        await entered.wait()
        identifier = hashlib.sha256(b"cancel-submit").hexdigest()[:32]
        assert (await harness.cancel(identifier))["status"] == "cancelled"
        release.set()
        result = await pending
        assert result["status"] == "cancelled"
        assert not result["task_id"] and not scheduler._running

    asyncio.run(drive())
