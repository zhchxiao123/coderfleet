"""Validated SDK options and worker-only extensions. Stdlib only on the host."""
from __future__ import annotations

import asyncio
import dataclasses
import importlib.util
import importlib.metadata
import inspect
import json
import math
import os
from pathlib import Path
import sqlite3
import time
from typing import Any


def obj(properties: dict[str, Any], required: tuple[str, ...] = ()) -> dict[str, Any]:
    return {'type':'object','properties':properties,'required':list(required),'additionalProperties':False}


STRING = {'type':'string'}
STRINGS = {'type':'array','items':STRING}
BOOL = {'type':'boolean'}
POSITIVE = {'type':'integer','minimum':1}
JSON_OBJECT = {'type':'object'}
PERMISSION = {'enum':['default','acceptEdits','plan','bypassPermissions','dontAsk','auto']}
EFFORT = {'enum':['low','medium','high','xhigh','max']}
MCP_CONFIG = {'anyOf':[
    obj({'type':{'const':'stdio'},'command':STRING,'args':STRINGS,'env':{'type':'object','additionalProperties':STRING}},('command',)),
    obj({'type':{'enum':['http','sse']},'url':STRING,'headers':{'type':'object','additionalProperties':STRING}},('type','url')),
]}
MCP_MAP = {'type':'object','additionalProperties':MCP_CONFIG}
AGENT = obj({
    'description':STRING,'prompt':STRING,'tools':STRINGS,'disallowedTools':STRINGS,
    'model':{'type':'string','minLength':1},'skills':STRINGS,
    'memory':{'enum':['user','project','local']},'mcpServers':{'type':'array','items':{'anyOf':[STRING,{'type':'object','additionalProperties':MCP_CONFIG}]}},
    'initialPrompt':STRING,'maxTurns':POSITIVE,'background':BOOL,
    'effort':{'anyOf':[EFFORT,{'type':'integer'}]},'permissionMode':PERMISSION,
}, ('description','prompt'))
NETWORK = obj({**{name:STRINGS for name in ('allowedDomains','deniedDomains','allowUnixSockets','allowMachLookup')},
    **{name:BOOL for name in ('allowManagedDomainsOnly','allowAllUnixSockets','allowLocalBinding')},
    **{name:{'type':'integer','minimum':1,'maximum':65535} for name in ('httpProxyPort','socksProxyPort')}})
WORKFLOW_DEFAULTS = {'max_concurrent_agents':2,'timeout_seconds':600,'max_turns':24,'max_budget_usd':2}
OPTIONS_SCHEMA = obj({
    'native_workflow':obj({'preset':{'enum':['audit','research']},
        'max_concurrent_agents':{'type':'integer','minimum':1,'maximum':4},
        'timeout_seconds':{'type':'integer','minimum':1,'maximum':1800}},('preset',)),
    'permission_mode':PERMISSION,
    'tools':{'anyOf':[STRINGS,obj({'type':{'const':'preset'},'preset':{'const':'claude_code'}},('type','preset'))]},
    'allowed_tools':STRINGS,'disallowed_tools':STRINGS,
    'system_prompt':{'anyOf':[STRING,
        obj({'type':{'const':'preset'},'preset':{'const':'claude_code'},'append':STRING,'snapshot':BOOL,'exclude_dynamic_sections':BOOL},('type','preset')),
        obj({'type':{'const':'custom'},'prompt':STRING,'snapshot':BOOL},('type','prompt')),
        obj({'type':{'const':'file'},'path':STRING},('type','path'))]},'fallback_model':STRING,
    'max_turns':POSITIVE,'max_budget_usd':{'type':'number','exclusiveMinimum':0},
    'max_thinking_tokens':{'type':'integer','minimum':0},
    'thinking':{'anyOf':[obj({'type':{'const':'adaptive'},'display':{'enum':['summarized','omitted']}},('type',)),
        obj({'type':{'const':'disabled'}},('type',)),
        obj({'type':{'const':'enabled'},'budget_tokens':POSITIVE,'display':{'enum':['summarized','omitted']}},('type','budget_tokens'))]},
    'effort':EFFORT,'task_budget':obj({'total':POSITIVE},('total',)),
    'output_format':obj({'type':{'const':'json_schema'},'schema':JSON_OBJECT},('type','schema')),
    'betas':STRINGS,'add_dirs':STRINGS,'settings':STRING,
    'setting_sources':{'type':'array','items':{'enum':['user','project','local']}},
    'skills':{'anyOf':[STRINGS,{'const':'all'}]},
    'agents':{'type':'object','additionalProperties':AGENT},
    'mcp_servers':{'anyOf':[MCP_MAP,STRING]},'strict_mcp_config':BOOL,
    'plugins':{'type':'array','items':obj({'type':{'const':'local'},'path':STRING},('type','path'))},
    'sandbox':obj({**{name:BOOL for name in ('enabled','autoAllowBashIfSandboxed','allowUnsandboxedCommands','enableWeakerNestedSandbox')},
        'excludedCommands':STRINGS,'network':NETWORK,'ignoreViolations':{'type':'object','additionalProperties':STRINGS}}),
    **{name:BOOL for name in ('include_partial_messages','include_hook_events','forward_subagent_text','verbatim_prompts','enable_file_checkpointing')},
    'session_store':obj({'type':{'const':'sqlite'}},('type',)),
    'session_store_flush':{'enum':['batched','eager']},'load_timeout_ms':{'type':'integer','minimum':0},
    'extension':obj({'path':STRING,'factory':STRING,'options':JSON_OBJECT},('path',)),
})

