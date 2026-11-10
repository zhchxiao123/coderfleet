"""Verified SDK worker control through the existing account runtime boundary."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
import re
import sys
from typing import Literal

from coderfleet.server.runtime import ContainerRuntime


def _container_has_stopped(message: str, container: str) -> bool:
    prefix = r"(?:docker:\s*)?(?:Error response from daemon:\s*)?"
    missing = prefix + r"No such container:\s*" + re.escape(container)
    stopped = prefix + r"Container\s+(?:" + re.escape(container) + r"|[a-f0-9]{12,64})\s+is not running\.?"
    return bool(re.fullmatch(missing, message.strip(), re.I) or re.fullmatch(stopped, message.strip(), re.I))


_CONTROLLER = r'''
import fcntl, json, os, re, signal, subprocess, sys
from pathlib import Path

state_path, task_id, action, known_pid = sys.argv[1:]
known_pid = int(known_pid)
own_pid = os.getpid()
own_group = os.getpgrp()
request_path = str(Path(state_path).parent / (task_id + '.sdk.json'))
script_name = r'(?:sdk-worker-[0-9a-fA-F]{8,64}|coderfleet_claude_sdk_worker)\.py'
python_name = re.compile(r'^python(?:[0-9]+(?:\.[0-9]+)*)?$', re.I)


def snapshot():
    rows = {}
    if Path('/proc/self/stat').is_file():
        for entry in Path('/proc').glob('[0-9]*/stat'):
            pid = int(entry.parent.name)
            try:
                stat = entry.read_text().rsplit(')', 1)[1].split()
                argv = (entry.parent / 'cmdline').read_bytes().split(b'\0')
                argv = [value.decode('utf-8', 'surrogateescape') for value in argv if value]
                rows[pid] = {'pid': pid, 'ppid': int(stat[1]), 'pgid': int(stat[2]),
                             'stat': stat[0], 'argv': argv, 'args': '', 'birth': stat[19]}
            except (FileNotFoundError, ProcessLookupError):
                continue
            except PermissionError:
                continue
    else:
        executable = '/bin/ps' if Path('/bin/ps').is_file() else '/usr/bin/ps'
        result = subprocess.run([executable, '-axww', '-o', 'pid=,ppid=,pgid=,stat=,lstart=,args='],
                                capture_output=True, text=True, timeout=1)
        if result.returncode:
            raise RuntimeError('Could not observe SDK worker processes')
        for line in result.stdout.splitlines():
            parts = line.strip().split(None, 9)
            if len(parts) != 10:
                raise RuntimeError('Invalid process observation')
            pid, ppid, pgid = map(int, parts[:3])
            rows[pid] = {'pid': pid, 'ppid': ppid, 'pgid': pgid, 'stat': parts[3],
                         'argv': None, 'args': parts[9], 'birth': ' '.join(parts[4:9])}
    if own_pid not in rows:
        raise RuntimeError('Process observation did not include its controller')
    return rows


def is_worker(row):
    if row['pid'] == own_pid or 'Z' in row['stat'] or 'X' in row['stat']:
        return False
    argv = row['argv']
    if argv is not None:
        if not argv or not python_name.fullmatch(Path(argv[0]).name):
            return False
        index = 1
        while index < len(argv) and argv[index] in ('-I', '-u', '-B', '-E', '-s'):
            index += 1
        if index >= len(argv) or not re.fullmatch(script_name, Path(argv[index]).name):
            return False
        arguments = argv[index + 1:]
        try:
            spec_index = arguments.index('--spec')
            actual_request = arguments[spec_index + 1]
        except (ValueError, IndexError):
            return False
        return actual_request == request_path
    # BSD ps does not quote argv containing spaces. Match the expected script
    # directory and exact request path, while excluding python -c/-m wrappers.
    args = row['args']
    script = re.search(re.escape(str(Path(state_path).parent)) + '/' + script_name + r'(?=\s|$)', args)
    if script is None:
        return False
    prefix = args[:script.start()].strip()
    if re.search(r'(?:^|\s)-(?:c|m)(?=\s|$)', prefix):
        return False
    if not re.fullmatch(r'(?:/(?:[^/\n]+/)*)?python(?:[0-9]+(?:\.[0-9]+)*)?(?:\s+-(?:I|u|B|E|s))*', prefix, re.I):
        return False
    suffix = args[script.end():]
    return re.search(r'(?:^|\s)--spec\s+' + re.escape(request_path) + r'(?=\s|$)', suffix) is not None


def workers(rows, state):
    # A matching state PID is only a hint: actual argv is always authoritative.
    hinted = []
    if state.get('task_id') == task_id and isinstance(state.get('pid'), int):
        hinted.append(state['pid'])
    if known_pid > 1:
        hinted.append(known_pid)
    candidates = {pid for pid in hinted if pid in rows and is_worker(rows[pid])}
    candidates.update(pid for pid, row in rows.items() if is_worker(row))
    return candidates


def private_groups(rows, owners, state):
    groups = {pid for pid in owners if rows[pid]['pgid'] == pid and pid != own_group}
    group = state.get('pgid')
    # A saved group alone proves nothing. A live member with independently
    # verified Task ownership anchors the old private group after its leader dies.
    if (isinstance(group, int) and group > 1 and group == state.get('pid')
            and group != own_group and any(rows[pid]['pgid'] == group for pid in owners)):
        groups.add(group)
    return groups


def descendant_ids(rows, owners, state):
    selected = set(owners)
    groups = private_groups(rows, owners, state)
    while True:
        expanded = selected | {pid for pid, row in rows.items()
                               if row['ppid'] in selected or row['pgid'] in groups}
        if expanded == selected:
            return selected - {own_pid}
        selected = expanded


def residual_processes(rows, state):
    token = state.get('ownership_token', '')
    if state.get('task_id') != task_id or not isinstance(token, str) or not re.fullmatch(r'[0-9a-f]{32}', token):
        return set()
    live = {pid: row for pid, row in rows.items()
            if pid != own_pid and 'Z' not in row['stat'] and 'X' not in row['stat']}
    matched = set()
    if Path('/proc/self/stat').is_file():
        expected = {('CODERFLEET_TASK_ID=' + task_id).encode(),
                    ('CODERFLEET_SDK_OWNER_TOKEN=' + token).encode()}
        for pid in live:
            try:
                environment = set(Path('/proc', str(pid), 'environ').read_bytes().split(b'\0'))
            except (FileNotFoundError, ProcessLookupError, PermissionError):
                continue
            if expected <= environment:
                matched.add(pid)
    else:
        # ps -E output stays inside this controller and is reduced to booleans.
        # Never send commands/environments back to the service or diagnostics.
        executable = '/bin/ps' if Path('/bin/ps').is_file() else '/usr/bin/ps'
        result = subprocess.run([executable, '-Eww', '-p', ','.join(map(str, rows)), '-o', 'pid=,command='],
                                capture_output=True, text=True, timeout=1)
        if result.returncode:
            raise RuntimeError('Could not verify SDK descendant ownership')
        patterns = [re.compile(r'(?:^|\s)' + re.escape(key + '=' + value) + r'(?=\s|$)')
                    for key, value in [('CODERFLEET_TASK_ID', task_id), ('CODERFLEET_SDK_OWNER_TOKEN', token)]]
        for line in result.stdout.splitlines():
            parts = line.strip().split(None, 1)
            if len(parts) != 2 or not parts[0].isdigit():
                continue
            pid = int(parts[0])
            row = live.get(pid)
            if row is None or not parts[1].startswith(row['args']):
                continue
            environment = parts[1][len(row['args']):]
            if all(pattern.search(environment) for pattern in patterns):
                matched.add(pid)
    # Once a managed descendant was proven by its actual environment/ancestry,
    # retain its OS birth identity across parent death or an env-clearing exec.
    for proof in ownership_proofs(state):
        if not isinstance(proof, dict):
            continue
        pid = proof.get('pid')
        row = live.get(pid) if isinstance(pid, int) else None
        if row is not None and row['birth'] == proof.get('birth'):
            matched.add(pid)
    return matched


def ownership_proofs(state):
    path = Path(state_path + '.owned.json')
    try:
        record = json.loads(path.read_text())
    except FileNotFoundError:
        return []
    if not isinstance(record, dict):
        raise RuntimeError('Invalid SDK descendant ownership record')
    if record.get('task_id') != task_id or record.get('ownership_token') != state.get('ownership_token'):
        return []
    proofs = record.get('owned_processes', [])
    if not isinstance(proofs, list):
        raise RuntimeError('Invalid SDK descendant ownership proofs')
    return proofs


def remember_processes(rows, selected, state):
    if not re.fullmatch(r'[0-9a-f]{32}', str(state.get('ownership_token', ''))):
        return snapshot()
    # The worker is the sole writer of its status file. Controller proofs use a
    # separate store so a probe cannot roll back starting/running/final status.
    path = Path(state_path + '.owned.json')
    with open(state_path + '.owned.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        current = json.loads(Path(state_path).read_text())
        if current.get('task_id') != task_id or current.get('ownership_token') != state['ownership_token']:
            raise RuntimeError('SDK ownership changed during process observation')
        fresh_rows = snapshot()
        proofs = {proof['pid']: proof for proof in ownership_proofs(state)
                  if isinstance(proof, dict) and isinstance(proof.get('pid'), int)}
        proofs.update({pid: {'pid': pid, 'birth': rows[pid]['birth']} for pid in selected
                       if pid in fresh_rows and fresh_rows[pid]['birth'] == rows[pid]['birth']})
        proofs = {pid: proof for pid, proof in proofs.items()
                  if pid in fresh_rows and fresh_rows[pid]['birth'] == proof.get('birth')}
        record = {'task_id': task_id, 'ownership_token': state['ownership_token'],
                  'owned_processes': list(proofs.values())}
        temporary = path.with_name(path.name + '.control-' + str(own_pid) + '.tmp')
        try:
            temporary.write_text(json.dumps(record))
            temporary.chmod(0o600)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
        return fresh_rows


def managed_processes(rows, state):
    return workers(rows, state) | residual_processes(rows, state)


try:
    try:
        state = json.loads(Path(state_path).read_text())
        if not isinstance(state, dict):
            raise RuntimeError('SDK worker state is not an object')
    except FileNotFoundError:
        state = {}
    rows = snapshot()
    worker_targets = workers(rows, state)
    targets = worker_targets | residual_processes(rows, state)
    selected = descendant_ids(rows, targets, state)
    fresh_rows = remember_processes(rows, selected, state)
    # Observing environments or waiting for the proof-store lock can outlive a
    # process. A reused PID must not inherit an earlier snapshot's authority.
    selected = {pid for pid in selected if pid in fresh_rows
                and fresh_rows[pid]['birth'] == rows[pid]['birth']
                and 'Z' not in fresh_rows[pid]['stat'] and 'X' not in fresh_rows[pid]['stat']}
    worker_targets.intersection_update(selected)
    if action == 'term':
        # A live worker owns graceful cleanup. Orphans have no such supervisor.
        for pid in worker_targets if worker_targets else selected:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    elif action == 'kill':
        for pid in selected:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    if action == 'probe_worker':
        alive = bool(worker_targets)
    else:
        alive = bool(managed_processes(snapshot(), state)) if action != 'probe' else bool(selected)
    print(json.dumps({'alive': alive}), flush=True)
except Exception as error:
    print(json.dumps({'error': str(error)}), flush=True)
    sys.exit(1)
'''


async def control_sdk_process(
    runtime: ContainerRuntime, *, container: str, state_path: str, task_id: str,
    action: Literal["probe", "probe_worker", "term", "kill"] = "probe", local: bool = False,
    known_pid: int = 0,
) -> bool:
    """Observe/signal verified workers and their owned managed processes.

    The boolean is the *observed* liveness after the requested action. A failed
    observation raises rather than incorrectly proving that a worker is dead.
    ``probe_worker`` distinguishes supervisor health from surviving descendants;
    the other actions include verified descendants after their worker has died.
    """
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", task_id):
        raise ValueError("Invalid SDK Task identifier")
    if action not in {"probe", "probe_worker", "term", "kill"}:
        raise ValueError("Invalid SDK control action")
    if not Path(state_path).is_absolute():
        raise ValueError("SDK worker state path must be absolute")
    if not local and not container:
        raise ValueError("A container is required for container SDK control")

    async def communicate() -> bool:
        process = await runtime.exec(
            "" if local else container,
            [sys.executable if local else "python3", "-I", "-c", _CONTROLLER,
             state_path, task_id, action, str(known_pid if local else 0)],
        )
        output, stderr = await process.communicate()
        if process.returncode != 0 and not local:
            message = (output + (stderr or b"")).decode("utf-8", errors="replace")
            if _container_has_stopped(message, container):
                return False
        try:
            response = json.loads(output.decode("utf-8"))
        except (UnicodeError, ValueError) as exc:
            raise RuntimeError("SDK process control returned an invalid observation") from exc
        if process.returncode != 0:
            detail = response.get("error", "controller failed") if isinstance(response, dict) else "controller failed"
            raise RuntimeError(f"SDK process control failed: {str(detail)[:400]}")
        if not isinstance(response, dict) or not isinstance(response.get("alive"), bool):
            raise RuntimeError("SDK process control did not report boolean liveness")
        return bool(response["alive"])

    try:
        return await asyncio.wait_for(communicate(), timeout=3)
    except asyncio.TimeoutError as exc:
        raise RuntimeError("SDK process control timed out; worker liveness is unknown") from exc
    except (OSError, ValueError) as exc:
        raise RuntimeError("SDK process control could not observe the execution boundary") from exc
