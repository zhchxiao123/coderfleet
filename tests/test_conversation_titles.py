from __future__ import annotations

import asyncio
import json
from datetime import timedelta

import httpx
import pytest

from coderfleet.server.models import AccountType, Conversation, Task, TaskStatus
from coderfleet.server.scheduler import Scheduler

from coderfleet.server.summarize_title import summarize_title
from coderfleet.server.system_llm import SystemLLM


def test_title_recovers_from_reasoning_using_the_output_budget():
    budgets = []

    def respond(request: httpx.Request) -> httpx.Response:
        budget = json.loads(request.content)["max_tokens"]
        budgets.append(budget)
        limited = budget < 1024
        return httpx.Response(200, json={"choices": [{
            "finish_reason": "length" if limited else "stop",
            "message": {"content": "" if limited else "修复历史消息滚动跳动"},
        }]})

    llm = SystemLLM(provider="openai", api_key="test", model="reasoning",
                    transport=httpx.MockTransport(respond))
    assert asyncio.run(summarize_title(llm, "修复历史消息滚动加载时的位置跳动")) == "修复历史消息滚动跳动"
    assert budgets == [256, 1024]


def test_server_generation_cannot_overwrite_a_manual_name_or_native_session(tmp_path):
    from coderfleet.server.conversation_titles import ConversationTitles

    scheduler = Scheduler(tmp_path)
    Conversation(id="conv", name="临时名称", account="a", type=AccountType.claude,
                 project="/repo").save(scheduler.conversations_dir)
    task = Task(id="one", account="a", type=AccountType.claude, project="/repo",
                conversation_id="conv", prompt="修复历史消息滚动时的位置跳动", status=TaskStatus.done)
    task.save(scheduler.tasks_dir)

    async def drive():
        started, release = asyncio.Event(), asyncio.Event()

        async def generate(_llm, _text):
            started.set()
            await release.wait()
            return "迟到的自动标题"

        titles = ConversationTitles(scheduler, generate=generate,
                                    llm=SystemLLM(api_key="test", model="test"))
        titles.enable("conv")
        titles.observe(task)
        titles.tick()
        await started.wait()
        scheduler.rename_conversation("conv", "用户手动命名")
        scheduler.update_conversation_native_session("conv", "native-session", task.id)
        release.set()
        await titles.wait_idle()
        current = scheduler.get_conversation("conv")
        assert current.name == "用户手动命名"
        assert current.title.source == "manual"
        assert current.native_session_id == "native-session"
        assert current.last_task_id == "one"

    asyncio.run(drive())


def make_conversation(scheduler, identifier="conv"):
    conv = Conversation(id=identifier, name="首句截断…", account="a", type=AccountType.claude, project="/repo")
    conv.save(scheduler.conversations_dir)
    return conv


def make_task(scheduler, identifier="one", prompt="修复历史消息滚动时的位置跳动", **extra):
    task = Task(id=identifier, account="a", type=AccountType.claude, project="/repo",
                conversation_id="conv", prompt=prompt, status=TaskStatus.done, **extra)
    task.save(scheduler.tasks_dir)
    return task


def test_greeting_waits_for_a_real_goal_then_keeps_the_title_stable(tmp_path):
    from coderfleet.server.conversation_titles import ConversationTitles

    async def drive():
        scheduler = Scheduler(tmp_path)
        make_conversation(scheduler)
        seen = []
        async def generate(_llm, text):
            seen.append(text)
            return "历史消息加载与滚动修复"
        titles = ConversationTitles(scheduler, generate=generate, llm=SystemLLM(api_key="x", model="x"))
        titles.enable("conv")
        titles.observe(make_task(scheduler, prompt="hi"))
        titles.tick()
        await titles.wait_idle()
        assert scheduler.get_conversation("conv").title.status == "waiting_context"
        assert not seen
        titles.observe(make_task(scheduler, "two", created="2099-01-01T00:00:00Z"))
        titles.tick()
        await titles.wait_idle()
        assert scheduler.get_conversation("conv").name == "历史消息加载与滚动修复"
        assert "修复历史消息滚动时的位置跳动" in seen[0]
        titles.observe(make_task(scheduler, "three", prompt="继续", created="2099-01-02T00:00:00Z"))
        titles.tick()
        await titles.wait_idle()
        assert len(seen) == 1
    asyncio.run(drive())


def test_failed_generation_recovers_after_restart_but_legacy_names_do_not_auto_change(tmp_path, monkeypatch):
    from coderfleet.server import conversation_titles as module
    from coderfleet.server.system_llm import SystemLLMError

    async def drive():
        scheduler = Scheduler(tmp_path)
        make_conversation(scheduler)
        legacy = make_conversation(scheduler, "legacy")
        async def broken(_llm, _text):
            raise SystemLLMError("secret provider response must not be persisted")
        llm = SystemLLM(api_key="x", model="x")
        first = module.ConversationTitles(scheduler, generate=broken, llm=llm)
        first.enable("conv")
        first.observe(make_task(scheduler))
        first.tick()
        await first.wait_idle()
        assert scheduler.get_conversation("conv").title.status == "retryable_error"
        assert scheduler.get_conversation("conv").title.error == "generation_failed"
        later = module.utc_now() + timedelta(minutes=5)
        monkeypatch.setattr(module, "utc_now", lambda: later)
        async def recovered(_llm, _text):
            return "恢复后的主题标题"
        second = module.ConversationTitles(scheduler, generate=recovered, llm=llm)
        second.tick()
        await second.wait_idle()
        assert scheduler.get_conversation("conv").name == "恢复后的主题标题"
        assert scheduler.get_conversation("legacy").model_dump() == legacy.model_dump()
    asyncio.run(drive())


