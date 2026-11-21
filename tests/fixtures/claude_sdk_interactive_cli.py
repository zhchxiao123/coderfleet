"""Offline interactive CLI protocol peer; the SDK itself is real."""
import json
import os
from pathlib import Path
import select
import sys
import time

if '--version' in sys.argv:
    print('2.1.329 (Claude Code)')
    raise SystemExit(0)

def emit(value):
    print(json.dumps(value), flush=True)

def result(text='answer', aborted=False, uuids=None):
    error = aborted and os.environ.get('FAKE_INTERACTIVE_ABORT_ERROR')
    emit({'type':'result', 'subtype':'error_during_execution' if error else 'success', 'duration_ms':1, 'duration_api_ms':1,
          'is_error':bool(error), 'errors':['aborted during tool use'] if error else [], 'num_turns':1, 'session_id':'11111111-1111-4111-8111-111111111111',
          'result':text, 'terminal_reason':'aborted_streaming' if aborted else 'completed',
          'user_message_uuids':uuids})

def ask_permission():
    tool = os.environ.get('FAKE_INTERACTIVE_PERMISSION') or 'AskUserQuestion'
    questions = [{'question':'Which targets?', 'header':'Targets', 'multiSelect':True,
                  'options':[{'label':'Mac','description':'desktop'}, {'label':'Linux','description':'server'}]}]
    tool_input = {'questions':questions} if tool == 'AskUserQuestion' else {'command':'printf approved'} if tool == 'Bash' else {'plan':'Read-only analysis then implement the approved change'}
    emit({'type':'assistant','uuid':'22222222-2222-4222-8222-222222222222','message':{'model':'fixture','content':[{'type':'tool_use','id':'native-question','name':tool,'input':tool_input}]}})
    emit({'type':'control_request','request_id':'permission-question','request':{'subtype':'can_use_tool','tool_name':tool,'tool_use_id':'native-question','input':tool_input}})

capture_args=os.environ.get('FAKE_INTERACTIVE_ARGV')
if capture_args: Path(capture_args).write_text(json.dumps(sys.argv[1:]))
if capture_args:
    Path(capture_args).with_name('workflow-env.json').write_text(json.dumps({
        'concurrency':os.environ.get('CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS'),
    }))

