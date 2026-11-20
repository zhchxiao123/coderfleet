#!/usr/bin/env python3
"""Standalone Claude SDK worker; copied into the account's execution boundary.

The main CoderFleet service never imports the SDK or its MCP dependencies.
Only this process imports the pinned SDK, and stdout is reserved for JSON.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import mimetypes
from collections.abc import AsyncIterator
from contextlib import redirect_stderr, suppress
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
import importlib
import importlib.metadata
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import secrets
import signal
import subprocess
import sys
import uuid
from typing import Any, TextIO, Callable

SDK_VERSION = "0.2.186"
CLI_VERSION = "2.1.329"
OWNERSHIP_TOKEN = secrets.token_hex(16)


@dataclass(frozen=True)
class TaskSpec:
    task_id: str
    prompt: str
    cwd: str
    auto: bool = False
    model: str = ""
    session_id: str = ""
    fork_session_id: str = ""
    resume_session_at: str = ""
    images: tuple[str, ...] = ()
    append_system_prompt: str = ""
    diagnostic_path: str = ""
    state_path: str = ""
    control_directory: str = ""
    control_token: str = ""
    control_module: str = ""
    question_timeout_seconds: float = 0
    project_root: str = ""
    attachment_root: str = ""
    features_module: str = ""
    sdk_options: dict[str, Any] = field(default_factory=dict)
    sdk_action: dict[str, Any] = field(default_factory=dict)
    mcp_options: dict[str, Any] = field(default_factory=dict)
    platform_snapshot: str = ""
    platform_tools_module: str = ""

    @classmethod
    def read(cls, path: Path) -> TaskSpec:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("Task specification must be a JSON object")
        allowed = set(cls.__dataclass_fields__)
        if set(data) - allowed:
            raise ValueError("Task specification contains unsupported fields")
        for name in allowed - {"images", "auto", "mcp_options", "sdk_options", "sdk_action", "question_timeout_seconds"}:
            if not isinstance(data.get(name, ""), str):
                raise ValueError(f"{name} must be a string")
        if not isinstance(data.get("auto", False), bool):
            raise ValueError("auto must be a boolean")
        for name in ('sdk_options','sdk_action'):
            if not isinstance(data.get(name,{}),dict): raise ValueError(f'{name} must be an object')
        action = data.get('sdk_action',{})
        if action and (set(action) != {'operation','source_session_id','user_message_id','request_id','source_task_id'} or action.get('operation') != 'rewind_files' or not all(isinstance(value,str) and value for value in action.values())):
            raise ValueError('Invalid SDK recovery action')
        mcp = data.get("mcp_options")
        if not isinstance(mcp, dict) or set(mcp) != {"mcp_servers", "allowed_tools", "disallowed_tools"}:
            raise ValueError("mcp_options must contain bridge servers and tool permissions")
        if not isinstance(mcp["mcp_servers"], dict):
            raise ValueError("mcp_servers must be an object")
        for name in ("allowed_tools", "disallowed_tools"):
            if not isinstance(mcp[name], list) or not all(isinstance(tool, str) for tool in mcp[name]):
                raise ValueError(f"{name} must be a list of tool names")
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", data.get("task_id", "")):
            raise ValueError("task_id must be a non-empty task identifier")
        if not Path(data.get("cwd", "")).is_absolute():
            raise ValueError("cwd must be an absolute path")
        images = data.get("images", [])
        if not isinstance(images, list) or not all(isinstance(image, str) for image in images):
            raise ValueError("images must be a list of paths")
        if not data.get("prompt", "") and not images:
            raise ValueError("A prompt or attachment is required")
        if data.get("fork_session_id") and not (data.get("session_id") and data.get("resume_session_at")):
            raise ValueError("Forking requires a source session and message checkpoint")
        for name in ("diagnostic_path", "state_path", "control_directory", "control_module", "features_module", "attachment_root", "project_root"):
            if data.get(name) and not Path(data[name]).is_absolute():
                raise ValueError(f"{name} must be an absolute path")
        if data.get("control_directory") and (
            not re.fullmatch(r"[0-9a-f]{64}", data.get("control_token", "")) or not data.get("control_module")
        ):
            raise ValueError("Control channel requires a capability and protocol module")
        timeout = data.get('question_timeout_seconds', 0)
        if (not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or not math.isfinite(timeout)
                or (data.get('control_directory') and timeout <= 0)):
            raise ValueError('Control channel requires a positive finite question timeout')
        return cls(**{**data, "images": tuple(images)})


def input_message_uuid(task_id: str, request_id: str = '') -> str:
    # A retried durable command keeps its identity; identical text in another
    # command or Task is a new input. No prompt or credential enters the UUID.
    identity = json.dumps([task_id, request_id], separators=(',', ':'))
    return str(uuid.uuid5(uuid.NAMESPACE_URL, 'coderfleet:input:' + identity))


async def prepare_input(spec: TaskSpec, text: str, images: list[str] | tuple[str, ...], *, strict_uploads: bool = True, request_id: str = '') -> AsyncIterator[dict[str, Any]]:
    content = await _input_content(spec, text, images, strict_uploads=strict_uploads)
    async def messages() -> AsyncIterator[dict[str, Any]]:
        yield {'type': 'user', 'uuid': input_message_uuid(spec.task_id, request_id),
               'message': {'role': 'user', 'content': content}, 'parent_tool_use_id': None}
    return messages()


async def _input_content(spec: TaskSpec, text: str, images: list[str] | tuple[str, ...], *, strict_uploads: bool) -> str | list[dict[str, Any]]:
    if not images:
        return text
    configured_root = Path(spec.attachment_root or Path(spec.cwd)/'.coderfleet-uploads')
    root = configured_root.resolve()
    if not root.is_relative_to(configured_root.parent.resolve()): raise ValueError('Upload directory resolves outside the project')
    if not strict_uploads:
        legacy = [reference for reference in images if Path(reference).parent != Path('/workspace/.coderfleet-uploads') and Path(reference).parent.resolve() != root]
        if legacy: text += '\n\n[Attached images:\n' + '\n'.join(legacy) + ']'
        images = [reference for reference in images if reference not in legacy]
        if not images: return text
    blocks: list[dict[str,Any]] = [{'type':'text','text':text}] if text else []
    for reference in images:
        source = Path(reference)
        # Uploads retain the container namespace in API/CLI, including local mode.
        if source.parent != Path('/workspace/.coderfleet-uploads') and source.parent.resolve() != root:
            raise ValueError('Native attachments must be project uploads')
        path = (root/source.name).resolve()
        if not path.is_relative_to(root) or not path.is_file(): raise ValueError('Attachment does not belong to this project')
        if path.stat().st_size > 20*1024*1024: raise ValueError('Native attachment exceeds 20 MiB')
        mime = mimetypes.guess_type(path.name)[0]
        if mime in {'image/png','image/jpeg','image/webp','image/gif','application/pdf'}:
            data = await asyncio.to_thread(path.read_bytes)
            blocks.append({'type':'document' if mime == 'application/pdf' else 'image',
                'source':{'type':'base64','media_type':mime,'data':base64.b64encode(data).decode('ascii')}})
        else:
            blocks.append({'type':'text','text':'[Attached file: ' + str(path) + ']'})
    return blocks


def emit(event: dict[str, Any]) -> None:
    line = json.dumps(event, ensure_ascii=False)
    print(line, flush=True)
    if (not event.get('coderfleet_synthetic') and not event.get('parent_tool_use_id') and
            (event.get('type') in {'assistant','user','result'} or event.get('subtype') in {
                'coderfleet_message_accepted','coderfleet_question_pending','coderfleet_human_answer','coderfleet_human_decision'})):
        # Keep the native event untouched; a separate clock lets historical
        # activity retain its true day after a worker/server restart.
        print(json.dumps({'type':'system','subtype':'coderfleet_event_clock',
                          'event_hash':hashlib.sha256(line.encode()).hexdigest(),
                          'at':datetime.now(timezone.utc).isoformat()}),flush=True)


@dataclass
class ErrorPresentation:
    visible_result: bool = False

    def show(self, message: str, task_id: str = "") -> None:
        if self.visible_result:
            return
        emit({
            "type": "result", "subtype": "error_during_execution", "is_error": True,
            "result": message, "coderfleet_synthetic": True, "coderfleet_task_id": task_id,
            "duration_ms": 0, "duration_api_ms": 0, "num_turns": 0,
        })
        self.visible_result = True


def write_state(spec: TaskSpec, status: str, cli_pid: int | None = None) -> None:
    if not spec.state_path:
        return
    state = {
        "task_id": spec.task_id, "pid": os.getpid(),
        "pgid": os.getpgrp() if os.name == "posix" else None,
        "cli_pid": cli_pid, "status": status, "ownership_token": OWNERSHIP_TOKEN,
    }
    path = Path(spec.state_path)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(state), encoding="utf-8")
    temporary.replace(path)


def doctor() -> dict[str, Any]:
    report: dict[str, Any] = {
        "ready": False, "execution_backend": "sdk", "sdk_version": "",
        "cli_version": "", "python_path": sys.executable, "error": "",
    }
    try:
        report["sdk_version"] = importlib.metadata.version("claude-agent-sdk")
        if report["sdk_version"] != SDK_VERSION:
            raise ValueError(f"claude-agent-sdk {SDK_VERSION} is required")
        sdk = importlib.import_module("claude_agent_sdk")
        explicit = os.environ.get("CODERFLEET_CLAUDE_CLI_PATH", "")
        sdk_file = getattr(sdk, "__file__", None)
        if not isinstance(sdk_file, str):
            raise ValueError("claude-agent-sdk installation has no package location")
        cli = Path(explicit) if explicit else Path(sdk_file).parent / "_bundled" / ("claude.exe" if os.name == "nt" else "claude")
        if not cli.is_file() or not os.access(cli, os.X_OK):
            raise ValueError("SDK bundled CLI is missing; reinstall the SDK wheel or set CODERFLEET_CLAUDE_CLI_PATH")
        version = subprocess.run([str(cli), "--version"], capture_output=True, text=True, timeout=10)
        match = re.search(r"\b(\d+\.\d+\.\d+)\b", version.stdout)
        if version.returncode or not match:
            raise ValueError("Selected Claude CLI could not report its version")
        report["cli_version"] = match[1]
        if report["cli_version"] != CLI_VERSION:
            raise ValueError(f"Claude CLI {CLI_VERSION} is required with SDK {SDK_VERSION}")
        report["cli_path"] = str(cli.resolve())
        report["ready"] = True
    except importlib.metadata.PackageNotFoundError:
        report["error"] = f"claude-agent-sdk {SDK_VERSION} is not installed in this Python environment"
    except ImportError as error:
        report["error"] = f"claude-agent-sdk dependency import failed: {error}"
    except Exception as error:
        report["error"] = str(error)
    return report


class CapturingTransport:
    """One pinned-SDK compatibility seam, preserving events before its parser."""

    def __init__(self, inner: Any, spec: TaskSpec, errors: ErrorPresentation) -> None:
        self.inner = inner
        self.spec = spec
        self.results = 0
        self.failed = False
        self.cancelled = False
        self.errors = errors
        self.on_event: Callable[[dict[str, Any]], None] | None = None

    def write_state(self, status: str) -> None:
        process = getattr(self.inner, "_process", None)
        write_state(self.spec, status, getattr(process, "pid", None))

    async def connect(self) -> None:
        await self.inner.connect()
        self.write_state("running")

    async def write(self, data: str) -> None:
        await self.inner.write(data)

    async def end_input(self) -> None:
        await self.inner.end_input()

    def is_ready(self) -> bool:
        return bool(self.inner.is_ready())

    async def close(self) -> None:
        await self.inner.close()

    async def read_messages(self) -> AsyncIterator[dict[str, Any]]:
        async for event in self.inner.read_messages():
            kind = event.get("type", "")
            if self.on_event: self.on_event(event)
            if (self.spec.sdk_options.get("enable_file_checkpointing") and kind == "user"
                    and isinstance(event.get("uuid"),str) and not event.get("parent_tool_use_id")):
                content = event.get("message",{}).get("content",[])
                if not isinstance(content,list) or not any(block.get("type") == "tool_result" for block in content if isinstance(block,dict)):
                    emit({"type":"system","subtype":"coderfleet_checkpoint","task_id":self.spec.task_id,"user_message_id":event["uuid"]})
            if event.get("sdk_host_only") is not True and kind not in {
                "control_request", "control_response", "control_cancel_request", "keep_alive", "transcript_mirror",
            }:
                emit(event)
            if kind == "result":
                self.results += 1
                self.failed |= bool(event.get("is_error")) or event.get("subtype") != "success"
                self.cancelled |= event.get("terminal_reason") in {"aborted_streaming", "aborted_tools"}
                if event.get("is_error") and isinstance(event.get("result"), str) and event["result"].strip():
                    self.errors.visible_result = True
            yield event


def owned_processes() -> set[int]:
    """Find descendants and members of this worker's private process group."""
    if os.name != "posix":
        return set()
    rows: list[tuple[int, int, int]] = []
    if Path("/proc/self/stat").is_file():
        # Minimal Linux images need no procps package. Parse after the final ')'
        # because a process name may contain whitespace and parentheses.
        for path in Path("/proc").glob("[0-9]*/stat"):
            try:
                values = path.read_text().rsplit(")", 1)[1].split()
                rows.append((int(path.parent.name), int(values[1]), int(values[2])))
            except (OSError, ValueError, IndexError):
                continue  # A process may disappear between directory and read.
    else:
        try:
            ps = "/bin/ps" if Path("/bin/ps").is_file() else "/usr/bin/ps"
            result = subprocess.run([ps, "-axo", "pid=,ppid=,pgid="], capture_output=True, text=True, timeout=2)
            for line in result.stdout.splitlines():
                columns = line.split()
                if len(columns) == 3:
                    rows.append((int(columns[0]), int(columns[1]), int(columns[2])))
        except (OSError, ValueError, subprocess.TimeoutExpired):
            return set()
    owner = os.getpid()
    selected = {owner}
    while True:
        expanded = selected | {pid for pid, parent, group in rows if parent in selected or group == owner}
        if expanded == selected:
            return selected - {owner}
        selected = expanded


