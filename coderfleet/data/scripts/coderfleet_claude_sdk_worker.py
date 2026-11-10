#!/usr/bin/env python3
"""Standalone Claude SDK worker; copied into the account's execution boundary.

The main CoderFleet service never imports the SDK or its MCP dependencies.
Only this process imports the pinned SDK, and stdout is reserved for JSON.
"""

from __future__ import annotations

import argparse
import asyncio
from collections.abc import AsyncIterator
from contextlib import redirect_stderr, suppress
from dataclasses import dataclass, field
import importlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import secrets
import signal
import subprocess
import sys
from typing import Any, TextIO

SDK_VERSION = "0.2.180"
CLI_VERSION = "2.1.321"
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
    mcp_options: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def read(cls, path: Path) -> TaskSpec:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("Task specification must be a JSON object")
        allowed = set(cls.__dataclass_fields__)
        if set(data) - allowed:
            raise ValueError("Task specification contains unsupported fields")
        for name in allowed - {"images", "auto", "mcp_options"}:
            if not isinstance(data.get(name, ""), str):
                raise ValueError(f"{name} must be a string")
        if not isinstance(data.get("auto", False), bool):
            raise ValueError("auto must be a boolean")
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
        for name in ("diagnostic_path", "state_path"):
            if data.get(name) and not Path(data[name]).is_absolute():
                raise ValueError(f"{name} must be an absolute path")
        return cls(**{**data, "images": tuple(images)})


def emit(event: dict[str, Any]) -> None:
    print(json.dumps(event, ensure_ascii=False), flush=True)


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
            if event.get("sdk_host_only") is not True and kind not in {
                "control_request", "control_response", "control_cancel_request", "keep_alive",
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
    from claude_agent_sdk import ClaudeAgentOptions, PermissionResultDeny, query
    from claude_agent_sdk._internal.transport.subprocess_cli import SubprocessCLITransport
    from claude_agent_sdk.types import _configure_can_use_tool

    def stderr(line: str) -> None:
        diagnostic.write(line + "\n")
        diagnostic.flush()

    async def reject_unapproved(_tool: str, _input: dict[str, Any], _context: Any) -> Any:
        # Existing settings/allowlists run before this fallback. Background Tasks
        # have no native approval UI; explicit denial preserves that restriction
        # (including native AskUserQuestion) while giving the SDK a real control
        # callback, so it keeps stdin alive for background agents and later turns.
        return PermissionResultDeny(message="Interactive tool approval is unavailable for this Task; use configured permissions or pre-approved tools.")

    options = ClaudeAgentOptions(
        cwd=spec.cwd, cli_path=report["cli_path"], model=spec.model or None,
        system_prompt={"type": "preset", "preset": "claude_code", "append": spec.append_system_prompt},
        setting_sources=["user", "project", "local"],
        permission_mode="bypassPermissions" if spec.auto else "acceptEdits",
        allowed_tools=spec.mcp_options["allowed_tools"],
        disallowed_tools=spec.mcp_options["disallowed_tools"], mcp_servers=spec.mcp_options["mcp_servers"],
        resume=spec.session_id or None, fork_session=bool(spec.fork_session_id),
        session_id=spec.fork_session_id or None, resume_session_at=spec.resume_session_at or None,
        max_buffer_size=16 * 1024 * 1024, include_partial_messages=False, stderr=stderr,
        can_use_tool=reject_unapproved,
    )
    prompt = spec.prompt
    if spec.images:
        prompt += "\n\n[Attached images:\n" + "\n".join(spec.images) + "]"
    transport = CapturingTransport(SubprocessCLITransport(prompt=prompt, options=_configure_can_use_tool(options)), spec, errors)
    loop = asyncio.get_running_loop()
    task = asyncio.current_task()
    received_signal = 0
    succeeded = False
    known_children: set[int] = set()
    escalation: asyncio.TimerHandle | None = None

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
    responses = query(prompt=prompt, options=options, transport=transport)
    try:
        async for _message in responses:
            pass
        if transport.cancelled:
            return 143
        if transport.failed or not transport.results:
            errors.show("Claude SDK run failed or ended without a terminal result; see the task diagnostic log.", spec.task_id)
            return 1
        succeeded = True
        return 0
    except asyncio.CancelledError:
        if not received_signal:
            raise
        return 128 + received_signal
    finally:
        try:
            await asyncio.wait_for(responses.aclose(), timeout=3)
            await asyncio.wait_for(transport.close(), timeout=3)
        finally:
            if received_signal:
                signal_processes(known_children | owned_processes(), signal.SIGKILL)
            else:
                signal_processes(owned_processes(), signal.SIGTERM)
            if escalation is not None:
                escalation.cancel()
            transport.write_state("cancelled" if received_signal or transport.cancelled else "done" if succeeded else "failed")
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
