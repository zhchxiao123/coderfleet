"""Native metadata operations retain account, workspace and delivery identity."""
import asyncio
import json
from pathlib import Path

import pytest

from coderfleet.data.scripts.coderfleet_sdk_control import ControlMailbox
from coderfleet.server.models import AccountType, Task, TaskStatus
from coderfleet.server.runtime import FakeRuntime, FakeProcess
from coderfleet.server.scheduler import Scheduler


def setup(root: Path):
    project=root/'project'; project.mkdir()
    (root/'accounts.conf').write_text('NAME=one TYPE=claude CLAUDE_BACKEND=sdk PROXY=off\n')
    (root/'projects.conf').write_text(f'NAME=project ACCOUNT=one PATH={project}\n')
    scheduler=Scheduler(root,runtime=FakeRuntime())
    source=Task(id='source',status=TaskStatus.done,account='one',type=AccountType.claude,prompt='original',
        project=str(project),project_name='project',execution_backend='sdk',execution_runtime='container',
        native_session_id='11111111-1111-4111-8111-111111111111',sdk_control_token='a'*64,
        sdk_options={'enable_file_checkpointing':True},sdk_checkpoints=['22222222-2222-4222-8222-222222222222'])
    source.save(scheduler.tasks_dir)
    return scheduler,source


def test_metadata_uses_account_runtime_no_network_and_retries_receipt_without_execution(tmp_path):
    scheduler,source=setup(tmp_path)
    calls=[]
    class Runtime(FakeRuntime):
        async def run(self,spec):
            calls.append(spec)
            request=json.loads(next((Path(source.project)/'.coderfleet-tasks').glob('*.session-*.json')).read_text())
            assert request['session_id']==source.native_session_id
            assert request['cwd']=='/workspace'
            assert request['allowed_session_ids']==[source.native_session_id]
            mailbox=ControlMailbox(Path(source.project)/'.coderfleet-tasks/source.sessions',source.id,source.sdk_control_token)
            mailbox.claim(request['request_id'])
            mailbox.acknowledge(request['request_id'],{'value':{'session_id':source.native_session_id}})
            return FakeProcess()
    scheduler.runtime=Runtime()
    result=asyncio.run(scheduler.sdk_session('source','info',{},'read-one'))
    assert result['status']=='accepted'
    assert calls[0].network is None and calls[0].remove
    assert calls[0].env['CLAUDE_CONFIG_DIR']=='/home/byclaw/.claude'
    assert calls[0].mounts[1]==(str(tmp_path/'accounts/one'),'/home/byclaw/.claude')
    assert asyncio.run(scheduler.sdk_session('source','info',{},'read-one'))==result
    assert len(calls)==1
    with pytest.raises(RuntimeError): asyncio.run(scheduler.sdk_session('source','messages',{},'read-one'))


def test_metadata_mutations_require_idle_workspace_and_archived_references(tmp_path):
    scheduler,source=setup(tmp_path)
    active=source.model_copy(update={'id':'active','status':TaskStatus.running})
    active.save(scheduler.tasks_dir)
    with pytest.raises(RuntimeError,match='停止'): asyncio.run(scheduler.sdk_session('source','rename',{'title':'new'},'rename-one'))
    active.update_status(TaskStatus.done,scheduler.tasks_dir)
    with pytest.raises(RuntimeError,match='归档'):
        asyncio.run(scheduler.sdk_session('source','delete',{'confirm_session_id':source.native_session_id},'delete-one'))
    with pytest.raises(ValueError): asyncio.run(scheduler.sdk_session('source','messages',{'directory':'/other-account'},'read-bad'))


