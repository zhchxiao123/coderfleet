"""Opt-in real-browser regression over synthetic platform data, without model calls."""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys

import pytest


@pytest.mark.skipif(
    not os.environ.get("CODERFLEET_TEST_CHROME"),
    reason="Set CODERFLEET_TEST_CHROME to an isolated Chromium executable",
)
def test_platform_chat_browser(tmp_path: Path) -> None:
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        [sys.executable, str(root / "tests/browser/platform_chat_acceptance.py")],
        cwd=root,
        env={
            **os.environ,
            "PYTHONPATH": str(root),
            "CODERFLEET_BROWSER_OUTPUT": str(tmp_path),
        },
        capture_output=True,
        text=True,
        timeout=90,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert (tmp_path / "browser-accepted.json").is_file()
