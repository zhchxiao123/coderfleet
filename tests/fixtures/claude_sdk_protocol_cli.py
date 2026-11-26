"""Controlled Claude CLI protocol fixture: no models, authentication or networking."""

import argparse
import json
import os
import select
import subprocess
import sys
import time
from pathlib import Path
if '--version' in sys.argv:
    if os.environ.get('FAKE_CLAUDE_SLOW_VERSION'):
        Path(os.environ['FAKE_CLAUDE_SLOW_VERSION']).write_text(json.dumps({'cli_pid':os.getpid()}))
        time.sleep(60)
    print('2.1.329 (Claude Code)')
    raise SystemExit(0)
parser = argparse.ArgumentParser(add_help=False)
for name in ('permission-mode', 'permission-prompt-tool', 'model', 'setting-sources', 'mcp-config', 'allowedTools', 'disallowedTools', 'resume', 'session-id', 'resume-session-at'):
    parser.add_argument('--' + name)
parser.add_argument('--fork-session', action='store_true')
options, _unknown = parser.parse_known_args()
sid = options.session_id or options.resume or '11111111-1111-4111-8111-111111111111'
def emit(event):
    print(json.dumps(event, ensure_ascii=False), flush=True)
for line in sys.stdin:
    message = json.loads(line)
    if message['type'] == 'control_request':
        emit({'type':'control_response','response':{'subtype':'success','request_id':message['request_id'],'response':{}}})
    elif message['type'] == 'user':
        Path(os.environ['FAKE_CLAUDE_CAPTURE']).write_text(json.dumps({'argv':sys.argv[1:],'options':vars(options),'prompt':message['message']['content'],'cwd':os.getcwd(),'task_id':os.environ.get('CODERFLEET_TASK_ID'),'claude_config_dir':os.environ.get('CLAUDE_CONFIG_DIR'),'account_marker':os.environ.get('FAKE_ACCOUNT_MARKER')}))
        emit({'type':'system','subtype':'init','session_id':sid,'model':'fixture-model'})
        emit({'type':'system','subtype':'session_state_changed','state':'running','sdk_host_only':True})
        if os.environ.get('FAKE_CLAUDE_RELEASE_GATE'):
            if os.environ.get('FAKE_CLAUDE_GATE_READY'):
                Path(os.environ['FAKE_CLAUDE_GATE_READY']).write_text(json.dumps({'cli_pid':os.getpid()}))
            while not Path(os.environ['FAKE_CLAUDE_RELEASE_GATE']).exists():
                time.sleep(0.05)
        if os.environ.get('FAKE_CLAUDE_WAIT'):
            child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
            Path(os.environ['FAKE_CLAUDE_WAIT']).write_text(json.dumps({'child_pid':child.pid,'cli_pid':os.getpid()}))
            while True:
                time.sleep(1)
        print('fixture diagnostic on stderr', file=sys.stderr, flush=True)
        emit({'type':'future_business_event','session_id':sid,'extra':{'keep':'unknown-business-field'}})
        emit({'type':'control_response','response':{'subtype':'success','request_id':'unrelated-control','response':{'private':'control-secret'}}})
        if os.environ.get('FAKE_CLAUDE_PERMISSION_PROBE'):
            decisions = {}
            for tool in ('UnapprovedTool', 'AskUserQuestion'):
                request_id = 'permission-' + tool
                emit({'type':'control_request','request_id':request_id,'request':{'subtype':'can_use_tool','tool_name':tool,'tool_use_id':request_id,'input':{'private':'permission-input-must-not-leak'}}})
                while True:
                    response = json.loads(sys.stdin.readline())
                    if response.get('type') == 'control_response' and response.get('response', {}).get('request_id') == request_id:
                        decisions[tool] = response['response'].get('response')
                        break
            Path(os.environ['FAKE_CLAUDE_PERMISSION_PROBE']).write_text(json.dumps(decisions))
        if os.environ.get('FAKE_CLAUDE_BACKGROUND_GATE'):
            emit({'type':'system','subtype':'task_started','task_id':'background-agent','task_type':'local_agent','description':'controlled background agent','uuid':'66666666-6666-4666-8666-666666666666','session_id':sid})
        text = '中文 ' + 'x' * (2 * 1024 * 1024)
        emit({'type':'assistant','uuid':'22222222-2222-4222-8222-222222222222','session_id':sid,'message':{'id':'msg_fixture','model':'fixture-model','content':[{'type':'text','text':text,'citations':[{'type':'fixture-citation'}]}],'usage':{'input_tokens':7,'output_tokens':9}}})
        if os.environ.get('FAKE_CLAUDE_AFTER_OUTPUT_GATE'):
            while not Path(os.environ['FAKE_CLAUDE_AFTER_OUTPUT_GATE']).exists():
                time.sleep(0.05)
        error = os.environ.get('FAKE_CLAUDE_RESULT_ERROR') == '1'
        aborted = os.environ.get('FAKE_CLAUDE_ABORT') == '1'
        emit({'type':'result','subtype':'error_during_execution' if error else 'success','duration_ms':1,'duration_api_ms':1,'is_error':error,'num_turns':1,'session_id':sid,'total_cost_usd':0.02,'usage':{'input_tokens':7,'output_tokens':9},'result':'answer','errors':['fixture error'] if error else None,'terminal_reason':'aborted_streaming' if aborted else 'completed'})
        if os.environ.get('FAKE_CLAUDE_BACKGROUND_GATE'):
            Path(os.environ['FAKE_CLAUDE_FIRST_RESULT_READY']).write_text('first result emitted')
            while not Path(os.environ['FAKE_CLAUDE_BACKGROUND_GATE']).exists():
                readable, _, _ = select.select([sys.stdin], [], [], 0.05)
                if readable and sys.stdin.readline() == '':
                    Path(os.environ['FAKE_CLAUDE_EARLY_EOF']).write_text('stdin closed before background completed')
                    raise SystemExit(8)
            emit({'type':'system','subtype':'task_notification','task_id':'background-agent','status':'completed','description':'controlled background agent','output_file':'/fixture/background.txt','summary':'agent completed','uuid':'77777777-7777-4777-8777-777777777777','session_id':sid})
            emit({'type':'assistant','uuid':'88888888-8888-4888-8888-888888888888','session_id':sid,'message':{'id':'msg_followup','model':'fixture-model','content':[{'type':'text','text':'background follow-up answer'}],'usage':{'input_tokens':2,'output_tokens':3}}})
            emit({'type':'result','subtype':'success','duration_ms':2,'duration_api_ms':2,'is_error':False,'num_turns':2,'session_id':sid,'total_cost_usd':0.03,'usage':{'input_tokens':9,'output_tokens':12},'result':'background follow-up answer','terminal_reason':'completed','origin':{'kind':'task-notification'}})
        emit({'type':'system','subtype':'session_state_changed','state':'idle','sdk_host_only':True})
