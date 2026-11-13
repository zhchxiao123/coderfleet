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
            "What remains?" in prompt
            and "Report" in prompt
            and "Which one first?" in prompt
        )
        assert (
            "NEW_SOURCE_AFTER_ROOT"
            not in (
                tmp_path / "platform/runs" / second["id"] / "snapshot.json"
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
        with pytest.raises(ValueError, match="上下文"):
            await harness.create(
                PlatformRequest(
                    request_id="too-long",
                    kind="query",
                    question="Continue?",
                    date="2026-11-12",
                    parent_run_id=record["id"],
                )
            )

    asyncio.run(drive())
    assert len(runtime.runs) == 1


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
