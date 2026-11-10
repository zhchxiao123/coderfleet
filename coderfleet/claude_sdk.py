"""Host-side SDK launch helpers; importing this module never imports the SDK."""

from __future__ import annotations

from collections.abc import Mapping
from importlib import resources
import json
import os
from pathlib import Path
import shlex

CONTAINER_SDK_PYTHON = "/opt/coderfleet-claude-sdk-venv/bin/python"


def worker_source() -> bytes:
    """Return the standalone worker resource to copy into an execution boundary."""
    return resources.files("coderfleet.data").joinpath("scripts/coderfleet_claude_sdk_worker.py").read_bytes()


def control_source() -> bytes:
    """Return the stdlib-only mailbox resource copied beside each worker."""
    return resources.files("coderfleet.data").joinpath("scripts/coderfleet_sdk_control.py").read_bytes()


def sdk_python(*, local: bool = False, env: Mapping[str, str] | None = None) -> str:
    """Resolve the account's explicit interpreter or its installation default."""
    values = os.environ if env is None else env
    if configured := values.get("CODERFLEET_CLAUDE_SDK_PYTHON", ""):
        return configured
    if not local:
        return CONTAINER_SDK_PYTHON
    data_home = Path(values.get("XDG_DATA_HOME") or Path.home() / ".local/share")
    return str(data_home / "coderfleet/claude-sdk/bin/python")


def _command(worker_path: str | Path, args: list[str], *, marker: str = "", local: bool = False) -> str:
    # The default is resolved on the host, while an account's environment override
    # is expanded inside its container/local subprocess, never interpolated as code.
    default_env = {"XDG_DATA_HOME": os.environ.get("XDG_DATA_HOME", "")} if local else {}
    default = shlex.quote(sdk_python(local=local, env=default_env))
    # CPython on Linux locates its venv through argv[0]. An exec -a marker can
    # make it import host packages instead. Keep the marker as an ordinary argv
    # element, which preserves the scheduler's pgrep -f identity contract.
    marker_args = ["--task-marker", marker] if marker else []
    arguments = " ".join(shlex.quote(value) for value in [str(worker_path), *args, *marker_args])
    return (
        'cf_sdk_python="${CODERFLEET_CLAUDE_SDK_PYTHON:-}"; '
        f'if [ -z "$cf_sdk_python" ]; then cf_sdk_python={default}; fi; '
        f'exec "$cf_sdk_python" -I {arguments}'
    )


def build_worker_command(
    spec_path: str | Path, worker_path: str | Path, marker: str = "", *, local: bool = False,
) -> str:
    return _command(worker_path, ["--spec", str(spec_path)], marker=marker, local=local)


def build_doctor_command(worker_path: str | Path, *, local: bool = False) -> str:
    return _command(worker_path, ["--doctor"], local=local)


def extract_sdk_metadata(text: str, *, task_id: str = "") -> dict[str, str]:
    """Read the worker's identity event without treating ordinary CLI data as metadata."""
    for line in text.splitlines():
        try:
            event = json.loads(line)
        except (ValueError, TypeError):
            continue
        if not isinstance(event, dict) or event.get("type") != "system" or event.get("subtype") != "coderfleet_backend":
            continue
        if event.get("execution_backend") != "sdk" or (task_id and event.get("task_id") != task_id):
            continue
        return {
            name: event[name]
            for name in ("sdk_version", "cli_version")
            if isinstance(event.get(name), str)
        }
    return {}
