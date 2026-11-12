"""Task/API contracts for durable native interaction, including host restart."""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi import HTTPException

from coderfleet.data.scripts.coderfleet_sdk_control import ControlMailbox
from coderfleet.server import main
from coderfleet.server.models import AccountType, PendingIntervention, Task, TaskResponse, TaskStatus
from coderfleet.server.runtime import FakeProcess, FakeRuntime
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


@pytest.mark.parametrize('runtime_kind', ['local', 'container'])
@pytest.mark.parametrize('mode', ['split', 'replay'])
def test_native_control_events_are_parsed_once_across_stdout_chunks(tmp_path, runtime_kind, mode):
    repo = tmp_path / 'repo'
    repo.mkdir()
    (tmp_path / 'accounts.conf').write_text(
        f'NAME=one TYPE=claude RUNTIME={runtime_kind} PROXY=off CLAUDE_BACKEND=sdk\n')
    (tmp_path / 'projects.conf').write_text(f'NAME=repo ACCOUNT=one PATH={repo}\n')
    observed = []

    class WorkerRuntime(FakeRuntime):
        async def exec(self, *args, **kwargs):
            return FakeProcess(stdout_chunks=[b'{"alive":false}'])

        async def run(self, spec):
            import json
            request = json.loads(next(tmp_path.rglob('*.sdk.json')).read_text())
            task_id = request['task_id']

            def event(subtype, **fields):
                return (json.dumps({'type':'system', 'subtype':subtype, 'task_id':task_id, **fields}) + '\n').encode()

            init = event('init', session_id='11111111-1111-4111-8111-111111111111')
            ready = event('coderfleet_control_ready')
            question = event('coderfleet_question_pending', tool_call_id='q-one',
                questions=[{'question':'Which?'}], deadline='2099-01-01T00:00:00Z')
            closed = event('coderfleet_question_closed', tool_call_id='q-one', status='answered')
            chunks = ([init, ready[:15], ready[15:], question, b'\n'] if mode == 'split'
                      else [ready + question, init, closed, b'\n'])

            class Reader:
                async def read(self, size):
                    current = scheduler.get_task(task_id)
                    observed.append((current.sdk_control_ready, current.pending_intervention))
                    await asyncio.sleep(0)
                    return chunks.pop(0) if chunks else b''

            process = FakeProcess()
            process.stdout = Reader()
            return process

    runtime = WorkerRuntime()
    scheduler = Scheduler(tmp_path, runtime=runtime, local_runtime=runtime)

    async def drive():
        task = await scheduler.submit('fixture', project_name='repo', conversation_name='Review', ephemeral=True)
        await asyncio.wait_for(scheduler._running[task.id], timeout=2)
        return task.id

    task_id = asyncio.run(drive())
    assert scheduler.get_task(task_id).status == TaskStatus.done, (scheduler.tasks_dir / f'{task_id}.log').read_text()
    if mode == 'split':
        assert observed[3][0], 'Complete control-ready event must survive arbitrary stdout boundaries'
        assert observed[4][1].tool_call_id == 'q-one'
    else:
        assert observed[1][1].tool_call_id == 'q-one'
        assert observed[3][1] is None
        assert observed[-1][1] is None, 'Closed questions must never replay from an old session scan'


def test_native_answer_retry_recovers_accepted_receipt_after_question_and_task_close(tmp_path, monkeypatch):
    scheduler, mailbox = running_task(tmp_path)
    monkeypatch.setattr(main, 'scheduler', scheduler)
    body = main.TaskAnswerRequest(tool_call_id='native-question', token='question-token', answers={'Which?':'Mac'})
    mailbox.submit('answer-question-token', 'answer', {'tool_call_id':'native-question', 'answers':body.answers})
    mailbox.claim('answer-question-token')
    mailbox.acknowledge('answer-question-token', {'answered':True})
    task = scheduler.get_task('interactive')
    task.pending_intervention = None
    task.update_status(TaskStatus.done, scheduler.tasks_dir)
    assert asyncio.run(main.answer_task_intervention('interactive', body)) == {'ok':True}
    with pytest.raises(HTTPException) as changed:
        asyncio.run(main.answer_task_intervention('interactive', main.TaskAnswerRequest(
            tool_call_id='native-question', token='question-token', answers={'Which?':'Linux'})))
    assert changed.value.status_code == 409
    assert len(list(mailbox.requests.glob('*.json'))) == 1


def test_definitively_rejected_native_answer_can_be_corrected_without_replaying_unknown_input(tmp_path, monkeypatch):
    scheduler, mailbox = running_task(tmp_path)
    monkeypatch.setattr(main, 'scheduler', scheduler)
    mailbox.submit('answer-question-token', 'answer', {'tool_call_id':'native-question', 'answers':{'Which?':'old'}})
    mailbox.acknowledge('answer-question-token', error='Control command expired before delivery')

    async def drive():
        reply = asyncio.create_task(main.answer_task_intervention('interactive', main.TaskAnswerRequest(
            tool_call_id='native-question', token='question-token', answers={'Which?':'Mac'})))
        for _ in range(100):
            commands = mailbox.pending()
            if commands:
                assert len(commands) == 1
                assert commands[0]['id'] == 'answer-question-token-2'
                mailbox.acknowledge(commands[0]['id'], {'answered':True})
                break
            await asyncio.sleep(.001)
        return await reply

    assert asyncio.run(drive()) == {'ok':True}
    assert mailbox.reply('answer-question-token')['status'] == 'rejected'
    assert len(list(mailbox.requests.glob('*.json'))) == 2


