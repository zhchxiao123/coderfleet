"""Options are snapshots; extensions stay in the account worker boundary."""
import asyncio
import json
import os
from pathlib import Path
import subprocess

import pytest

from coderfleet.data.scripts.coderfleet_sdk_features import SQLiteSessionStore, build_options, validate_options


@pytest.mark.parametrize('value', [
    {'system_prompt':{'type':'typo','prompt':'must follow'}},
    {'system_prompt':{'type':'custom'}},{'system_prompt':{'type':'file'}},
    {'max_turns':True},{'max_budget_usd':float('nan')},{'thinking':{'type':'enabled'}},
    {'output_format':{'type':'json_schema'}},{'agents':{'bad':{'prompt':'missing description'}}},
    {'session_store':{'type':'sqlite'},'enable_file_checkpointing':True},
    {'extension':{'path':'../outside.py'}},{'cli_path':'other'},{'permission_mode':'wrong'},
])
def test_rejects_invalid_or_identity_overriding_sdk_options(value):
    with pytest.raises(ValueError): validate_options(value)


def test_validated_snapshot_owns_nested_configuration():
    value={'agents':{'reviewer':{'description':'review','prompt':'review code','maxTurns':2}},
        'thinking':{'type':'adaptive'},'output_format':{'type':'json_schema','schema':{'type':'object'}},
        'skills':['review'],'sandbox':{'enabled':True},'max_budget_usd':.5}
    copy=validate_options(value)
    value['agents']['reviewer']['prompt']='changed'
    assert copy['agents']['reviewer']['prompt']=='review code'


def test_store_concurrent_retry_deduplicates_uuid_and_preserves_opaque_entries(tmp_path):
    async def run():
        first=SQLiteSessionStore(tmp_path/'account-one/store.sqlite3')
        second=SQLiteSessionStore(tmp_path/'account-one/store.sqlite3')
        other=SQLiteSessionStore(tmp_path/'account-two/store.sqlite3')
        key={'project_key':'../../opaque','session_id':'session-one'}
        await asyncio.gather(*(store.append(key,[{'uuid':'one','unknown':{'a':[1]}},{'type':'custom-title','title':'review'}])
            for store in (first,second,first,second)))
        entries=await first.load(key)
        assert len(entries)==5
        assert entries[0]=={'uuid':'one','unknown':{'a':[1]}}
        assert await other.load(key) is None
        await first.append({**key,'subpath':'subagents/../opaque'},[{'uuid':'child'}])
        assert await first.list_subkeys(key)==['subagents/../opaque']
        listing=await first.list_sessions(key['project_key'])
        assert listing[0]['session_id']=='session-one' and listing[0]['mtime']>0
        await first.delete(key)
        assert await first.load(key) is None and await first.list_subkeys(key)==[]
        assert await first.list_sessions(key['project_key'])==[]
    asyncio.run(run())


def test_extension_is_explicit_async_factory_and_cannot_escape_project(tmp_path):
    extension=tmp_path/'extension.py'
    extension.write_text("async def create(context):\n    return {'hooks': {'Stop': context['options']}}\n")
    options=asyncio.run(build_options({'extension':{'path':'extension.py','options':{'marker':'kept'}}},str(tmp_path),{}))
    assert options=={'hooks':{'Stop':{'marker':'kept'}}}
    outside=tmp_path.parent/'outside.py'
    outside.write_text('raise AssertionError("must not execute")')
    (tmp_path/'escape.py').symlink_to(outside)
    with pytest.raises(ValueError,match='inside the project'):
        asyncio.run(build_options({'extension':{'path':'escape.py'}},str(tmp_path),{}))