PAGE = {'limit':{'type':'integer','minimum':1,'maximum':200},'offset':{'type':'integer','minimum':0}}
SESSION_SCHEMAS = {
    'info':obj({}), 'list':obj(PAGE), 'messages':obj(PAGE), 'subagents':obj({}),
    'subagent_messages':obj({'agent_id':STRING,**PAGE},('agent_id',)),
    'rename':obj({'title':STRING},('title',)),
    'tag':obj({'tag':{'anyOf':[STRING,{'const':None}]}},('tag',)),
    'fork':obj({'title':STRING,'up_to_message_id':STRING}),
    'delete':obj({'confirm_session_id':STRING},('confirm_session_id',)),
    'import_store':obj({}),
}
HOOK_EVENTS = frozenset({'PreToolUse','PostToolUse','PostToolUseFailure','UserPromptSubmit','Stop','SubagentStop','PreCompact','Notification','SubagentStart','PermissionRequest'})
SESSION_MUTATIONS = frozenset({'rename','tag','fork','delete','import_store'})
WORKFLOW_OPTIONS = frozenset({'native_workflow','max_turns','max_budget_usd','max_thinking_tokens',
    'thinking','effort','task_budget','fallback_model','include_partial_messages','forward_subagent_text','output_format'})


def validate(value: Any, schema: dict[str, Any], path: str = 'sdk_options') -> None:
    """Validate the deliberately small JSON-schema vocabulary used above."""
    if 'anyOf' in schema:
        for choice in schema['anyOf']:
            try:
                validate(value, choice, path)
                return
            except ValueError:
                pass
        raise ValueError(f'{path}: value does not match an allowed shape')
    if 'enum' in schema and value not in schema['enum']:
        raise ValueError(f'{path}: expected one of {schema["enum"]}')
    if 'const' in schema and value != schema['const']:
        raise ValueError(f'{path}: expected {schema["const"]}')
    kind = schema.get('type')
    checks = {'object':lambda: isinstance(value,dict),'array':lambda: isinstance(value,list),
        'string':lambda:isinstance(value,str),'boolean':lambda:isinstance(value,bool),
        'integer':lambda:isinstance(value,int) and not isinstance(value,bool),
        'number':lambda:isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value)}
    if kind and not checks[kind]():
        raise ValueError(f'{path}: expected {kind}')
    if kind == 'object':
        for key in schema.get('required', []):
            if key not in value: raise ValueError(f'{path}.{key}: required')
        properties = schema.get('properties', {})
        extra = schema.get('additionalProperties', True)
        for key, item in value.items():
            if key in properties: validate(item,properties[key],f'{path}.{key}')
            elif extra is False: raise ValueError(f'{path}.{key}: unsupported option')
            elif isinstance(extra,dict): validate(item,extra,f'{path}.{key}')
    if kind == 'string':
        if len(value) < schema.get('minLength',0): raise ValueError(f'{path}: empty string is not allowed')
        if 'maxLength' in schema and len(value) > schema['maxLength']: raise ValueError(f'{path}: string is too long')
    if kind == 'array' and 'items' in schema:
        for index,item in enumerate(value): validate(item,schema['items'],f'{path}[{index}]')
    if kind in ('integer','number'):
        if 'minimum' in schema and value < schema['minimum']: raise ValueError(f'{path}: too small')
        if 'exclusiveMinimum' in schema and value <= schema['exclusiveMinimum']: raise ValueError(f'{path}: must be positive')
        if 'maximum' in schema and value > schema['maximum']: raise ValueError(f'{path}: too large')