@pytest.mark.parametrize("action", ["delete", "archive"])
def test_delayed_generation_does_not_recreate_or_unarchive_a_conversation(tmp_path, action):
    from coderfleet.server.conversation_titles import ConversationTitles
    from coderfleet.server.models import ConversationStatus

    async def drive():
        scheduler = Scheduler(tmp_path)
        stale = make_conversation(scheduler)
        ready, release = asyncio.Event(), asyncio.Event()
        async def generate(_llm, _text):
            ready.set()
            await release.wait()
            return "自动主题标题"
        titles = ConversationTitles(scheduler, generate=generate, llm=SystemLLM(api_key="x", model="x"))
        titles.enable("conv")
        titles.observe(make_task(scheduler))
        titles.tick()
        await ready.wait()
        if action == "delete":
            scheduler.delete_conversation("conv")
        else:
            scheduler.archive_conversation("conv", ConversationStatus.archived)
        stale.touch(scheduler.conversations_dir, last_task_id="one")
        release.set()
        await titles.wait_idle()
        current = scheduler.get_conversation("conv")
        assert current is None if action == "delete" else current.status == ConversationStatus.archived and current.name == "首句截断…"
    asyncio.run(drive())


def test_native_supplement_can_supply_a_missing_topic_without_creating_a_task(tmp_path):
    from coderfleet.server.system_llm import SystemLLM
    async def drive():
        scheduler = Scheduler(tmp_path)
        make_conversation(scheduler)
        task = make_task(scheduler, prompt="hi")
        task.status = TaskStatus.running
        task.save(scheduler.tasks_dir)
        seen = []
        async def generate(_llm, text):
            seen.append(text)
            return "OAuth 登录回调排查"
        scheduler.titles.generate = generate
        scheduler.titles.llm = SystemLLM(api_key="test", model="test")
        scheduler.titles.enable("conv")
        scheduler.titles.observe(task)
        scheduler.titles.tick()
        await scheduler.titles.wait_idle()
        assert not seen
        scheduler._record_sdk_progress(task, json.dumps({"type":"system", "subtype":"coderfleet_message_accepted",
            "task_id":task.id,"request_id":"accepted-one","text":"排查 OAuth 登录回调后重复跳转登录页的问题"}))
        scheduler.titles.tick()
        await scheduler.titles.wait_idle()
        assert scheduler.get_conversation("conv").name == "OAuth 登录回调排查"
        assert "排查 OAuth 登录回调" in seen[0]
        assert len(scheduler.list_tasks()) == 1
    asyncio.run(drive())


@pytest.mark.parametrize("explicit", [False, True])
def test_a_real_goal_between_greeting_and_continue_is_not_lost(tmp_path, explicit):
    async def drive():
        scheduler = Scheduler(tmp_path)
        make_conversation(scheduler)
        seen = []
        async def generate(_llm, text):
            seen.append(json.loads(text))
            return "OAuth 登录回调排查"
        scheduler.titles.llm = SystemLLM(api_key="test", model="test")
        scheduler.titles.generate = generate
        if not explicit:
            scheduler.titles.enable("conv")
        for index, text in enumerate(("hi", "排查 OAuth 登录回调问题", "继续"), 1):
            task = make_task(scheduler, f"task-{index}", prompt=text, created=f"2026-11-{index:02d}T00:00:00Z")
            if not explicit:
                scheduler.titles.observe(task)
        if explicit:
            scheduler.titles.request("conv")
        scheduler.titles.tick()
        await scheduler.titles.wait_idle()
        assert scheduler.get_conversation("conv").name == "OAuth 登录回调排查"
        assert seen[0]["original_goal"] == "排查 OAuth 登录回调问题"
        assert seen[0]["latest_user"] == "排查 OAuth 登录回调问题"
    asyncio.run(drive())


def test_a_short_chinese_goal_is_sufficient_context(tmp_path):
    async def drive():
        scheduler = Scheduler(tmp_path)
        make_conversation(scheduler)
        async def generate(_llm, text):
            assert "修复登录" in text
            return "登录功能故障修复"
        scheduler.titles.llm = SystemLLM(api_key="test", model="test")
        scheduler.titles.generate = generate
        scheduler.titles.enable("conv")
        scheduler.titles.observe(make_task(scheduler, prompt="修复登录"))
        scheduler.titles.tick()
        await scheduler.titles.wait_idle()
        assert scheduler.get_conversation("conv").name == "登录功能故障修复"
    asyncio.run(drive())


