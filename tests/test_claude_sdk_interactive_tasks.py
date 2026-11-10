"""Task/API contracts for durable native interaction, including host restart."""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi import HTTPException

from coderfleet.data.scripts.coderfleet_sdk_control import ControlMailbox
from coderfleet.server import main
from coderfleet.server.models import AccountType, PendingIntervention, Task, TaskResponse, TaskStatus
from coderfleet.server.runtime import FakeRuntime
from coderfleet.server.scheduler import Scheduler


def running_task(root: Path) -> tuple[Scheduler, ControlMailbox]:
    scheduler = Scheduler(root, runtime=FakeRuntime())
    task = Task(id='interactive', status=TaskStatus.running, account='one', type=AccountType.claude,
                prompt='initial', project=str(root), ephemeral=True, execution_backend='sdk',
                sdk_control_token='a' * 64, sdk_control_ready=True,
                pending_intervention=PendingIntervention(kind='native', tool_call_id='native-question',
                    questions=[{'question':'Which?'}], token='question-token', deadline='2099-01-01T00:00:00Z'))
    task.save(scheduler.tasks_dir)
    mailbox = ControlMailbox(root / '.coderfleet-tasks/interactive.control', task.id, task.sdk_control_token)
    mailbox.publish('accepting')
    return scheduler, mailbox


def test_native_answer_survives_host_restart_without_an_in_memory_waiter(tmp_path, monkeypatch):
    _old, mailbox = running_task(tmp_path)
    scheduler = Scheduler(tmp_path, runtime=FakeRuntime())
    monkeypatch.setattr(main, 'scheduler', scheduler)

    async def run():
        with pytest.raises(HTTPException) as rejected:
            await main.answer_task_intervention('interactive', main.TaskAnswerRequest(
                tool_call_id='native-question', token='wrong', answers={'Which?':'Mac'}))
        assert rejected.value.status_code == 409
        assert not mailbox.pending()
        answer = asyncio.create_task(main.answer_task_intervention('interactive', main.TaskAnswerRequest(
            tool_call_id='native-question', token='question-token', answers={'Which?':'Mac'})))
        for _ in range(100):
            commands = mailbox.pending()
            if commands:
                assert commands[0]['payload'] == {'tool_call_id':'native-question', 'answers':{'Which?':'Mac'}}
                mailbox.acknowledge(commands[0]['id'], {'answered':True})
                break
            await asyncio.sleep(.01)
        assert await answer == {'ok':True}
    asyncio.run(run())
    public = TaskResponse.from_task(scheduler.get_task('interactive')).model_dump()
    assert public['pending_intervention'] is None
    assert 'sdk_control_token' not in public


def test_message_receipt_retry_after_task_finishes_does_not_replay(tmp_path, monkeypatch):
    scheduler, mailbox = running_task(tmp_path)
    monkeypatch.setattr(main, 'scheduler', scheduler)
    mailbox.submit('one', 'message', {'text':'continue'})
    mailbox.acknowledge('one', {'queued_in_sdk':True})
    mailbox.close()
    task = scheduler.get_task('interactive')
    task.update_status(TaskStatus.done, scheduler.tasks_dir)
    reply = asyncio.run(main.message_sdk_task('interactive', main.SDKMessageRequest(request_id='one', text='continue')))
    assert reply['status'] == 'accepted'
    assert len(list(mailbox.requests.glob('*.json'))) == 1
    with pytest.raises(HTTPException) as rejected:
        asyncio.run(main.message_sdk_task('interactive', main.SDKMessageRequest(request_id='one', text='changed')))
    assert rejected.value.status_code == 409
    assert asyncio.run(main.sdk_task_command_status('interactive','one')) == reply
    with pytest.raises(HTTPException) as late:
        asyncio.run(main.interrupt_sdk_task('interactive', main.SDKCommandRequest(request_id='late')))
    assert late.value.status_code == 409


def test_missing_receipt_after_task_exit_stays_unknown_on_same_id_retry(tmp_path, monkeypatch):
    scheduler, mailbox = running_task(tmp_path)
    monkeypatch.setattr(main, 'scheduler', scheduler)
    mailbox.submit('uncertain', 'message', {'text':'may have been consumed'})
    mailbox.claim('uncertain')
    mailbox.close()  # A worker crash/close after starting must not invent a rejection.
    assert mailbox.reply('uncertain') is None
    task = scheduler.get_task('interactive')
    task.update_status(TaskStatus.failed, scheduler.tasks_dir)
    with pytest.raises(HTTPException) as unknown:
        asyncio.run(main.message_sdk_task('interactive', main.SDKMessageRequest(
            request_id='uncertain', text='may have been consumed')))
    assert unknown.value.status_code == 504
    assert len(list(mailbox.requests.glob('*.json'))) == 1
