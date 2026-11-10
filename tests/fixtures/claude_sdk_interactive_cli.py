"""Offline interactive CLI protocol peer; the SDK itself is real."""
import json
import os
from pathlib import Path
import select
import sys

if '--version' in sys.argv:
    print('2.1.321 (Claude Code)')
    raise SystemExit(0)

def emit(value):
    print(json.dumps(value), flush=True)

def result(text='answer', aborted=False):
    error = aborted and os.environ.get('FAKE_INTERACTIVE_ABORT_ERROR')
    emit({'type':'result', 'subtype':'error_during_execution' if error else 'success', 'duration_ms':1, 'duration_api_ms':1,
          'is_error':bool(error), 'errors':['aborted during tool use'] if error else [], 'num_turns':1, 'session_id':'11111111-1111-4111-8111-111111111111',
          'result':text, 'terminal_reason':'aborted_streaming' if aborted else 'completed'})

queued = []
asked = False
while True:
    ready, _, _ = select.select([sys.stdin], [], [], .03)
    if ready:
        line = sys.stdin.readline()
        if not line:
            break
        message = json.loads(line)
        if message['type'] == 'control_request':
            subtype = message['request']['subtype']
            emit({'type':'control_response','response':{'subtype':'success','request_id':message['request_id'],'response':{}}})
            if subtype == 'interrupt':
                queued.clear()
                result(aborted=True)
                if os.environ.get('FAKE_INTERACTIVE_ABORT_ERROR'): raise SystemExit(1)
                emit({'type':'system','subtype':'session_state_changed','state':'idle','sdk_host_only':True})
        elif message['type'] == 'user':
            queued.append(message['message']['content'])
            emit({'type':'system','subtype':'session_state_changed','state':'running','sdk_host_only':True})
            if os.environ.get('FAKE_INTERACTIVE_QUESTION') and not asked:
                asked = True
                questions = [{'question':'Which targets?', 'header':'Targets', 'multiSelect':True,
                              'options':[{'label':'Mac','description':'desktop'}, {'label':'Linux','description':'server'}]}]
                emit({'type':'assistant','uuid':'22222222-2222-4222-8222-222222222222','message':{'model':'fixture','content':[{'type':'tool_use','id':'native-question','name':'AskUserQuestion','input':{'questions':questions}}]}})
                emit({'type':'control_request','request_id':'permission-question','request':{'subtype':'can_use_tool','tool_name':'AskUserQuestion','tool_use_id':'native-question','input':{'questions':questions}}})
        elif message['type'] == 'control_response':
            Path(os.environ['FAKE_INTERACTIVE_ANSWER']).write_text(json.dumps(message['response']))
            Path(os.environ['FAKE_CLAUDE_RELEASE_GATE']).write_text('answered')
    if queued and Path(os.environ['FAKE_CLAUDE_RELEASE_GATE']).exists():
        prompt = queued.pop(0)
        if os.environ.get('FAKE_INTERACTIVE_COALESCE'):
            prompt = '\n'.join([prompt, *queued]); queued.clear()
        emit({'type':'assistant','uuid':'33333333-3333-4333-8333-333333333333','message':{'model':'fixture','content':[{'type':'text','text':str(prompt)}]}})
        result(str(prompt))
        if not queued:
            emit({'type':'system','subtype':'session_state_changed','state':'idle','sdk_host_only':True})
