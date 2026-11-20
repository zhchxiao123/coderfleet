"""Non-blocking, revision-checked conversation naming with bounded recovery."""
from __future__ import annotations

import asyncio
from datetime import timedelta
import hashlib
import json
import logging
import re
from typing import Awaitable, Callable, TYPE_CHECKING

from coderfleet.account_type_registry import ACCOUNT_TYPES, FinalText, TextChunk
from coderfleet.server.models import Conversation, ConversationStatus, ConversationTitle, Task, TaskStatus, now_iso, parse_iso, utc_now
from coderfleet.server.summarize_title import summarize_title, validate_title
from coderfleet.server.system_llm import SystemLLM, SystemLLMError

if TYPE_CHECKING:
    from coderfleet.server.scheduler import Scheduler

Generator = Callable[[SystemLLM, str], Awaitable[str]]
logger = logging.getLogger(__name__)


class TitleConflict(ValueError):
    pass


def _bounded(text: str, size: int = 1800) -> str:
    return text if len(text) <= size else text[:size // 2] + "\n…\n" + text[-size // 2:]


def _meaningful(text: str) -> bool:
    compact = re.sub(r"[\W_]+", "", text).casefold()
    if compact in {"", "hi", "hello", "你好", "好的", "可以", "ok", "okay", "继续", "继续吧", "开始", "开始吧", "下一步", "请查看附件图片", "请查看图片", "测试"}:
        return False
    return len(re.findall(r"[\u3400-\u9fff]", compact)) >= 2 or len(compact) >= 4


class ConversationTitles:
    def __init__(self, scheduler: Scheduler, *, generate: Generator = summarize_title,
                 llm: SystemLLM | None = None) -> None:
        self.scheduler = scheduler
        self.generate = generate
        self.llm = llm
        self.pending: set[str] = set()
        self.jobs: dict[str, asyncio.Task] = {}
        self._recovered = False
        self._closed = False
        self._slots = asyncio.Semaphore(2)

    def _change(self, identifier: str, change: Callable[[Conversation], None]) -> Conversation:
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", identifier):
            raise ValueError("无效会话标识")
        return Conversation.mutate(self.scheduler.conversations_dir, identifier, change)

    def enable(self, identifier: str) -> None:
        def change(conv: Conversation) -> None:
            conv.title = ConversationTitle(source="fallback", status="waiting_context",
                                           revision=conv.title.revision + 1)
        self._change(identifier, change)

    def observe(self, task: Task) -> None:
        if not task.conversation_id or task.platform_run_id:
            return

        def change(conv: Conversation) -> None:
            state = conv.title
            if state.source != "fallback" or conv.status != ConversationStatus.active:
                return
            latest = self._task(state.latest_task_id)
            if latest and (latest.created, latest.id) > (task.created, task.id):
                return
            key = f"{task.id}:{task.status.value}:{task.finished or ''}"
            if key == state.context_key:
                return
            state.first_task_id = state.first_task_id or task.id
            if _meaningful(task.prompt) and (state.latest_task_id != task.id or not state.topic_task_id):
                state.first_goal_task_id = state.first_goal_task_id or task.id
                state.topic_task_id = task.id
                state.latest_message = ""
            state.latest_task_id = task.id
            state.context_key = key
            state.status = "pending"
            state.revision += 1
            state.attempts = 0
            state.retry_at = state.error = ""
            self.pending.add(conv.id)

        try:
            self._change(task.conversation_id, change)
        except ValueError:
            return  # A Task may finish after its owning Conversation was deleted.

    def observe_message(self, task: Task, text: str, request_id: str) -> None:
        if not task.conversation_id or not _meaningful(text):
            return
        def change(conv: Conversation) -> None:
            if conv.title.source != "fallback" or conv.status != ConversationStatus.active:
                return
            key = "message:" + task.id + ":" + hashlib.sha256(request_id.encode()).hexdigest()
            if conv.title.context_key == key:
                return
            conv.title.first_task_id = conv.title.first_task_id or task.id
            conv.title.first_goal_task_id = conv.title.first_goal_task_id or task.id
            conv.title.topic_task_id = task.id
            conv.title.latest_task_id = task.id
            conv.title.latest_message = _bounded(text)
            conv.title.context_key = key
            conv.title.revision += 1
            conv.title.status = "pending"
            conv.title.attempts = 0
            conv.title.error = conv.title.retry_at = ""
            self.pending.add(conv.id)
        try:
            self._change(task.conversation_id, change)
        except ValueError:
            return

    def request(self, identifier: str, *, expected_revision: int | None = None,
                expected_name: str | None = None) -> Conversation:
        tasks = sorted((t for t in Task.load_all(self.scheduler.tasks_dir)
                        if t.conversation_id == identifier and not t.platform_run_id),
                       key=lambda task: (task.created, task.id))

        goals = [task for task in tasks if _meaningful(task.prompt)]
        def change(conv: Conversation) -> None:
            if expected_revision is not None and conv.title.revision != expected_revision:
                raise TitleConflict("会话标题已改变，请刷新后重试")
            if expected_name is not None and conv.name != expected_name:
                raise TitleConflict("会话名称已改变，请刷新后重试")
            if conv.mode.value != "chat" or conv.status != ConversationStatus.active:
                raise ValueError("只能为活跃聊天会话生成标题")
            if not tasks:
                raise ValueError("会话还没有可用于命名的消息")
            message_task = next((task for task in tasks if task.id == conv.title.topic_task_id), None)
            keep_message = (message_task is not None and _meaningful(conv.title.latest_message)
                            and (not goals or (message_task.created, message_task.id) >= (goals[-1].created, goals[-1].id)))
            message = conv.title.latest_message if keep_message else ""
            conv.title = ConversationTitle(source="fallback", status="pending",
                                           revision=conv.title.revision + 1,
                                           first_task_id=tasks[0].id, latest_task_id=tasks[-1].id,
                                           first_goal_task_id=goals[0].id if goals else message_task.id if keep_message else "",
                                           topic_task_id=message_task.id if keep_message else goals[-1].id if goals else "",
                                           latest_message=message)
            self.pending.add(conv.id)

        return self._change(identifier, change)

    def set_status(self, identifier: str, status: ConversationStatus) -> Conversation:
        def change(conv: Conversation) -> None:
            conv.status = status
            state = conv.title
            if state.source != "fallback":
                return
            if status == ConversationStatus.archived and state.status in {"pending", "retryable_error"}:
                state.status = "retryable_error"
                state.error = "paused"
                state.revision += 1
            elif status == ConversationStatus.active and state.error == "paused":
                state.status = "pending" if state.attempts < 3 else "retryable_error"
                state.error = "" if state.attempts < 3 else "generation_failed"
                state.revision += 1
                self.pending.add(conv.id)
        return self._change(identifier, change)

    def _task(self, identifier: str) -> Task | None:
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", identifier):
            return None
        return self.scheduler.get_task(identifier)

    def _public_reply(self, task: Task) -> str:
        if task.status not in {TaskStatus.done, TaskStatus.failed, TaskStatus.killed}:
            return ""
        spec = ACCOUNT_TYPES.get(task.type.value)
        if not spec or not spec.parse_output_events:
            return ""
        path = self.scheduler.get_log_path(task.id)
        try:
            with path.open("rb") as stream:
                size = path.stat().st_size
                stream.seek(max(0, size - 65536))
                if size > 65536:
                    stream.readline()  # Discard a torn line, never use raw tool fallback.
                lines = stream.read().decode(errors="replace").splitlines()
        except OSError:
            return ""
        texts = []
        for line in lines:
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if not isinstance(event, dict) or event.get("parent_tool_use_id"):
                continue
            try:
                items = spec.parse_output_events(event)
            except (TypeError, ValueError, KeyError):
                continue
            for item in items:
                if isinstance(item, FinalText):
                    texts = [item.text]
                elif isinstance(item, TextChunk):
                    texts.append(item.text)
        return _bounded("\n".join(texts))

    def _context(self, conv: Conversation) -> str:
        tasks = [self._task(identifier) for identifier in
                 dict.fromkeys((conv.title.first_goal_task_id or conv.title.first_task_id,
                                conv.title.topic_task_id or conv.title.latest_task_id,
                                conv.title.latest_task_id))]
        tasks = [task for task in tasks if task and task.conversation_id == conv.id]
        if not tasks:
            return ""
        reply = self._public_reply(tasks[-1])
        if not _meaningful(conv.title.latest_message) and not any(_meaningful(task.prompt) for task in tasks) and not (any(task.images for task in tasks) and _meaningful(reply)):
            return ""
        topic = self._task(conv.title.topic_task_id) or tasks[-1]
        original = tasks[0].prompt if _meaningful(tasks[0].prompt) else conv.title.latest_message or tasks[0].prompt
        data = json.dumps({"project": conv.project_name,
                           "original_goal": _bounded(original),
                           "latest_user": conv.title.latest_message or _bounded(topic.prompt),
                           "public_reply": reply}, ensure_ascii=False)
        from coderfleet.server.platform_retrieval import _secrets
        from coderfleet.server.platform_activity import _redact
        return _redact(data, _secrets(self.scheduler.workspace_dir))

    def tick(self) -> None:
        if self._closed:
            return
        if not self._recovered:
            self._recovered = True
            self.pending.update(conv.id for conv in self.scheduler.list_conversations()
                                if conv.title.source == "fallback" and
                                conv.title.status in {"pending", "retryable_error"})
        for identifier in tuple(self.pending):
            if identifier in self.jobs:
                continue
            conv = self.scheduler.get_conversation(identifier)
            if not conv or conv.status != ConversationStatus.active or conv.title.source != "fallback":
                self.pending.discard(identifier)
                continue
            if conv.title.attempts >= 3:
                if conv.title.status == "pending":
                    def exhausted(current: Conversation) -> None:
                        if current.title.status == "pending" and current.title.attempts >= 3:
                            current.title.status = "retryable_error"
                            current.title.error = "generation_failed"
                            current.title.retry_at = ""
                            current.title.revision += 1
                    self._change(identifier, exhausted)
                self.pending.discard(identifier)
                continue
            if conv.title.status not in {"pending", "retryable_error"}:
                self.pending.discard(identifier)
                continue
            if conv.title.retry_at and parse_iso(conv.title.retry_at) > utc_now():
                continue
            self.jobs[identifier] = asyncio.create_task(self._run(identifier), name="title-" + identifier)

    async def _run(self, identifier: str) -> None:
        revision: int | None = None
        name = ""
        claimed = False
        try:
            async with self._slots:
                conv = self.scheduler.get_conversation(identifier)
                if not conv or conv.title.source != "fallback" or conv.status != ConversationStatus.active:
                    return
                revision, name = conv.title.revision, conv.name
                context = await asyncio.to_thread(self._context, conv)
                llm = self.llm or SystemLLM.from_config(self.scheduler.workspace_dir)

                def update(change: Callable[[Conversation], None]) -> None:
                    def checked(current: Conversation) -> None:
                        if (current.title.revision == revision and current.name == name
                                and current.title.source == "fallback" and current.status == ConversationStatus.active):
                            change(current)
                            current.title.revision += 1
                    self._change(identifier, checked)

                if not context:
                    update(lambda current: setattr(current.title, "status", "waiting_context"))
                    return
                if not llm.is_configured():
                    def missing(current: Conversation) -> None:
                        current.title.status = "retryable_error"
                        current.title.error = "not_configured"
                        current.title.retry_at = (utc_now() + timedelta(seconds=30)).isoformat()
                    update(missing)
                    return
                # Reserve the revision before awaiting the model; all later writes
                # re-read under the same lock used by manual rename/delete/save.
                claimed = False
                def claim(current: Conversation) -> None:
                    nonlocal claimed
                    current.title.attempts += 1
                    current.title.status = "pending"
                    claimed = True
                update(claim)
                if not claimed:
                    return
                revision += 1
                try:
                    candidate = await self.generate(llm, context)
                    candidate = validate_title(candidate) if candidate else ""
                except SystemLLMError:
                    def failed(current: Conversation) -> None:
                        current.title.status = "retryable_error"
                        current.title.error = "generation_failed"
                        current.title.retry_at = (utc_now() + timedelta(seconds=5 * current.title.attempts)).isoformat()
                    update(failed)
                    return

                def finish(current: Conversation) -> None:
                    current.title.error = current.title.retry_at = ""
                    current.title.status = "ready" if candidate else "waiting_context"
                    if candidate:
                        current.name = candidate
                        current.title.source = "auto"
                update(finish)
        except Exception as error:
            # The infrastructure feature must not leave an unhandled Task or
            # silently spin forever on a malformed source/configuration.
            logger.warning("Title generation unavailable [conversation=%s kind=%s]", identifier, type(error).__name__)
            def failed_context(current: Conversation) -> None:
                if (revision is not None and current.title.revision == revision and current.name == name
                        and current.title.source == "fallback" and current.status == ConversationStatus.active):
                    current.title.attempts += 0 if claimed else 1
                    current.title.status = "retryable_error"
                    current.title.error = "generation_failed"
                    current.title.retry_at = (utc_now() + timedelta(seconds=15)).isoformat()
                    current.title.revision += 1
            try:
                self._change(identifier, failed_context)
            except ValueError:
                pass  # Deleted record: never recreate it.
        finally:
            self.jobs.pop(identifier, None)

    async def wait_idle(self) -> None:
        if self.jobs:
            await asyncio.gather(*tuple(self.jobs.values()))

    async def close(self) -> None:
        self._closed = True
        jobs = tuple(self.jobs.values())
        for job in jobs:
            job.cancel()
        if jobs:
            await asyncio.gather(*jobs, return_exceptions=True)
