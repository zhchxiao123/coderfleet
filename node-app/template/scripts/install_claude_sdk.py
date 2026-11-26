#!/usr/bin/env python3
"""Install the pinned Claude SDK outside the CoderFleet server environment."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

SDK_VERSION = "0.2.186"
CLI_VERSION = "2.1.329"

# Executed by the destination interpreter: dependency discovery must not inspect
# the host server's import path or accidentally accept its older MCP package.
CHECK_PROGRAM = """
import importlib.metadata
import json
import os
import pathlib
import subprocess
import sys

sdk_version = importlib.metadata.version('claude-agent-sdk')
if sdk_version != sys.argv[1]:
    raise RuntimeError('Expected claude-agent-sdk==' + sys.argv[1] + ', found ' + sdk_version)
import claude_agent_sdk
cli = pathlib.Path(claude_agent_sdk.__file__).parent / '_bundled' / ('claude.exe' if os.name == 'nt' else 'claude')
if not cli.is_file() or not os.access(cli, os.X_OK):
    raise RuntimeError('The installed SDK wheel has no executable bundled Claude CLI')
result = subprocess.run([str(cli), '--version'], check=True, capture_output=True, text=True, timeout=15)
version = result.stdout.strip().split()[0]
if version != sys.argv[2]:
    raise RuntimeError('Expected bundled Claude CLI ' + sys.argv[2] + ', found ' + version)
print(json.dumps({'ready': True, 'sdk_version': sdk_version, 'cli_version': version,
                 'python_path': sys.executable, 'cli_path': str(cli), 'error': ''}))
"""


def default_venv() -> Path:
    data_home = Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local" / "share")))
    return data_home / "coderfleet" / "claude-sdk"


def check_environment(target: Path) -> dict[str, Any]:
    python = target / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not python.is_file():
        return {"ready": False, "sdk_version": "", "cli_version": "", "python_path": str(python), "cli_path": "", "error": "SDK environment is missing; run the installer without --check"}
    try:
        result = subprocess.run([str(python), "-I", "-c", CHECK_PROGRAM, SDK_VERSION, CLI_VERSION], capture_output=True, text=True, timeout=25)
        if result.returncode:
            message = result.stderr.strip().splitlines()[-1] if result.stderr.strip() else "SDK check failed"
            raise RuntimeError(message)
        data = json.loads(result.stdout)
        if not isinstance(data, dict) or data.get("ready") is not True:
            raise ValueError("SDK check returned an invalid result")
        return data
    except (OSError, subprocess.TimeoutExpired, ValueError, RuntimeError) as exc:
        return {"ready": False, "sdk_version": "", "cli_version": "", "python_path": str(python), "cli_path": "", "error": str(exc)}


def install(target: Path, python: str, wheelhouse: Path | None) -> None:
    if target.exists() and not (target / "pyvenv.cfg").is_file():
        raise ValueError("Destination exists and is not a virtual environment")
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        subprocess.run([python, "-m", "venv", str(target)], check=True, stdout=sys.stderr)
    destination_python = target / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    command = [str(destination_python), "-I", "-m", "pip", "install", "--disable-pip-version-check", "--no-cache-dir", "--only-binary=:all:"]
    if wheelhouse:
        command += ["--no-index", "--find-links", str(wheelhouse)]
    command.append(f"claude-agent-sdk=={SDK_VERSION}")
    subprocess.run(command, check=True, stdout=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--venv", type=Path, default=default_venv(), help="Dedicated SDK virtual environment")
    parser.add_argument("--python", default=sys.executable, help="Python 3.10+ used to create the environment")
    parser.add_argument("--wheelhouse", type=Path, help="Install only from this offline wheel directory")
    parser.add_argument("--check", action="store_true", help="Read-only package and bundled CLI check")
    args = parser.parse_args()
    target = args.venv.expanduser().absolute()
    try:
        if not args.check:
            install(target, args.python, args.wheelhouse)
        result = check_environment(target)
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        result = {"ready": False, "sdk_version": "", "cli_version": "", "python_path": "", "cli_path": "", "error": str(exc)}
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