def test_recovery_rejects_foreign_checkpoint_and_active_project_then_preserves_action_snapshot(tmp_path,monkeypatch):
    scheduler,source=setup(tmp_path)
    with pytest.raises(RuntimeError,match='不属于'): asyncio.run(scheduler.rewind_sdk_files('source','foreign','rewind-one'))
    active=source.model_copy(update={'id':'active','status':TaskStatus.running})
    active.save(scheduler.tasks_dir)
    with pytest.raises(RuntimeError,match='停止'): asyncio.run(scheduler.rewind_sdk_files('source',source.sdk_checkpoints[0],'rewind-one'))
    active.update_status(TaskStatus.done,scheduler.tasks_dir)
    seen=[]
    async def submit(prompt,**kwargs):
        seen.append(kwargs)
        recovery=source.model_copy(update={'id':'recovery','sdk_action':kwargs['sdk_action']})
        recovery.save(scheduler.tasks_dir)
        return recovery
    monkeypatch.setattr(scheduler,'submit',submit)
    recovery=asyncio.run(scheduler.rewind_sdk_files('source',source.sdk_checkpoints[0],'rewind-one'))
    assert seen[0]['sdk_options']=={'enable_file_checkpointing':True,'permission_mode':'dontAsk'}
    assert seen[0]['sdk_action']['source_session_id']==source.native_session_id
    assert asyncio.run(scheduler.rewind_sdk_files('source',source.sdk_checkpoints[0],'rewind-one')).id==recovery.id
    assert len(seen)==1
    with pytest.raises(ValueError,match='不能自动重放'): asyncio.run(scheduler.clone_task_for_retry(recovery))


@pytest.mark.parametrize("mode",["plan","dontAsk"])
def test_task_options_are_snapshotted_and_cli_backend_does_not_ignore_them(tmp_path,mode):
    scheduler,_=setup(tmp_path)
    options={'max_turns':3,'permission_mode':mode,'thinking':{'type':'adaptive'}}
    async def run():
        task=await scheduler.submit('review',project_name='project',auto=True,sdk_options=options,ephemeral=True,execute_at='2080-01-01T00:00:00Z')
        options['thinking']['type']='disabled'
        assert scheduler.get_task(task.id).sdk_options['thinking']['type']=='adaptive'
        assert not task.auto
    asyncio.run(run())
    (tmp_path/'accounts.conf').write_text('NAME=one TYPE=claude CLAUDE_BACKEND=cli PROXY=off\n')
    with pytest.raises(ValueError,match='SDK account'):
        asyncio.run(scheduler.submit('review',project_name='project',sdk_options={'max_turns':3}))


def test_native_local_fork_keeps_normal_project_and_store_configuration(tmp_path):
    scheduler,source=setup(tmp_path)
    (tmp_path/'accounts.conf').write_text('NAME=one TYPE=claude RUNTIME=local CLAUDE_BACKEND=sdk PROXY=off\n')
    source.execution_runtime='local';source.ephemeral=True
    source.sdk_options={'session_store':{'type':'sqlite'},'agents':{'reviewer':{'description':'review','prompt':'review','model':'claude-opus-5-5'}}}
    source.save(scheduler.tasks_dir)
    result=scheduler._sdk_session_result(source,'fork',{},'fork-one',
        {'status':'accepted','result':{'value':{'session_id':'33333333-3333-4333-8333-333333333333'}}})
    child=scheduler.get_conversation(result['conversation_id'])
    assert not child.ephemeral and child.sdk_options==source.sdk_options
    async def run():
        task=await scheduler.submit('continue',conversation_id=child.id,execute_at='2080-01-01T00:00:00Z')
        assert task.project==source.project
        assert task.sdk_options==source.sdk_options
    asyncio.run(run())


def test_remote_store_helper_reuses_account_relay_settings(tmp_path,monkeypatch):
    scheduler,source=setup(tmp_path)
    (tmp_path/'accounts.conf').write_text('NAME=one TYPE=claude CLAUDE_BACKEND=sdk PROXY=relay\n')
    (tmp_path/'config.conf').write_text('RELAY_IP=172.21.0.2 RELAY_LISTEN_PORT=10808\n')
    monkeypatch.setattr(scheduler,'_get_ephemeral_network',lambda account:'fixture_intnet')
    seen=[]
    class Runtime(FakeRuntime):
        async def run(self,spec):
            seen.append(spec)
            mailbox=ControlMailbox(Path(source.project)/'.coderfleet-tasks/source.sessions',source.id,source.sdk_control_token)
            mailbox.claim('remote-read');mailbox.acknowledge('remote-read',{'value':{}})
            return FakeProcess()
    scheduler.runtime=Runtime()
    asyncio.run(scheduler.sdk_session('source','info',{},'remote-read'))
    assert seen[0].network=='fixture_intnet'
    assert seen[0].env['HTTPS_PROXY']=='http://172.21.0.2:10808'
