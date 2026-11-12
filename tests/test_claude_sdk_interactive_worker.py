"""Interactive worker commands through the real pinned SDK and offline CLI."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import time

import pytest

from coderfleet.account_type_registry import claude_mcp_options
from coderfleet.data.scripts.coderfleet_sdk_control import ControlMailbox


ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / 'coderfleet/data/scripts/coderfleet_claude_sdk_worker.py'
PROTOCOL = ROOT / 'coderfleet/data/scripts/coderfleet_sdk_control.py'


@pytest.fixture
def interactive_worker(tmp_path: Path, request):
    python = os.environ.get('CODERFLEET_TEST_SDK_PYTHON')
    if not python:
        pytest.skip('Set CODERFLEET_TEST_SDK_PYTHON for real SDK protocol acceptance')
    cli = tmp_path / 'claude-fixture'
    cli.write_text(f'#!{sys.executable}\n' + (ROOT / 'tests/fixtures/claude_sdk_interactive_cli.py').read_text())
    cli.chmod(0o755)
    directory = tmp_path / 'control'
    token = 'a' * 64
    specification = tmp_path / 'task.sdk.json'
    gate = tmp_path / 'release'
    spec = {'task_id': 'interactive', 'prompt': 'initial', 'cwd': str(tmp_path),
            'question_timeout_seconds': 600,
            'control_directory': str(directory), 'control_token': token, 'control_module': str(PROTOCOL),
            'state_path': str(tmp_path / 'state.json'), 'diagnostic_path': str(tmp_path / 'diagnostic.log'),
            'mcp_options': claude_mcp_options(allow_ask_user=True)}
    spec.update(getattr(request, 'param', {}).get('spec', {}))
    specification.write_text(json.dumps(spec))
    with (tmp_path / 'events.jsonl').open('w') as output:
        process = subprocess.Popen([os.path.abspath(python), '-I', str(WORKER), '--spec', str(specification)],
                                   stdout=output, stderr=subprocess.PIPE,
                                   env={**os.environ, 'CODERFLEET_CLAUDE_CLI_PATH': str(cli),
                                        'FAKE_INTERACTIVE_ANSWER': str(tmp_path / 'answer.json'),
                                        'FAKE_INTERACTIVE_ARGV':str(tmp_path/'argv.json'),
                                        **getattr(request, 'param', {}).get('env', {}),
                                        'FAKE_CLAUDE_RELEASE_GATE': str(gate)})
        try:
            mailbox = ControlMailbox(directory, 'interactive', token)
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                if mailbox.state().get('status') == 'accepting':
                    break
                if process.poll() == 0 and mailbox.state().get('status') == 'closed':
                    break  # Auto denial and short timeout can finish before the first poll.
                if process.poll() is not None:
                    raise AssertionError((tmp_path / 'events.jsonl').read_text())
                time.sleep(0.03)
            else:
                raise AssertionError('Worker control channel never became ready')
            yield process, mailbox, gate, tmp_path
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
            process.communicate(timeout=5)


def test_worker_acknowledges_control_command_while_the_model_is_running(interactive_worker) -> None:
    process, mailbox, gate, root = interactive_worker
    mailbox.submit('ping-one', 'ping', {})
    deadline = time.monotonic() + 3
    reply = None
    while time.monotonic() < deadline:
        reply = mailbox.reply('ping-one')
        if reply:
            break
        time.sleep(0.03)
    assert reply and reply['status'] == 'accepted' and reply['result']['connected'] is True
    assert process.poll() is None, 'A control command must not end the Task'
    gate.write_text('complete')
    assert process.wait(timeout=10) == 0, (root / 'events.jsonl').read_text()
    assert mailbox.state()['status'] == 'closed'
    assert 'a' * 64 not in (root / 'events.jsonl').read_text()


@pytest.mark.parametrize('interactive_worker', [{'env': {'FAKE_INTERACTIVE_QUESTION': '1'}}], indirect=True)
def test_native_question_waits_for_answer_and_returns_updated_input(interactive_worker) -> None:
    process, mailbox, _gate, root = interactive_worker
    deadline = time.monotonic() + 3
    while 'coderfleet_question_pending' not in (root / 'events.jsonl').read_text() and time.monotonic() < deadline:
        time.sleep(.03)
    assert 'coderfleet_question_pending' in (root / 'events.jsonl').read_text()
    mailbox.submit('answer-one', 'answer', {'tool_call_id': 'native-question', 'answers': {'Which targets?': ['Mac', 'Linux']}})
    assert process.wait(timeout=10) == 0
    response = json.loads((root / 'answer.json').read_text())['response']
    assert response['behavior'] == 'allow'
    assert response['updatedInput']['answers'] == {'Which targets?': 'Mac, Linux'}
    assert response['updatedInput']['questions'][0]['multiSelect'] is True
    assert mailbox.reply('answer-one')['status'] == 'accepted'


@pytest.mark.parametrize('interactive_worker', [{}, {'env':{'FAKE_INTERACTIVE_ABORT_ERROR':'1'}}, {'env':{'FAKE_INTERACTIVE_QUESTION':'1'}}], indirect=True)
def test_interrupt_uses_sdk_control_and_finishes_with_cancelled_session(interactive_worker) -> None:
    process, mailbox, _gate, root = interactive_worker
    mailbox.submit('interrupt-one', 'interrupt', {})
    assert process.wait(timeout=10) == 143
    assert mailbox.reply('interrupt-one')['status'] == 'accepted'
    events = (root / 'events.jsonl').read_text()
    assert 'aborted_streaming' in events
    assert 'coderfleet_interrupted' in events
    assert json.loads((root / 'state.json').read_text())['status'] == 'cancelled'


def test_live_message_is_not_lost_at_first_result_and_retry_is_idempotent(interactive_worker) -> None:
    process, mailbox, gate, root = interactive_worker
    mailbox.submit('message-one', 'message', {'text':'supplemental instruction'})
    deadline = time.monotonic() + 3
    while not mailbox.reply('message-one') and time.monotonic() < deadline:
        time.sleep(.03)
    assert mailbox.reply('message-one')['status'] == 'accepted'
    mailbox.submit('message-one', 'message', {'text':'supplemental instruction'})
    gate.write_text('complete')
    assert process.wait(timeout=10) == 0
    events = [json.loads(line) for line in (root / 'events.jsonl').read_text().splitlines()]
    results = [event['result'] for event in events if event.get('type') == 'result']
    assert results == ['initial', 'supplemental instruction']
    assert len([event for event in events if event.get('subtype') == 'coderfleet_message_accepted']) == 1


@pytest.mark.parametrize('interactive_worker', [{'env':{'FAKE_INTERACTIVE_COALESCE':'1'}}], indirect=True)
def test_live_input_can_be_consumed_in_the_current_turn(interactive_worker) -> None:
    process, mailbox, gate, root = interactive_worker
    mailbox.submit('coalesced', 'message', {'text':'supplement merged into current turn'})
    deadline = time.monotonic() + 3
    while not mailbox.reply('coalesced') and time.monotonic() < deadline: time.sleep(.03)
    assert mailbox.reply('coalesced')['status'] == 'accepted'
    gate.write_text('complete')
    assert process.wait(timeout=5) == 0
    assert 'supplement merged into current turn' in (root / 'events.jsonl').read_text()


@pytest.mark.parametrize('interactive_worker', [{'env':{'FAKE_INTERACTIVE_QUESTION':'1'}, 'spec':{'question_timeout_seconds':.1}}], indirect=True)
def test_native_question_timeout_denies_the_tool_and_closes_the_form(interactive_worker) -> None:
    process, _mailbox, _gate, root = interactive_worker
    assert process.wait(timeout=10) == 0
    response = json.loads((root / 'answer.json').read_text())['response']
    assert response['behavior'] == 'deny'
    assert 'timed out' in response['message']
    assert '"status": "timed_out"' in (root / 'events.jsonl').read_text()


@pytest.mark.parametrize('interactive_worker', [{'env':{'FAKE_INTERACTIVE_QUESTION':'1'}, 'spec':{'auto':True}}], indirect=True)
def test_auto_native_question_is_denied_without_waiting_for_a_person(interactive_worker) -> None:
    process, _mailbox, _gate, root = interactive_worker
    assert process.wait(timeout=10) == 0
    assert json.loads((root / 'answer.json').read_text())['response']['behavior'] == 'deny'
    assert 'coderfleet_question_pending' not in (root / 'events.jsonl').read_text()


@pytest.mark.parametrize('interactive_worker', [{'env':{'FAKE_INTERACTIVE_PERMISSION':'Bash'}}], indirect=True)
def test_unapproved_tool_waits_for_operator_and_returns_the_exact_requested_input(interactive_worker):
    process, mailbox, _gate, root = interactive_worker
    deadline = time.monotonic() + 3
    while 'coderfleet_permission_pending' not in (root / 'events.jsonl').read_text() and time.monotonic() < deadline:
        if process.poll() is not None: break
        time.sleep(.03)
    events=(root / 'events.jsonl').read_text()
    assert 'coderfleet_permission_pending' in events, 'Generic tool approval must reach the operator instead of being silently denied'
    assert process.poll() is None
    mailbox.submit('approval-one','approval',{'tool_call_id':'native-question','decision':'allow'})
    assert process.wait(timeout=10)==0
    response=json.loads((root / 'answer.json').read_text())['response']
    assert response['behavior']=='allow'
    assert response['updatedInput']=={'command':'printf approved'}
    assert mailbox.reply('approval-one')['status']=='accepted'


def test_running_sdk_supports_model_permission_and_mcp_control_without_starting_a_new_task(interactive_worker):
    process,mailbox,gate,root=interactive_worker
    for identity,operation,arguments in [
        ('model-one','set_model',{'model':'fixture-new-model'}),
        ('permission-one','set_permission_mode',{'mode':'plan'}),
        ('mcp-one','get_mcp_status',{}),
        ('context-one','get_context_usage',{}),
        ('server-one','get_server_info',{}),
        ('reconnect-one','reconnect_mcp_server',{'server_name':'fixture-server'}),
        ('toggle-one','toggle_mcp_server',{'server_name':'fixture-server','enabled':True}),
        ('stop-one','stop_task',{'task_id':'native-background-fixture'}),
    ]:
        mailbox.submit(identity,'control',{'operation':operation,'arguments':arguments})
        deadline=time.monotonic()+3
        while not mailbox.reply(identity) and time.monotonic()<deadline: time.sleep(.03)
        reply=mailbox.reply(identity)
        assert reply and reply['status']=='accepted', reply
        if operation=='get_mcp_status': assert reply['result']['value']['mcpServers'][0]['name']=='fixture-server'
        assert process.poll() is None
    gate.write_text('complete')
    assert process.wait(timeout=10)==0
    assert 'fixture-new-model' in (root/'events.jsonl').read_text()


@pytest.mark.parametrize('interactive_worker',[{'spec':{'prompt':'[recover]','sdk_options':{'enable_file_checkpointing':True},
    'sdk_action':{'operation':'rewind_files','source_session_id':'11111111-1111-4111-8111-111111111111',
                  'user_message_id':'22222222-2222-4222-8222-222222222222','request_id':'recover-one','source_task_id':'original'}},
    'env':{'FAKE_INTERACTIVE_REWIND':'1'}}],indirect=True)
def test_recovery_task_uses_empty_prompt_and_native_rewind_without_replaying_source(interactive_worker):
    process,_mailbox,_gate,root=interactive_worker
    assert process.wait(timeout=10)==0,(root/'events.jsonl').read_text()
    events=[json.loads(line) for line in (root/'events.jsonl').read_text().splitlines()]
    assert any(event.get('subtype')=='coderfleet_files_rewound' for event in events)
    result=[event for event in events if event.get('type')=='result'][-1]
    assert result['num_turns']==0 and result['is_error'] is False


@pytest.mark.parametrize(('interactive_worker','tool'),[({'spec':{'auto':True},
    'env':{'FAKE_INTERACTIVE_PERMISSION':tool,'FAKE_INTERACTIVE_PERMISSION_AFTER_MODE':'1','FAKE_INTERACTIVE_PERMISSION_BEFORE_MODE_RESPONSE':'1'}},tool)
    for tool in ('Bash','ExitPlanMode','AskUserQuestion')],indirect=['interactive_worker'])
def test_switching_from_bypass_to_manual_enables_native_callbacks(interactive_worker,tool):
    process,mailbox,gate,root=interactive_worker
    mailbox.submit('mode-manual','control',{'operation':'set_permission_mode','arguments':{'mode':'default'}})
    deadline=time.monotonic()+4
    while 'coderfleet_' + ('question_pending' if tool=='AskUserQuestion' else 'permission_pending') not in (root/'events.jsonl').read_text() and time.monotonic()<deadline:
        time.sleep(.02)
    assert 'pending' in (root/'events.jsonl').read_text(),(root/'events.jsonl').read_text()
    if tool=='AskUserQuestion': mailbox.submit('manual-answer','answer',{'tool_call_id':'native-question','answers':{'Which targets?':'Mac'}})
    else: mailbox.submit('manual-approve','approval',{'tool_call_id':'native-question','decision':'allow'})
    assert process.wait(timeout=10)==0,(root/'events.jsonl').read_text()
    response=json.loads((root/'answer.json').read_text())['response']
    assert response['behavior']=='allow'
    if tool=='ExitPlanMode': assert response['updatedPermissions'][0]['mode']=='acceptEdits'


@pytest.mark.parametrize('interactive_worker',[{'spec':{'sdk_options':{'system_prompt':{'type':'custom','prompt':'CUSTOM_PROMPT'}},'append_system_prompt':'CF_REQUIRED_HINT'}}],indirect=True)
def test_custom_prompt_keeps_coderfleet_system_hint_in_actual_sdk_cli_arguments(interactive_worker):
    process,_mailbox,gate,root=interactive_worker
    arguments=json.loads((root/'argv.json').read_text())
    value=arguments[arguments.index('--system-prompt')+1]
    assert 'CUSTOM_PROMPT' in value and 'CF_REQUIRED_HINT' in value
    gate.write_text('done');assert process.wait(timeout=10)==0


def test_rejected_attachment_does_not_reopen_the_sdk_run_gate(interactive_worker):
    process,mailbox,gate,root=interactive_worker
    mailbox.submit('bad-image','message',{'text':'','images':['/workspace/.coderfleet-uploads/missing.png']})
    deadline=time.monotonic()+3
    while not mailbox.reply('bad-image') and time.monotonic()<deadline: time.sleep(.02)
    assert mailbox.reply('bad-image')['status']=='rejected'
    gate.write_text('done');assert process.wait(timeout=10)==0