queued = []
delayed = []
asked = False
workflow_started = False
workflow_spawned = False
while True:
    ready, _, _ = select.select([sys.stdin], [], [], .03)
    if ready:
        line = sys.stdin.readline()
        if not line:
            break
        message = json.loads(line)
        if message['type'] == 'control_request':
            subtype = message['request']['subtype']
            capture=os.environ.get('FAKE_INTERACTIVE_CONTROL_LOG')
            if capture:
                with open(capture,'a') as stream: stream.write(json.dumps(message['request'])+'\n')
            response={'mcpServers':[{'name':'fixture-server','status':'connected'}]} if subtype=='mcp_status' else {'categories':[],'totalTokens':42,'maxTokens':1000,'percentage':4.2} if subtype=='get_context_usage' else {}
            reply={'type':'control_response','response':{'subtype':'success','request_id':message['request_id'],'response':response}}
            if subtype=='stop_task' and workflow_spawned and os.environ.get('FAKE_INTERACTIVE_STOP_RACE'):
                emit({'type':'system','subtype':'task_notification','task_id':'native-workflow',
                      'uuid':'66666666-6666-4666-8666-666666666666','session_id':'11111111-1111-4111-8111-111111111111',
                      'status':'completed','summary':'Completed before stop','output_file':'fixture-output'})
                workflow_spawned=False
                reply={'type':'control_response','response':{'subtype':'error','request_id':message['request_id'],'error':'Task already completed'}}
            if subtype=='set_permission_mode' and os.environ.get('FAKE_INTERACTIVE_PERMISSION_BEFORE_MODE_RESPONSE'):
                ask_permission();delayed.append((time.monotonic()+.2,reply))
            else: emit(reply)
            if subtype == 'set_permission_mode' and os.environ.get('FAKE_INTERACTIVE_PERMISSION_AFTER_MODE') and not os.environ.get('FAKE_INTERACTIVE_PERMISSION_BEFORE_MODE_RESPONSE'):
                ask_permission()
            if subtype == 'interrupt':
                queued.clear()
                result(aborted=True)
                if os.environ.get('FAKE_INTERACTIVE_ABORT_ERROR'): raise SystemExit(1)
                emit({'type':'system','subtype':'session_state_changed','state':'idle','sdk_host_only':True})
            if subtype == 'stop_task' and workflow_spawned:
                emit({'type':'system','subtype':'task_notification','task_id':'native-workflow',
                      'uuid':'66666666-6666-4666-8666-666666666666','session_id':'11111111-1111-4111-8111-111111111111',
                      'status':'stopped','summary':'Workflow stopped','output_file':'fixture-output'})
                workflow_spawned=False
            if subtype == 'initialize' and os.environ.get('FAKE_INTERACTIVE_WORKFLOW_HOOK'):
                matchers=(message['request'].get('hooks') or {}).get('PreToolUse',[])
                callbacks=matchers[0].get('hookCallbackIds',[]) if matchers else []
                if not callbacks:
                    Path(os.environ['FAKE_INTERACTIVE_ANSWER']).write_text(json.dumps({'missing_hook':True}))
                else:
                    emit({'type':'control_request','request_id':'workflow-hook','request':{
                        'subtype':'hook_callback','callback_id':callbacks[0],'tool_use_id':'workflow-write',
                        'input':{'hook_event_name':'PreToolUse','tool_name':
                            'Write' if os.environ['FAKE_INTERACTIVE_WORKFLOW_HOOK']=='1' else os.environ['FAKE_INTERACTIVE_WORKFLOW_HOOK'],
                            'tool_input':{'file_path':'forbidden.txt','content':'must not write'}},
                    }})
        elif message['type'] == 'user':
            queued.append((message['message']['content'], message.get('uuid')))
            if os.environ.get('FAKE_INTERACTIVE_REWIND'):
                emit({'type':'system','subtype':'init','session_id':'11111111-1111-4111-8111-111111111111'})
            emit({'type':'system','subtype':'session_state_changed','state':'running','sdk_host_only':True})
            if os.environ.get('FAKE_INTERACTIVE_WORKFLOW') and not workflow_started:
                workflow_started=True
                tools=['Read','Glob','Grep']
                if not os.environ.get('FAKE_INTERACTIVE_NO_WORKFLOW'): tools.append('Workflow')
                emit({'type':'system','subtype':'init','tools':tools,
                      'session_id':'11111111-1111-4111-8111-111111111111'})
                if 'Workflow' in tools and not os.environ.get('FAKE_INTERACTIVE_SKIP_WORKFLOW'):
                    emit({'type':'assistant','message':{'model':'fixture','content':[{
                        'type':'tool_use','id':'workflow-tool','name':'Workflow',
                        'input':{'description':'Verify fixture facts','script':"return await agent('Read fixture.md and verify its facts')"},
                    }]}})
                    if not os.environ.get('FAKE_INTERACTIVE_WORKFLOW_LAUNCH_ERROR'):
                        workflow_spawned=True
                        emit({'type':'system','subtype':'task_started','task_id':'native-workflow',
                              'uuid':'44444444-4444-4444-8444-444444444444','session_id':'11111111-1111-4111-8111-111111111111',
                              'task_type':'local_workflow','tool_use_id':'workflow-tool','description':'Verify fixture facts'})
                    if os.environ.get('FAKE_INTERACTIVE_CHILD_INIT'):
                        emit({'type':'system','subtype':'init','parent_tool_use_id':'workflow-tool','tools':['Read'],
                              'session_id':'11111111-1111-4111-8111-111111111111'})
                    result('Workflow launched',uuids=[message['uuid']])
            if (os.environ.get('FAKE_INTERACTIVE_QUESTION') or os.environ.get('FAKE_INTERACTIVE_PERMISSION')) and not asked:
                asked = True
                if not os.environ.get('FAKE_INTERACTIVE_PERMISSION_AFTER_MODE'): ask_permission()
        elif message['type'] == 'control_response':
            Path(os.environ['FAKE_INTERACTIVE_ANSWER']).write_text(json.dumps(message['response']))
            Path(os.environ['FAKE_CLAUDE_RELEASE_GATE']).write_text('answered')
    for due,reply in delayed[:]:
        if time.monotonic()>=due: emit(reply);delayed.remove((due,reply))
    if queued and Path(os.environ['FAKE_CLAUDE_RELEASE_GATE']).exists():
        if workflow_spawned:
            emit({'type':'system','subtype':'task_notification','task_id':'native-workflow',
                  'uuid':'55555555-5555-4555-8555-555555555555','session_id':'11111111-1111-4111-8111-111111111111',
                  'status':'completed','summary':'Fixture verified','output_file':'fixture-output'})
        prompt, identity = queued.pop(0)
        uuids = [identity] if identity else []
        if os.environ.get('FAKE_INTERACTIVE_COALESCE'):
            prompt = '\n'.join([prompt, *(item[0] for item in queued)])
            uuids.extend(item[1] for item in queued if item[1]); queued.clear()
        emit({'type':'assistant','uuid':'33333333-3333-4333-8333-333333333333','user_message_uuids':uuids,
              'message':{'model':'fixture','content':[{'type':'text','text':str(prompt)}]}})
        result(str(prompt), uuids=uuids)
        if not queued:
            emit({'type':'system','subtype':'session_state_changed','state':'idle','sdk_host_only':True})