def test_invalid_native_answer_is_rejected_before_it_reserves_a_delivery_identity():
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        main.TaskAnswerRequest(tool_call_id='native-question', token='question-token', answers={'Which?':123})


def test_operator_can_approve_pending_tool_through_task_api_and_retry_after_close(tmp_path, monkeypatch):
    scheduler, mailbox = running_task(tmp_path)
    monkeypatch.setattr(main, 'scheduler', scheduler)
    task = scheduler.get_task('interactive')
    task.auto=True;task.sdk_permission_mode='bypassPermissions';task.save(scheduler.tasks_dir)
    # The SDK can request manual input before the mode-change receipt arrives.
    scheduler._record_sdk_progress(task, '{"type":"system","subtype":"coderfleet_permission_pending","task_id":"interactive","tool_call_id":"bash-one","tool_name":"Bash","tool_input":{"command":"printf approved"},"deadline":"2099-01-01T00:00:00Z"}\n')
    pending=scheduler.get_task(task.id).pending_intervention
    assert pending and pending.kind=='permission'
    assert pending.tool_input=={'command':'printf approved'}

    async def drive():
        body=main.TaskApprovalRequest(tool_call_id='bash-one',token=pending.token,decision='allow')
        request=asyncio.create_task(main.approve_task_intervention(task.id,body))
        for _ in range(100):
            commands=mailbox.pending()
            if commands:
                assert commands[0]['kind']=='approval'
                assert commands[0]['payload']=={'tool_call_id':'bash-one','decision':'allow','message':''}
                mailbox.acknowledge(commands[0]['id'],{'approved':True})
                break
            await asyncio.sleep(.001)
        assert await request=={'ok':True}
        scheduler._record_sdk_progress(task, '{"type":"system","subtype":"coderfleet_permission_closed","task_id":"interactive","tool_call_id":"bash-one","status":"approved"}\n')
        assert await main.approve_task_intervention(task.id,body)=={'ok':True}
        with pytest.raises(HTTPException) as changed:
            await main.approve_task_intervention(task.id,main.TaskApprovalRequest(tool_call_id='bash-one',token=pending.token,decision='deny'))
        assert changed.value.status_code==409
    asyncio.run(drive())
    assert scheduler.get_task(task.id).pending_intervention is None
    assert len(list(mailbox.requests.glob('*.json')))==1


def test_control_updates_are_persisted_and_receipt_retry_does_not_reapply_current_account_gates(tmp_path,monkeypatch):
    scheduler,mailbox=running_task(tmp_path)
    task=scheduler.get_task('interactive');task.sdk_capabilities=['control'];task.save(scheduler.tasks_dir)
    monkeypatch.setattr(main,'scheduler',scheduler)
    mailbox.submit('mode-one','control',{'operation':'set_permission_mode','arguments':{'mode':'bypassPermissions'}})
    mailbox.acknowledge('mode-one',{'operation':'set_permission_mode','value':None})
    # This retry must return the original receipt even if the account was removed.
    result=asyncio.run(main.control_sdk_task('interactive',main.SDKControlRequest(request_id='mode-one',operation='set_permission_mode',arguments={'mode':'bypassPermissions'})))
    assert result['status']=='accepted'
    scheduler._record_sdk_progress(task,'{"type":"system","subtype":"coderfleet_control_applied","task_id":"interactive","operation":"set_model","arguments":{"model":"sonnet"}}\n')
    assert scheduler.get_task(task.id).model=='sonnet'
    with pytest.raises(HTTPException) as rejected:
        asyncio.run(main.control_sdk_task('interactive',main.SDKControlRequest(request_id='mode-new',operation='set_permission_mode',arguments={'mode':'bypassPermissions'})))
    assert rejected.value.status_code==409


def test_checkpoint_capture_and_rewind_rejects_unrelated_uuid_before_delivery(tmp_path):
    scheduler,mailbox=running_task(tmp_path)
    task=scheduler.get_task('interactive');task.sdk_capabilities=['control'];task.save(scheduler.tasks_dir)
    scheduler._record_sdk_progress(task,'{"type":"system","subtype":"coderfleet_checkpoint","task_id":"interactive","user_message_id":"checkpoint-one"}\n')
    assert scheduler.get_task(task.id).sdk_checkpoints==['checkpoint-one']
    with pytest.raises(RuntimeError,match='检查点'):
        asyncio.run(scheduler.sdk_control(task.id,'rewind_files',{'user_message_id':'foreign'},'rewind-foreign'))
    assert not mailbox.pending()