def test_restart_during_the_last_attempt_becomes_retryable_not_forever_pending(tmp_path):
    async def drive():
        scheduler = Scheduler(tmp_path)
        make_conversation(scheduler)
        scheduler.titles.enable("conv")
        scheduler.titles.observe(make_task(scheduler))
        Conversation.mutate(scheduler.conversations_dir, "conv", lambda conv: setattr(conv.title, "attempts", 2))
        started = asyncio.Event()
        async def interrupted(_llm, _text):
            started.set()
            await asyncio.Event().wait()
            return "unreachable"
        scheduler.titles.llm = SystemLLM(api_key="test", model="test")
        scheduler.titles.generate = interrupted
        scheduler.titles.tick()
        await started.wait()
        await scheduler.titles.close()
        restarted = Scheduler(tmp_path)
        restarted.titles.tick()
        await restarted.titles.wait_idle()
        conv = restarted.get_conversation("conv")
        assert conv.title.attempts == 3
        assert conv.title.status == "retryable_error"
        assert conv.name == "首句截断…"
        # Explicit retry remains available after the automatic budget is exhausted.
        result = restarted.titles.request("conv", expected_revision=conv.title.revision)
        assert result.title.attempts == 0 and result.title.status == "pending"
    asyncio.run(drive())


def test_archive_then_restore_resumes_only_the_current_title_revision(tmp_path):
    from coderfleet.server.models import ConversationStatus
    async def drive():
        scheduler = Scheduler(tmp_path)
        make_conversation(scheduler)
        scheduler.titles.enable("conv")
        scheduler.titles.observe(make_task(scheduler))
        started, release = asyncio.Event(), asyncio.Event()
        calls = []
        async def generate(_llm, _text):
            calls.append(True)
            if len(calls) == 1:
                started.set()
                await release.wait()
                return "归档期间的过期结果"
            return "恢复后的主题标题"
        scheduler.titles.generate = generate
        scheduler.titles.llm = SystemLLM(api_key="test", model="test")
        scheduler.titles.tick()
        await started.wait()
        scheduler.archive_conversation("conv", ConversationStatus.archived)
        scheduler.titles.tick()
        release.set()
        await scheduler.titles.wait_idle()
        assert scheduler.get_conversation("conv").name == "首句截断…"
        scheduler.archive_conversation("conv", ConversationStatus.active)
        scheduler.titles.tick()
        await scheduler.titles.wait_idle()
        assert scheduler.get_conversation("conv").name == "恢复后的主题标题"
        assert len(calls) == 2
    asyncio.run(drive())


def test_explicit_regeneration_keeps_the_accepted_native_message_topic(tmp_path):
    async def drive():
        scheduler = Scheduler(tmp_path)
        make_conversation(scheduler)
        task = make_task(scheduler, prompt="hi")
        seen = []
        async def generate(_llm, text):
            seen.append(json.loads(text))
            return "OAuth 登录回调排查"
        scheduler.titles.generate = generate
        scheduler.titles.llm = SystemLLM(api_key="test", model="test")
        scheduler.titles.enable("conv")
        scheduler.titles.observe(task)
        scheduler.titles.observe_message(task, "排查 OAuth 登录回调后重复登录的问题", "native-one")
        scheduler.titles.tick()
        await scheduler.titles.wait_idle()
        scheduler.titles.request("conv")
        scheduler.titles.tick()
        await scheduler.titles.wait_idle()
        assert len(seen) == 2
        assert seen[1]["latest_user"] == "排查 OAuth 登录回调后重复登录的问题"
        assert scheduler.get_conversation("conv").title.status == "ready"
    asyncio.run(drive())


def test_archive_restore_keeps_a_failed_attempts_remaining_retry(tmp_path, monkeypatch):
    from coderfleet.server import conversation_titles as module
    from coderfleet.server.models import ConversationStatus
    from coderfleet.server.system_llm import SystemLLMError
    async def drive():
        scheduler = Scheduler(tmp_path)
        make_conversation(scheduler)
        scheduler.titles.enable("conv")
        scheduler.titles.observe(make_task(scheduler))
        calls = []
        async def generate(_llm, _text):
            calls.append(True)
            if len(calls) == 1:
                raise SystemLLMError("temporary")
            return "重试恢复后的主题"
        scheduler.titles.generate = generate
        scheduler.titles.llm = SystemLLM(api_key="test", model="test")
        scheduler.titles.tick()
        await scheduler.titles.wait_idle()
        scheduler.archive_conversation("conv", ConversationStatus.archived)
        scheduler.titles.tick()
        scheduler.archive_conversation("conv", ConversationStatus.active)
        scheduler.titles.tick()
        await scheduler.titles.wait_idle()
        assert len(calls) == 1  # Preserve the backoff through archive/restore.
        later = module.utc_now() + timedelta(minutes=5)
        monkeypatch.setattr(module, "utc_now", lambda: later)
        scheduler.titles.tick()
        await scheduler.titles.wait_idle()
        assert len(calls) == 2
        assert scheduler.get_conversation("conv").name == "重试恢复后的主题"
    asyncio.run(drive())