def test_store_can_be_read_tagged_and_forked_by_the_real_sdk(tmp_path):
    python=os.environ.get('CODERFLEET_TEST_SDK_PYTHON')
    if not python: pytest.skip('Set CODERFLEET_TEST_SDK_PYTHON for real SDK acceptance')
    module=Path(__file__).resolve().parents[1]/'coderfleet/data/scripts/coderfleet_sdk_features.py'
    script='''
import asyncio,importlib.util,json,os
from pathlib import Path
from claude_agent_sdk import project_key_for_directory,get_session_info
spec=importlib.util.spec_from_file_location('features',os.environ['FEATURE_MODULE'])
features=importlib.util.module_from_spec(spec);spec.loader.exec_module(features)
async def run():
    cwd=os.environ['TEST_PROJECT']
    session='11111111-1111-4111-8111-111111111111'
    options=await features.build_options({'session_store':{'type':'sqlite'}},cwd,{})
    store=options['session_store']
    await store.append({'project_key':project_key_for_directory(cwd),'session_id':session},[
        {'type':'user','uuid':'22222222-2222-4222-8222-222222222222','sessionId':session,'cwd':cwd,
         'timestamp':'2026-11-12T00:00:00Z','message':{'role':'user','content':'fixture marker'}},
        {'type':'assistant','uuid':'33333333-3333-4333-8333-333333333333','parentUuid':'22222222-2222-4222-8222-222222222222',
         'sessionId':session,'cwd':cwd,'timestamp':'2026-11-12T00:00:01Z',
         'message':{'role':'assistant','content':[{'type':'text','text':'fixture reply'}]}}])
    native=Path(os.environ['CLAUDE_CONFIG_DIR'])/'projects'/project_key_for_directory(cwd)/(session+'.jsonl')
    native.parent.mkdir(parents=True)
    native.write_text(''.join(json.dumps(entry)+'\\n' for entry in await store.load({'project_key':project_key_for_directory(cwd),'session_id':session})))
    request={'task_id':'fixture','cwd':cwd,'session_id':session,'sdk_options':{'session_store':{'type':'sqlite'}},
             'allowed_session_ids':[session],'operation':'messages','arguments':{}}
    messages=await features.session_operation(request)
    assert len(messages)==2,messages
    await features.session_operation({**request,'operation':'rename','arguments':{'title':'renamed fixture'}})
    await features.session_operation({**request,'operation':'tag','arguments':{'tag':'verified'}})
    info=await features.session_operation({**request,'operation':'info'})
    assert info.custom_title=='renamed fixture' and info.tag=='verified',info
    local=get_session_info(session,directory=cwd)
    assert local.custom_title=='renamed fixture' and local.tag=='verified',local
    fork=await features.session_operation({**request,'operation':'fork','arguments':{'title':'forked fixture'}})
    assert fork.session_id != session
    assert get_session_info(fork.session_id,directory=cwd) is not None
    original_builder=features.build_options
    class MinimalStore:
        async def append(self,key,entries): await store.append(key,entries)
        async def load(self,key): return await store.load(key)
    async def minimal_options(*args): return {'session_store':MinimalStore()}
    features.build_options=minimal_options
    try:
        await features.session_operation({**request,'operation':'delete','arguments':{'confirm_session_id':session}})
    except features.SessionPreconditionError: pass
    else: raise AssertionError('append/load-only store must not report successful deletion')
    assert native.is_file()
    child_key={'project_key':project_key_for_directory(cwd),'session_id':session,'subpath':'subagents/agent-fixture.jsonl'}
    await store.append(child_key,[{'uuid':'child','message':{'role':'user','content':'child retained'}}])
    class BrokenDeleteStore(MinimalStore):
        async def delete(self,key):
            # An invalid custom adapter: drops main entries but retains children.
            with store._connect() as db:
                db.execute('DELETE FROM entries WHERE project=? AND session=? AND subpath=?',(key['project_key'],key['session_id'],''))
        async def list_subkeys(self,key): return await store.list_subkeys(key)
    async def broken_options(*args): return {'session_store':BrokenDeleteStore()}
    features.build_options=broken_options
    try:
        await features.session_operation({**request,'operation':'delete','arguments':{'confirm_session_id':session}})
    except RuntimeError as error: assert 'subagent' in str(error)
    else: raise AssertionError('partial mirror deletion must not be accepted')
    assert native.is_file() and await store.load(child_key)
    features.build_options=original_builder
    await features.session_operation({**request,'operation':'delete','arguments':{'confirm_session_id':session}})
    assert get_session_info(session,directory=cwd) is None and not native.exists()
    assert await store.load({'project_key':project_key_for_directory(cwd),'session_id':session}) is None
    print(json.dumps({'messages':len(messages),'forked':True}))
asyncio.run(run())
'''
    result=subprocess.run([python,'-I','-c',script],capture_output=True,text=True,timeout=20,
        env={**os.environ,'FEATURE_MODULE':str(module),'CLAUDE_CONFIG_DIR':str(tmp_path/'auth'),'TEST_PROJECT':str(tmp_path)})
    assert result.returncode==0,result.stderr
    assert json.loads(result.stdout)=={'messages':2,'forked':True}


def test_native_content_blocks_resolve_project_uploads_and_reject_symlink_escape(tmp_path):
    from coderfleet.data.scripts.coderfleet_claude_sdk_worker import TaskSpec,prepare_input
    uploads=tmp_path/'.coderfleet-uploads';uploads.mkdir()
    (uploads/'one.png').write_bytes(b'fixture-image')
    spec=TaskSpec(task_id='fixture',prompt='image',cwd=str(tmp_path/'nested'),attachment_root=str(uploads))
    async def run():
        prepared=await prepare_input(spec,'inspect',['/workspace/.coderfleet-uploads/one.png'])
        messages=[item async for item in prepared]
        assert messages[0]['message']['content'][1]['type']=='image'
        assert messages[0]['message']['content'][1]['source']['media_type']=='image/png'
        (uploads/'escape.png').symlink_to(tmp_path.parent/'other.png')
        with pytest.raises(ValueError,match='belong'):
            await prepare_input(spec,'inspect',['/workspace/.coderfleet-uploads/escape.png'])
    asyncio.run(run())


def test_transcript_mirror_is_consumed_by_sdk_but_not_published_as_chat_output(tmp_path,capsys):
    from coderfleet.data.scripts.coderfleet_claude_sdk_worker import CapturingTransport,TaskSpec,ErrorPresentation
    class Inner:
        async def read_messages(self):
            yield {'type':'transcript_mirror','entries':[{'opaque':'private mirror payload'}]}
            yield {'type':'assistant','message':{'content':[{'type':'text','text':'visible'}]}}
    transport=CapturingTransport(Inner(),TaskSpec(task_id='fixture',prompt='one',cwd=str(tmp_path)),ErrorPresentation())
    async def run(): return [item async for item in transport.read_messages()]
    events=asyncio.run(run())
    output=capsys.readouterr().out
    assert events[0]['type']=='transcript_mirror'
    assert 'private mirror payload' not in output and 'visible' in output