def validate_options(value: Any) -> dict[str, Any]:
    try:
        raw = json.dumps(value,allow_nan=False)
    except (TypeError,ValueError,RecursionError) as error:
        raise ValueError('sdk_options must be finite JSON') from error
    if len(raw.encode()) > 256 * 1024: raise ValueError('sdk_options exceeds 256 KiB')
    validate(value,OPTIONS_SCHEMA)
    result: dict[str, Any] = json.loads(raw)  # Own the snapshot, including all nested values.
    if result.get('native_workflow'):
        conflicts = sorted(set(result) - WORKFLOW_OPTIONS)
        if conflicts:
            raise ValueError('native_workflow owns the read-only execution policy; conflicting options: '+', '.join(conflicts))
        if result.get('max_turns',WORKFLOW_DEFAULTS['max_turns']) > 40 or result.get('max_budget_usd',WORKFLOW_DEFAULTS['max_budget_usd']) > 10:
            raise ValueError('native_workflow allows at most 40 turns and a 10 USD SDK budget')
    if result.get('session_store') and result.get('enable_file_checkpointing'):
        raise ValueError('SDK 0.2.186 cannot combine session_store with file checkpointing')
    if result.get('extension'):
        path = Path(result['extension']['path'])
        if path.is_absolute() or '..' in path.parts or not path.parts:
            raise ValueError('extension.path must be a project-relative Python file')
        factory = result['extension'].get('factory','create')
        if not factory.isidentifier() or factory.startswith('_'): raise ValueError('Invalid extension factory')
    return result


