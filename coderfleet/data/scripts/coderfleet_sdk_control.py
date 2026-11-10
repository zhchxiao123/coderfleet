"""Stdlib-only control mailbox shared by the host and standalone SDK worker."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import time
import uuid
from typing import Any, Literal

MAX_PAYLOAD_BYTES = 64 * 1024
MAX_COMMANDS = 256
CommandKind = Literal['ping', 'answer', 'interrupt', 'message']


class ControlError(RuntimeError):
    """A control request is invalid, unavailable, or no longer deliverable."""


class ControlMailbox:
    """Atomic requests and durable replies across a Docker bind mount.

    Only the worker publishes channel state and replies. The host publishes
    immutable commands, so retries cannot overwrite or replay a delivered input.
    """

    def __init__(self, directory: Path, task_id: str, token: str) -> None:
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', task_id):
            raise ControlError('Invalid Task identity')
        if not re.fullmatch(r'[0-9a-f]{64}', token):
            raise ControlError('Invalid control capability')
        self.directory = directory
        self.task_id = task_id
        self.token = token
        self.generation = hashlib.sha256(token.encode()).hexdigest()
        self.requests = directory / 'requests'
        self.replies = directory / 'replies'
        self.started = directory / 'started'

    @staticmethod
    def _read(path: Path) -> dict[str, Any]:
        try:
            value = json.loads(path.read_text(encoding='utf-8'))
        except FileNotFoundError:
            return {}
        except (OSError, ValueError) as error:
            raise ControlError('Cannot read control record') from error
        if not isinstance(value, dict):
            raise ControlError('Invalid control record')
        return value

    @staticmethod
    def _write(path: Path, value: dict[str, Any], *, exclusive: bool = False) -> None:
        temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
        try:
            temporary.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
            temporary.chmod(0o644)
            if exclusive:
                os.link(temporary, path)
            else:
                temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)

    def publish(self, status: Literal['starting', 'accepting', 'closing', 'closed']) -> None:
        for path in (self.directory, self.requests, self.replies, self.started):
            path.mkdir(parents=True, exist_ok=True)
            path.chmod(0o777)
        self._write(self.directory / 'state.json', {
            'task_id': self.task_id, 'generation': self.generation,
            'status': status, 'updated_at': time.time(),
        })

    def state(self) -> dict[str, Any]:
        value = self._read(self.directory / 'state.json')
        if value and (value.get('task_id') != self.task_id or value.get('generation') != self.generation):
            raise ControlError('Control channel belongs to another Task run')
        return value

    @staticmethod
    def _identifier(command_id: str) -> str:
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', command_id):
            raise ControlError('Invalid command identity')
        return command_id

    def submit(self, command_id: str, kind: CommandKind, payload: dict[str, Any], *, timeout: float = 10) -> str:
        identifier = self._identifier(command_id)
        if kind not in {'ping', 'answer', 'interrupt', 'message'}:
            raise ControlError('Unsupported worker command')
        if len(json.dumps(payload, ensure_ascii=False).encode()) > MAX_PAYLOAD_BYTES:
            raise ControlError('Control payload is too large')
        path = self.requests / (identifier + '.json')
        existing = self._read(path)
        if existing:
            if (existing.get('kind') != kind or existing.get('payload') != payload
                    or existing.get('task_id') != self.task_id or existing.get('token') != self.token):
                raise ControlError('Command identity was already used for different input')
            return identifier
        if self.state().get('status') != 'accepting':
            raise ControlError('Task is not accepting control commands')
        if len(list(self.requests.glob('*.json'))) >= MAX_COMMANDS:
            raise ControlError('Task control command limit reached')
        record = {'id': identifier, 'task_id': self.task_id, 'token': self.token,
                  'kind': kind, 'payload': payload, 'order': time.monotonic_ns(),
                  'expires_at': time.time() + timeout}
        try:
            self._write(path, record, exclusive=True)
        except FileExistsError:
            return self.submit(identifier, kind, payload, timeout=timeout)
        return identifier

    def pending(self) -> list[dict[str, Any]]:
        records = []
        for path in self.requests.glob('*.json'):
            identifier = self._identifier(path.stem)
            if (self.replies / (identifier + '.json')).exists() or (self.started / (identifier + '.json')).exists():
                continue
            value = self._read(path)
            token = value.get('token')
            if (value.get('task_id') != self.task_id or not isinstance(token, str)
                    or not hmac.compare_digest(token, self.token)):
                self.acknowledge(identifier, error='Control capability does not match this Task')
                continue
            if value.get('id') != identifier or not isinstance(value.get('order'), int):
                self.acknowledge(identifier, error='Invalid command record')
                continue
            if not isinstance(value.get('expires_at'), (int, float)) or value['expires_at'] < time.time():
                self.acknowledge(identifier, error='Control command expired before delivery')
                continue
            records.append(value)
        return sorted(records, key=lambda record: (record['order'], record['id']))

    def claim(self, command_id: str) -> None:
        """Persist delivery start before any SDK effect; never replay a claimed input."""
        identifier = self._identifier(command_id)
        self._write(self.started / (identifier + '.json'), {'id':identifier}, exclusive=True)

    def acknowledge(self, command_id: str, result: dict[str, Any] | None = None, *, error: str = '') -> None:
        identifier = self._identifier(command_id)
        self._write(self.replies / (identifier + '.json'), {
            'id': identifier, 'task_id': self.task_id, 'generation': self.generation,
            'status': 'rejected' if error else 'accepted', 'result': result or {}, 'error': error,
        })

    def reply(self, command_id: str) -> dict[str, Any] | None:
        value = self._read(self.replies / (self._identifier(command_id) + '.json'))
        if not value:
            return None
        if (value.get('task_id') != self.task_id or value.get('generation') != self.generation
                or value.get('id') != command_id):
            raise ControlError('Reply does not belong to this Task command')
        return value

    def has_command(self, command_id: str) -> bool:
        return bool(self._read(self.requests / (self._identifier(command_id) + '.json')))

    def close(self) -> None:
        self.publish('closing')
        for command in self.pending():
            self.acknowledge(command['id'], error='Task finished before accepting this command')
        self.publish('closed')