def signal_processes(pids: set[int], signum: int) -> None:
    for pid in pids - {os.getpid()}:
        with suppress(ProcessLookupError, PermissionError):
            os.kill(pid, signum)


async def run_task(spec: TaskSpec, report: dict[str, Any], diagnostic: TextIO, errors: ErrorPresentation) -> int:
    # All private SDK imports are isolated here and protected by doctor()'s pin.
    from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient, PermissionResultAllow, PermissionResultDeny, PermissionUpdate, ResultError, CLIConnectionError, ProcessError
    from claude_agent_sdk._internal.transport import Transport
    from claude_agent_sdk._internal.transport.subprocess_cli import SubprocessCLITransport
    from claude_agent_sdk.types import _configure_can_use_tool

    def stderr(line: str) -> None:
        diagnostic.write(line + "\n")
        diagnostic.flush()

    questions: dict[str, asyncio.Future[Any]] = {}
    interaction_kinds: dict[str, str] = {}
    interaction_lock = asyncio.Lock()
    permission_mode = spec.sdk_options.get("permission_mode","bypassPermissions" if spec.auto else "acceptEdits")

    async def handle_tool_permission(tool: str, tool_input: dict[str, Any], context: Any) -> Any:
        nonlocal permission_mode
        if not spec.control_directory or permission_mode in {"bypassPermissions","dontAsk"}:
            return PermissionResultDeny(message="Interactive approval is unavailable for this Task")
        identifier = context.tool_use_id
        if not isinstance(identifier, str) or not identifier:
            return PermissionResultDeny(message='Tool approval requires a tool-use identity')
        # The Task has one operator card. Parallel permission callbacks wait their
        # turn instead of replacing an earlier still-pending question.
        async with interaction_lock:
            is_question = tool == 'AskUserQuestion'
            items = tool_input.get('questions')
            if is_question and (not isinstance(items, list) or not items):
                return PermissionResultDeny(message='Invalid native question')
            future = asyncio.get_running_loop().create_future()
            questions[identifier] = future
            interaction_kinds[identifier] = 'question' if is_question else 'permission'
            status = 'cancelled'
            prefix = 'coderfleet_question' if is_question else 'coderfleet_permission'
            event: dict[str, Any] = {'type':'system', 'subtype':prefix + '_pending', 'task_id':spec.task_id,
                     'tool_call_id':identifier,
                     'deadline':(datetime.now(timezone.utc) + timedelta(seconds=spec.question_timeout_seconds)).isoformat()}
            if is_question:
                event['questions'] = items
            else:
                event.update(tool_name=tool, tool_input=tool_input,
                             decision_reason=getattr(context, 'decision_reason', None) or '')
            emit(event)
            try:
                response = await asyncio.wait_for(future, timeout=spec.question_timeout_seconds)
                if is_question:
                    status = 'answered'
                    emit({'type':'system','subtype':'coderfleet_human_answer','task_id':spec.task_id,
                          'tool_call_id':identifier,'answers':response})
                    return PermissionResultAllow(updated_input={**tool_input, 'answers':response})
                emit({'type':'system','subtype':'coderfleet_human_decision','task_id':spec.task_id,
                      'tool_call_id':identifier,'tool_name':tool,'decision':response['decision'],
                      'message':response.get('message','')})
                if response['decision'] == 'deny':
                    status = 'denied'
                    return PermissionResultDeny(message=response.get('message') or 'Operator denied this tool')
                status = 'approved'
                updates = [PermissionUpdate(type='setMode', mode='acceptEdits', destination='session')] if tool == 'ExitPlanMode' else []
                if updates:
                    permission_mode = 'acceptEdits'
                    emit({'type':'system','subtype':'coderfleet_control_applied','task_id':spec.task_id,
                          'operation':'set_permission_mode','arguments':{'mode':'acceptEdits'}})
                return PermissionResultAllow(updated_input=response['updated_input'] if 'updated_input' in response else tool_input,
                                             updated_permissions=updates or None)
            except TimeoutError:
                status = 'timed_out'
                return PermissionResultDeny(message='User question timed out; no answer was provided' if is_question else 'Tool approval timed out')
            finally:
                questions.pop(identifier, None)
                interaction_kinds.pop(identifier, None)
                emit({'type':'system', 'subtype':prefix + '_closed', 'task_id':spec.task_id,
                      'tool_call_id':identifier, 'status':status})

    option_values = dict(
        cwd=spec.cwd, cli_path=report["cli_path"], model=spec.model or None,
        system_prompt={"type": "preset", "preset": "claude_code", "append": spec.append_system_prompt},
        setting_sources=["user", "project", "local"],
        permission_mode="bypassPermissions" if spec.auto else "acceptEdits",
        allowed_tools=spec.mcp_options["allowed_tools"],
        disallowed_tools=[name for name in spec.mcp_options['disallowed_tools']
                          if name != 'AskUserQuestion' or not spec.control_directory],
        mcp_servers=spec.mcp_options["mcp_servers"],
        resume=spec.sdk_action.get("source_session_id") or spec.session_id or None, fork_session=bool(spec.fork_session_id),
        session_id=spec.fork_session_id or None, resume_session_at=spec.resume_session_at or None,
        max_buffer_size=16 * 1024 * 1024, include_partial_messages=True, stderr=stderr,
        can_use_tool=handle_tool_permission,
    )
    platform_reader: Any = None
    if spec.platform_tools_module:
        if spec.control_directory or spec.session_id or spec.sdk_action or spec.auto:
            raise ValueError('Platform task requires a fresh read-only execution profile')
        module_spec = importlib.util.spec_from_file_location('_coderfleet_platform_tools',spec.platform_tools_module)
        if module_spec is None or module_spec.loader is None: raise ValueError('Platform tool module unavailable')
        module = importlib.util.module_from_spec(module_spec); module_spec.loader.exec_module(module)
        if spec.platform_snapshot:
            profile, platform_reader = module.options_for_snapshot(spec.platform_snapshot,spec.sdk_options)
        else:
            profile = module.options_for_retrieval(spec.sdk_options,spec.mcp_options["mcp_servers"])
        option_values.update(profile)
        async def platform_permission(tool: str, tool_input: dict[str,Any], context: Any) -> Any:
            if tool in module.ALLOWED_TOOLS or any(tool.startswith('mcp__'+name+'__') for name in spec.mcp_options['mcp_servers']): return PermissionResultAllow(updated_input=tool_input)
            return PermissionResultDeny(message='Tool is outside the platform read-only scope')
        option_values['can_use_tool'] = platform_permission
    elif spec.sdk_options:
        path = Path(spec.features_module) if spec.features_module else Path(__file__).with_name('coderfleet_sdk_features.py')
        feature_spec = importlib.util.spec_from_file_location('_coderfleet_sdk_features',path)
        if feature_spec is None or feature_spec.loader is None: raise ValueError('SDK feature module unavailable')
        features = importlib.util.module_from_spec(feature_spec)
        feature_spec.loader.exec_module(features)
        extra = await features.build_options(spec.sdk_options,spec.cwd,{'task_id':spec.task_id,'emit':emit,'project_root':spec.project_root or spec.cwd})
        for key in ('allowed_tools','disallowed_tools'):
            extra[key] = list(dict.fromkeys([*option_values[key],*extra.get(key,[])]))
        servers = extra.get('mcp_servers',{})
        if set(servers) & set(option_values['mcp_servers']): raise ValueError('Custom MCP server conflicts with CoderFleet bridge')
        extra['mcp_servers'] = {**option_values['mcp_servers'],**servers}
        if isinstance(extra.get('system_prompt'),dict) and extra['system_prompt'].get('type') == 'preset':
            extra['system_prompt']['append'] = extra['system_prompt'].get('append','') + '\n' + spec.append_system_prompt
        elif isinstance(extra.get('system_prompt'),dict) and extra['system_prompt'].get('type') == 'custom':
            extra['system_prompt']['prompt'] += '\n' + spec.append_system_prompt
        elif isinstance(extra.get('system_prompt'),dict) and extra['system_prompt'].get('type') == 'file':
            path = Path(spec.cwd)/extra['system_prompt']['path']
            if path.stat().st_size > 256*1024: raise ValueError('System prompt file exceeds 256 KiB')
            extra['system_prompt'] = path.read_text(encoding='utf-8') + '\n' + spec.append_system_prompt
        elif isinstance(extra.get('system_prompt'),str):
            extra['system_prompt'] += '\n' + spec.append_system_prompt
        option_values.update(extra)
    if option_values.get('enable_file_checkpointing'):
        option_values['extra_args'] = {'replay-user-messages':None}
    options = ClaudeAgentOptions(**option_values)

    prompt = "" if spec.sdk_action else spec.prompt

    class SDKTransportAdapter(CapturingTransport,Transport):
        """Nominal SDK interface; base wrapper remains importable without SDK."""

    transport = SDKTransportAdapter(SubprocessCLITransport(prompt=prompt, options=_configure_can_use_tool(options)), spec, errors)
    if platform_reader is not None:
        transport.on_event = platform_reader.observe
        def platform_progress(value: dict[str, Any]) -> None:
            event = {'type':'system','subtype':'coderfleet_platform_progress','task_id':spec.task_id,
                     'updated_at':datetime.now(timezone.utc).isoformat(),**value}
            if spec.state_path:
                path=Path(spec.state_path).with_name(spec.task_id+'.platform-progress.json')
                temporary=path.with_suffix('.tmp')
                try:
                    temporary.write_text(json.dumps(event),encoding='utf-8');temporary.replace(path)
                except OSError:
                    pass  # Progress persistence must not fail an otherwise valid read.
            emit(event)
        platform_reader.on_progress = platform_progress
    elif spec.platform_tools_module:
        transport.on_event = module.RetrievalObserver(spec.state_path,spec.task_id).observe
    client = ClaudeSDKClient(options=options, transport=transport)
    mailbox: Any = None
    if spec.control_directory:
        module_spec = importlib.util.spec_from_file_location("_coderfleet_sdk_control", spec.control_module)
        if module_spec is None or module_spec.loader is None:
            raise ValueError("SDK control protocol module is unavailable")
        protocol = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(protocol)
        mailbox = protocol.ControlMailbox(Path(spec.control_directory), spec.task_id, spec.control_token)
        mailbox.publish("starting")
    loop = asyncio.get_running_loop()
    task = asyncio.current_task()
    received_signal = 0
    succeeded = False
    known_children: set[int] = set()
    escalation: asyncio.TimerHandle | None = None
    consumer: asyncio.Task[None] | None = None
    controller: asyncio.Task[None] | None = None
    accepting = False
    interrupted = False
    command_lock = asyncio.Lock()

    async def consume() -> None:
        async for _message in client.receive_messages():
            pass

    async def control() -> None:
        nonlocal accepting, interrupted, permission_mode
        while True:
            for command in mailbox.pending():
                async with command_lock:
                    mailbox.claim(command['id'])
                    if not accepting:
                        mailbox.acknowledge(command['id'], error='Task is no longer accepting commands')
                    elif command['kind'] == 'ping':
                        mailbox.acknowledge(command['id'], {'connected': True})
                    elif command['kind'] == 'message':
                        text = command.get('payload', {}).get('text','')
                        images = command.get('payload', {}).get('images',[])
                        if not isinstance(text,str) or not isinstance(images,list) or not all(isinstance(path,str) for path in images) or (not text.strip() and not images):
                            mailbox.acknowledge(command['id'], error='A non-empty text message is required')
                        else:
                            # ClaudeSDKClient.query() in the pinned release does
                            # not reopen the lifecycle gate as stream_input does.
                            # Inputs can merge into the current turn, so counting
                            # one Result per message would leave a finished run open.
                            engine = client._query
                            if engine is None:
                                raise RuntimeError('SDK client disconnected')
                            try:
                                prepared = await prepare_input(spec,text,images,request_id=command['id'])
                            except (OSError,ValueError) as error:
                                mailbox.acknowledge(command['id'],error=str(error))
                                continue
                            engine._reopen_run()
                            engine._result_received = False
                            engine._clear_run_end_ceiling()
                            await client.query(prepared)
                            emit({'type':'system', 'subtype':'coderfleet_message_accepted', 'task_id':spec.task_id,
                                  'request_id':command['id'], 'user_message_uuid':input_message_uuid(spec.task_id,command['id']),
                                  'text':text,'attachment_count':len(images)})
                            mailbox.acknowledge(command['id'], {'queued_in_sdk': True,
                                'user_message_uuid':input_message_uuid(spec.task_id,command['id'])})
                    elif command['kind'] == 'interrupt':
                        await client.interrupt()
                        interrupted = True
                        accepting = False
                        for future in list(questions.values()):
                            future.cancel()
                        emit({'type':'system', 'subtype':'coderfleet_interrupted', 'task_id':spec.task_id})
                        mailbox.acknowledge(command['id'], {'interrupted': True})
                        mailbox.close()
                    elif command['kind'] == 'control':
                        payload = command.get('payload', {})
                        operation = payload.get('operation')
                        try:
                            arguments = protocol.validate_control(operation, payload.get('arguments', {}))
                        except (ValueError, RuntimeError) as error:
                            mailbox.acknowledge(command['id'], error=str(error))
                            continue
                        methods = {name:getattr(client,name) for name in protocol.CONTROL_OPERATIONS}
                        previous_mode = permission_mode
                        if operation == 'set_permission_mode': permission_mode = arguments['mode']
                        try:
                            value = await asyncio.wait_for(methods[operation](**arguments), timeout=4)
                        except (TimeoutError, CLIConnectionError, ProcessError):
                            # A request may already have affected the SDK. A claimed
                            # command without a receipt stays unknown, never replayed.
                            emit({'type':'system','subtype':'coderfleet_control_unconfirmed','task_id':spec.task_id,
                                  'request_id':command['id'],'operation':operation})
                        except Exception as error:
                            if operation == 'set_permission_mode': permission_mode = previous_mode
                            mailbox.acknowledge(command['id'], error=str(error)[:1000])
                        else:
                            if operation == 'set_permission_mode': permission_mode = arguments['mode']
                            emit({'type':'system','subtype':'coderfleet_control_applied','task_id':spec.task_id,
                                  'operation':operation,'arguments':arguments})
                            mailbox.acknowledge(command['id'], {'operation':operation,'value':value})
                    elif command['kind'] == 'approval':
                        payload = command.get('payload', {})
                        identifier = payload.get('tool_call_id')
                        waiting = questions.get(identifier)
                        if waiting is None or waiting.done() or interaction_kinds.get(identifier) != 'permission':
                            mailbox.acknowledge(command['id'], error='Tool is no longer waiting for approval')
                        elif payload.get('decision') not in {'allow', 'deny'} or ('updated_input' in payload and not isinstance(payload['updated_input'], dict)):
                            mailbox.acknowledge(command['id'], error='Invalid approval decision')
                        else:
                            waiting.set_result(payload)
                            mailbox.acknowledge(command['id'], {'approved':payload['decision'] == 'allow'})
                    elif command['kind'] == 'answer':
                        payload = command.get('payload', {})
                        waiting = questions.get(payload.get('tool_call_id'))
                        answers = payload.get('answers')
                        if waiting is None or waiting.done() or interaction_kinds.get(payload.get('tool_call_id')) != 'question':
                            mailbox.acknowledge(command['id'], error='Question is no longer waiting for an answer')
                        elif not isinstance(answers, dict) or not answers or not all(
                            isinstance(key, str) and (isinstance(value, str) or (
                                isinstance(value, list) and all(isinstance(item, str) for item in value)))
                            for key, value in answers.items()
                        ):
                            mailbox.acknowledge(command['id'], error='Answers must contain text or text selections')
                        else:
                            waiting.set_result({key: ', '.join(value) if isinstance(value, list) else value
                                               for key, value in answers.items()})
                            mailbox.acknowledge(command['id'], {'answered': True})
                    else:
                        mailbox.acknowledge(command['id'], error='Unsupported worker command')
            await asyncio.sleep(0.03)

    def force_stop() -> None:
        signal_processes(known_children | owned_processes(), signal.SIGKILL)

    def stop(signum: int) -> None:
        nonlocal received_signal, escalation
        if received_signal:
            return
        received_signal = signum
        known_children.update(owned_processes())
        process = getattr(transport.inner, "_process", None)
        if process is not None:
            known_children.add(process.pid)
        signal_processes(known_children, signal.SIGTERM)
        escalation = loop.call_later(1, force_stop)
        if task is not None:
            task.cancel()

    for signum in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(signum, stop, signum)
    try:
        await client.connect()
        await client.query(await prepare_input(spec,prompt,() if spec.sdk_action else spec.images,strict_uploads=False))
        if spec.sdk_action:
            if set(spec.sdk_action) != {'operation','source_session_id','user_message_id','request_id','source_task_id'} or spec.sdk_action['operation'] != 'rewind_files':
                raise ValueError('Unsupported SDK Task action')
            async def rewind() -> None:
                async for _message in client.receive_messages():
                    await client.rewind_files(spec.sdk_action['user_message_id'])
                    break
                else: raise RuntimeError('SDK closed before file recovery')
            await asyncio.wait_for(rewind(),timeout=30)
            emit({'type':'system','subtype':'coderfleet_files_rewound','task_id':spec.task_id,
                  'user_message_id':spec.sdk_action['user_message_id']})
            emit({'type':'result','subtype':'success','is_error':False,'session_id':spec.sdk_action['source_session_id'],
                  'result':'已恢复检查点跟踪的文件；对话历史保持不变。','duration_ms':0,'duration_api_ms':0,'num_turns':0})
            succeeded = True
            return 0
        consumer = asyncio.create_task(consume())
        if mailbox:
            accepting = True
            mailbox.publish("accepting")
            emit({'type': 'system', 'subtype': 'coderfleet_control_ready', 'task_id': spec.task_id,
                  'capabilities':['approval','control','partial_messages','multimodal_input'],
                  'permission_mode':options.permission_mode})
            controller = asyncio.create_task(control())
        # The pinned SDK owns full-run completion, including background agents.
        # receive_response() stops at one ResultMessage and is too early here.
        while not consumer.done():
            engine = client._query
            if transport.results and engine is not None and engine._run_ended_event.is_set() and not questions:
                async with command_lock:
                    if questions or not engine._run_ended_event.is_set():
                        continue
                    accepting = False
                    if mailbox:
                        mailbox.close()
                await engine.wait_for_result_and_end_input()
                break
            if controller is not None and controller.done():
                await controller  # A broken control channel must fail visibly.
            await asyncio.sleep(0.02)
        await consumer
        if interrupted or transport.cancelled:
            return 143
        if transport.failed or not transport.results:
            errors.show("Claude SDK run failed or ended without a terminal result; see the task diagnostic log.", spec.task_id)
            return 1
        succeeded = True
        return 0
    except ResultError:
        # The native CLI can exit 1 with an aborted result when interrupt lands
        # during a tool call. Preserve that raw result but report cancellation.
        if interrupted and transport.cancelled:
            return 143
        raise
    except asyncio.CancelledError:
        if not received_signal:
            raise
        return 128 + received_signal
    finally:
        try:
            accepting = False
            if controller is not None:
                controller.cancel()
                with suppress(asyncio.CancelledError):
                    await controller
            if mailbox:
                mailbox.close()
            await asyncio.wait_for(client.disconnect(), timeout=25 if spec.sdk_action else 3)
            if consumer is not None and not consumer.done():
                consumer.cancel()
                with suppress(asyncio.CancelledError):
                    await consumer
            await asyncio.wait_for(transport.close(), timeout=25 if spec.sdk_action else 3)
        finally:
            if platform_reader is not None:
                emit({'type':'system','subtype':'coderfleet_platform_coverage','task_id':spec.task_id,
                      **platform_reader.coverage(),'source_ids':sorted(platform_reader.read_ids)})
            if received_signal:
                signal_processes(known_children | owned_processes(), signal.SIGKILL)
            else:
                signal_processes(owned_processes(), signal.SIGTERM)
            if escalation is not None:
                escalation.cancel()
            transport.write_state("cancelled" if received_signal or transport.cancelled or interrupted else "done" if succeeded else "failed")
            for signum in (signal.SIGTERM, signal.SIGINT):
                loop.remove_signal_handler(signum)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--doctor", action="store_true")
    parser.add_argument("--spec", type=Path)
    parser.add_argument("--task-marker", default="", help=argparse.SUPPRESS)
    args = parser.parse_args()
    errors = ErrorPresentation()
    if args.doctor:
        report = doctor()
        print(json.dumps(report, ensure_ascii=False), flush=True)
        return 0 if report["ready"] else 1
    if args.spec:
        try:
            spec = TaskSpec.read(args.spec)
        except (OSError, ValueError) as error:
            errors.show(str(error))
            return 2
        if os.name == "posix":
            if os.getpgrp() != os.getpid():
                os.setsid()

            def preflight_stop(signum: int, _frame: Any) -> None:
                signal_processes(owned_processes(), signal.SIGTERM)
                with suppress(OSError):
                    write_state(spec, "cancelled")
                raise SystemExit(128 + signum)

            signal.signal(signal.SIGTERM, preflight_stop)
            signal.signal(signal.SIGINT, preflight_stop)
        os.environ["CODERFLEET_TASK_ID"] = spec.task_id
        os.environ["CODERFLEET_SDK_OWNER_TOKEN"] = OWNERSHIP_TOKEN
        try:
            write_state(spec, "starting")
        except OSError:
            errors.show("Could not persist SDK task process identity.", spec.task_id)
            return 1
        report = doctor()
        if not report["ready"]:
            write_state(spec, "failed")
            errors.show(report["error"], spec.task_id)
            return 1
        emit({"type": "system", "subtype": "coderfleet_backend", "task_id": spec.task_id, **{key: report[key] for key in ("execution_backend", "sdk_version", "cli_version")}})
        diagnostic_path = Path(spec.diagnostic_path) if spec.diagnostic_path else args.spec.resolve().with_suffix(".stderr.log")
        try:
            with diagnostic_path.open("a", encoding="utf-8") as diagnostic:
                with redirect_stderr(diagnostic):
                    return asyncio.run(run_task(spec, report, diagnostic, errors))
        except Exception as error:
            with suppress(OSError):
                write_state(spec, "failed")
            with suppress(OSError):
                with diagnostic_path.open("a", encoding="utf-8") as diagnostic:
                    diagnostic.write(f"{type(error).__name__}: {error}\n")
            errors.show(f"SDK worker failed ({type(error).__name__}); see the task diagnostic log.", spec.task_id)
            return 1
    parser.error("--doctor or --spec is required")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
