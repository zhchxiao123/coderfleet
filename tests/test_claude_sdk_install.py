"""Exercise the packaged installer as a user command with an offline wheel."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from zipfile import ZipFile, ZipInfo


INSTALLER = Path(__file__).resolve().parents[1] / "coderfleet/data/scripts/install_claude_sdk.py"


def sdk_wheel(directory: Path, cli_version: str = "2.1.321") -> Path:
    directory.mkdir()
    wheel = directory / "claude_agent_sdk-0.2.180-py3-none-any.whl"
    with ZipFile(wheel, "w") as archive:
        archive.writestr("claude_agent_sdk/__init__.py", "")
        cli = ZipInfo("claude_agent_sdk/_bundled/claude")
        cli.external_attr = 0o100755 << 16
        archive.writestr(cli, f'#!/bin/sh\nprintf "{cli_version} (Claude Code)\\n"\n')
        archive.writestr("claude_agent_sdk-0.2.180.dist-info/METADATA", "Metadata-Version: 2.1\nName: claude-agent-sdk\nVersion: 0.2.180\n")
        archive.writestr("claude_agent_sdk-0.2.180.dist-info/WHEEL", "Wheel-Version: 1.0\nGenerator: fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n")
        archive.writestr("claude_agent_sdk-0.2.180.dist-info/RECORD", "")
    return wheel


def test_installer_provisions_and_checks_an_isolated_environment(tmp_path: Path) -> None:
    wheelhouse = tmp_path / "wheels"
    sdk_wheel(wheelhouse)
    target = tmp_path / "sdk-env"
    command = [sys.executable, str(INSTALLER), "--venv", str(target), "--python", sys.executable]
    env = dict(os.environ, PIP_CONFIG_FILE=os.devnull, PIP_NO_INDEX="1")
    installed = subprocess.run(
        [*command, "--wheelhouse", str(wheelhouse)],
        capture_output=True, text=True, env=env, timeout=30,
    )
    assert installed.returncode == 0, installed.stderr
    data = json.loads(installed.stdout)
    assert data["ready"] is True
    assert data["sdk_version"] == "0.2.180"
    assert data["cli_version"] == "2.1.321"
    assert Path(data["python_path"]) == target / "bin" / "python"
    assert Path(data["cli_path"]).is_relative_to(target)
    checked = subprocess.run([*command, "--check"], capture_output=True, text=True, env=env, timeout=10)
    assert checked.returncode == 0, checked.stderr
    assert json.loads(checked.stdout)["cli_version"] == "2.1.321"


def test_check_missing_environment_is_read_only_and_reports_not_ready(tmp_path: Path) -> None:
    target = tmp_path / "missing"
    result = subprocess.run(
        [sys.executable, str(INSTALLER), "--venv", str(target), "--check"],
        capture_output=True, text=True, timeout=10,
    )
    assert result.returncode == 1
    assert json.loads(result.stdout)["ready"] is False
    assert not target.exists()


def test_installer_rejects_a_wheel_with_the_wrong_bundled_cli(tmp_path: Path) -> None:
    wheelhouse = tmp_path / "wheels"
    sdk_wheel(wheelhouse, cli_version="9.9.9")
    result = subprocess.run(
        [sys.executable, str(INSTALLER), "--venv", str(tmp_path / "sdk-env"),
         "--python", sys.executable, "--wheelhouse", str(wheelhouse)],
        capture_output=True, text=True, timeout=30,
        env=dict(os.environ, PIP_CONFIG_FILE=os.devnull, PIP_NO_INDEX="1"),
    )
    assert result.returncode == 1
    assert "9.9.9" in json.loads(result.stdout)["error"]