class SQLiteSessionStore:
    """Account-local durable mirror; SDK SessionStore duck protocol, no SDK import."""
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        with self._connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS entries(seq INTEGER PRIMARY KEY,project TEXT,session TEXT,subpath TEXT,uuid TEXT,payload TEXT,UNIQUE(project,session,subpath,uuid))')
            db.execute('CREATE TABLE IF NOT EXISTS sessions(project TEXT,session TEXT,mtime INTEGER,PRIMARY KEY(project,session))')
        os.chmod(path,0o600)

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.path,timeout=30)

    @staticmethod
    def _key(key: dict[str, Any]) -> tuple[str,str,str]:
        project,session,subpath = key.get('project_key'),key.get('session_id'),key.get('subpath','')
        if not isinstance(project,str) or not project or not isinstance(session,str) or not session:
            raise ValueError('SessionStore requires project_key and session_id')
        if not isinstance(subpath,str) or ('subpath' in key and not subpath): raise ValueError('Invalid subpath')
        return project,session,subpath

    def _append(self, key: dict[str, Any], entries: list[dict[str, Any]]) -> None:
        project,session,subpath = self._key(key)
        with self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            for entry in entries:
                identifier = entry.get('uuid')
                db.execute('INSERT OR IGNORE INTO entries(project,session,subpath,uuid,payload) VALUES(?,?,?,?,?)',
                    (project,session,subpath,identifier if isinstance(identifier,str) and identifier else None,json.dumps(entry,ensure_ascii=False,allow_nan=False)))
            db.execute('INSERT INTO sessions VALUES(?,?,?) ON CONFLICT(project,session) DO UPDATE SET mtime=excluded.mtime',
                (project,session,time.time_ns() // 1_000_000))

    async def append(self, key: dict[str, Any], entries: list[dict[str, Any]]) -> None:
        await asyncio.to_thread(self._append,key,entries)

    def _load(self, key: dict[str, Any]) -> list[dict[str, Any]] | None:
        with self._connect() as db:
            rows = db.execute('SELECT payload FROM entries WHERE project=? AND session=? AND subpath=? ORDER BY seq',self._key(key)).fetchall()
        return [json.loads(row[0]) for row in rows] if rows else None

    async def load(self, key: dict[str, Any]) -> list[dict[str, Any]] | None:
        return await asyncio.to_thread(self._load,key)

    async def list_sessions(self, project_key: str) -> list[dict[str, Any]]:
        def read() -> list[dict[str, Any]]:
            with self._connect() as db:
                return [{'session_id':row[0],'mtime':row[1]} for row in db.execute('SELECT session,mtime FROM sessions WHERE project=? ORDER BY mtime DESC',(project_key,))]
        return await asyncio.to_thread(read)

    async def list_subkeys(self, key: dict[str, Any]) -> list[str]:
        project,session,_ = self._key(key)
        def read() -> list[str]:
            with self._connect() as db:
                return [row[0] for row in db.execute('SELECT DISTINCT subpath FROM entries WHERE project=? AND session=? AND subpath<>?',(project,session,''))]
        return await asyncio.to_thread(read)

    async def delete(self, key: dict[str, Any]) -> None:
        project,session,subpath = self._key(key)
        def remove() -> None:
            with self._connect() as db:
                db.execute('BEGIN IMMEDIATE')
                if subpath:
                    db.execute('DELETE FROM entries WHERE project=? AND session=? AND subpath=?',(project,session,subpath))
                else:
                    db.execute('DELETE FROM entries WHERE project=? AND session=?',(project,session))
                    db.execute('DELETE FROM sessions WHERE project=? AND session=?',(project,session))
        await asyncio.to_thread(remove)


async def build_options(value: dict[str, Any], cwd: str, context: dict[str, Any]) -> dict[str, Any]:
    """Called ONLY in the account worker, where project code may execute."""
    options = validate_options(value)
    profile = options.pop('native_workflow',None)
    if profile:
        tools = ['Read','Glob','Grep','Workflow']
        if profile['preset'] == 'research': tools += ['WebSearch','WebFetch']
        settings: dict[str,Any] = {'workflowSizeGuideline':'small'}
        account_root = Path(os.environ.get('CLAUDE_CONFIG_DIR') or Path.home()/'.claude')
        project_root = Path(context.get('project_root',cwd))
        for path in (account_root/'settings.json',project_root/'.claude/settings.json',project_root/'.claude/settings.local.json'):
            if not path.exists(): continue
            if path.stat().st_size > 256*1024: raise ValueError('native_workflow policy settings exceed 256 KiB')
            policy = json.loads(path.read_text(encoding='utf-8'))
            if not isinstance(policy,dict) or ('disableWorkflows' in policy and not isinstance(policy['disableWorkflows'],bool)):
                raise ValueError('native_workflow requires valid workflow policy settings')
            if policy.get('disableWorkflows') is True: settings['disableWorkflows'] = True
            permissions = policy.get('permissions',{})
            if not isinstance(permissions,dict): raise ValueError('native_workflow requires valid permission policy settings')
            for kind in ('deny','ask'):
                rules = permissions.get(kind,[])
                validate(rules,STRINGS,'native_workflow.permissions.'+kind)
                if rules:
                    denied = settings.setdefault('permissions',{}).setdefault('deny',[])
                    denied[:] = list(dict.fromkeys([*denied,*rules]))
        options.setdefault('max_turns',WORKFLOW_DEFAULTS['max_turns'])
        options.setdefault('max_budget_usd',WORKFLOW_DEFAULTS['max_budget_usd'])
        options.update(tools=tools,allowed_tools=tools,permission_mode='dontAsk',
            disallowed_tools=['Bash','Write','Edit','MultiEdit','NotebookEdit','Agent','Task','EnterWorktree','ExitWorktree'],
            setting_sources=[],agents={},plugins=[],mcp_servers={},strict_mcp_config=True,
            env={'CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS':str(profile.get('max_concurrent_agents',WORKFLOW_DEFAULTS['max_concurrent_agents']))},
            settings=json.dumps(settings))
        return options
    extension = options.pop('extension',None)
    if isinstance(options.get('mcp_servers'),str):
        data = json.loads((Path(cwd)/options['mcp_servers']).read_text(encoding='utf-8'))
        servers = data.get('mcpServers',data) if isinstance(data,dict) else data
        validate(servers,MCP_MAP,'mcp_servers')
        options['mcp_servers'] = servers
    if 'agents' in options:
        agent_type = importlib.import_module('claude_agent_sdk').AgentDefinition
        options['agents'] = {name:agent_type(**definition) for name,definition in options['agents'].items()}
    if options.pop('session_store',None):
        root = Path(os.environ.get('CLAUDE_CONFIG_DIR') or Path.home() / '.claude')
        options['session_store'] = SQLiteSessionStore(root / 'coderfleet-session-store' / 'sessions.sqlite3')
    if extension:
        root = Path(context.get('project_root',cwd)).resolve()
        path = (root / extension['path']).resolve()
        if not path.is_relative_to(root) or not path.is_file(): raise ValueError('Extension must resolve to a file inside the project')
        module_spec = importlib.util.spec_from_file_location('_coderfleet_project_extension',path)
        if module_spec is None or module_spec.loader is None: raise ValueError('Cannot load SDK extension')
        module = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(module)
        factory = getattr(module,extension.get('factory','create'))
        extra = factory({**context,'cwd':cwd,'options':extension.get('options',{})})
        if inspect.isawaitable(extra): extra = await extra
        if not isinstance(extra,dict) or set(extra) - {'hooks','mcp_servers','session_store'}:
            raise ValueError('Extension must return hooks, mcp_servers and/or session_store')
        for key,item in extra.items():
            if key in ('hooks','mcp_servers'):
                if not isinstance(item,dict): raise ValueError(f'Extension {key} must be a mapping')
                if key == 'hooks' and set(item) - HOOK_EVENTS:
                    raise ValueError('Extension contains unsupported hook events for SDK 0.2.186')
                overlap = set(options.get(key,{})) & set(item)
                if overlap: raise ValueError(f'Duplicate extension {key}: {sorted(overlap)}')
                options[key] = {**options.get(key,{}),**item}
            elif key in options: raise ValueError('Multiple SessionStore providers')
            else: options[key] = item
    if options.get('session_store') and options.get('enable_file_checkpointing'):
        raise ValueError('SDK 0.2.186 cannot combine SessionStore with file checkpointing')
    return options


class SessionPreconditionError(ValueError):
    """A session operation was rejected before any native metadata mutation."""


async def session_operation(request: dict[str, Any]) -> Any:
    """Native transcript helpers run without starting a model or an agent."""
    if importlib.metadata.version('claude-agent-sdk') != '0.2.186':
        raise ValueError('claude-agent-sdk 0.2.186 is required')
    sdk = importlib.import_module('claude_agent_sdk')
    operation,arguments = request['operation'],dict(request['arguments'])
    validate(arguments,SESSION_SCHEMAS[operation],'arguments')
    cwd,session = request['cwd'],request['session_id']
    configured = await build_options(request.get('sdk_options',{}),cwd,{'task_id':request['task_id'],'emit':lambda event:None,'project_root':request.get('project_root',cwd)})
    store = configured.get('session_store')
    common = {'directory':cwd}
    queries = {'info':'get_session_info','messages':'get_session_messages','subagents':'list_subagents',
        'subagent_messages':'get_subagent_messages','list':'list_sessions'}
    if operation == 'import_store':
        if store is None: raise ValueError('Task has no SessionStore provider')
        await sdk.import_session_to_store(session,store,directory=cwd,include_subagents=True)
        return {'imported':True}
    if operation == 'list':
        values = []
        for identifier in request['allowed_session_ids']:
            info = (sdk.get_session_info(identifier,directory=cwd) if store is None else
                    await sdk.get_session_info_from_store(store,identifier,directory=cwd))
            if info is not None: values.append(info)
        values.sort(key=lambda info:info.last_modified,reverse=True)
        offset,limit = arguments.get('offset',0),arguments.get('limit',100)
        return values[offset:offset+limit]
    if operation in queries:
        name = queries[operation]
        if operation in {'messages','subagent_messages'}: arguments.setdefault('limit',100)
        if store is None:
            return getattr(sdk,name)(session,**common,**arguments)
        return await getattr(sdk,name + '_from_store')(store,session,**common,**arguments)
    arguments.pop('confirm_session_id',None)
    name = {'rename':'rename_session','tag':'tag_session','fork':'fork_session','delete':'delete_session'}[operation]
    local = sdk.get_session_info(session,directory=cwd)
    if store is None:
        return getattr(sdk,name)(session,**common,**arguments)
    if operation == 'delete':
        if not callable(getattr(store,'delete',None)):
            raise SessionPreconditionError('SessionStore does not support deletion; native records were retained')
        if not callable(getattr(store,'list_subkeys',None)):
            raise SessionPreconditionError('SessionStore cannot verify subagent deletion; native records were retained')
    # Native files remain the SDK's first resume source. Keep both copies in
    # agreement; an interrupted two-store mutation remains unconfirmed.
    if local is not None and operation in {'rename','tag'} and await sdk.get_session_info_from_store(store,session,directory=cwd) is None:
        await sdk.import_session_to_store(session,store,directory=cwd,include_subagents=True)
    if operation == 'fork' and local is not None:
        value = sdk.fork_session(session,**common,**arguments)
        await sdk.import_session_to_store(value.session_id,store,directory=cwd,include_subagents=True)
        return value
    value = await getattr(sdk,name + '_via_store')(store,session,**common,**arguments)
    if operation == 'delete':
        key = {'project_key':sdk.project_key_for_directory(cwd),'session_id':session}
        if await store.load(key) is not None or await store.list_subkeys(key):
            raise RuntimeError('SessionStore did not confirm main and subagent deletion; native records were retained')
    if local is not None:
        getattr(sdk,name)(session,**common,**arguments)
    return value



def _plain(value: Any) -> Any:
    if dataclasses.is_dataclass(value) and not isinstance(value,type): return dataclasses.asdict(value)
    if isinstance(value,list): return [_plain(item) for item in value]
    if isinstance(value,dict): return {key:_plain(item) for key,item in value.items()}
    return value


def session_main() -> int:
    import sys
    request = json.loads(Path(sys.argv[1]).read_text())
    protocol_spec = importlib.util.spec_from_file_location('_coderfleet_session_protocol',request['protocol_module'])
    if protocol_spec is None or protocol_spec.loader is None: raise ValueError('Missing protocol module')
    protocol = importlib.util.module_from_spec(protocol_spec)
    protocol_spec.loader.exec_module(protocol)
    mailbox = protocol.ControlMailbox(Path(request['control_directory']),request['task_id'],request['control_token'])
    identifier = request['request_id']
    if mailbox.reply(identifier): return 0
    commands = {item['id']:item for item in mailbox.pending()}
    if identifier not in commands: return 1  # A previous worker claimed it: never replay.
    mailbox.claim(identifier)
    command = commands[identifier]
    try:
        if command['kind'] != 'session' or command['payload'] != {'operation':request['operation'],'arguments':request['arguments']}:
            raise ValueError('Session command identity mismatch')
        value = asyncio.run(session_operation(request))
        mailbox.acknowledge(identifier,{'operation':request['operation'],'value':_plain(value)})
    except SessionPreconditionError as error:
        mailbox.acknowledge(identifier,error=str(error))
        return 1
    except Exception:
        # SDK metadata mutations may have appended before an I/O failure. Avoid
        # replaying them; reads can report a definite failure without side effects.
        if request['operation'] not in SESSION_MUTATIONS:
            mailbox.acknowledge(identifier,error='Native session query failed; verify the account transcript and SDK installation')
        return 1
    finally:
        mailbox._write(mailbox.directory / (identifier + '.finished.json'),{'finished':True})
    return 0


if __name__ == '__main__':
    raise SystemExit(session_main())
