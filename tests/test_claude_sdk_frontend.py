"""Run the SDK configuration and Task metadata UI behavior tests in the suite."""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is required for frontend behavior tests")
def test_claude_sdk_frontend_behavior() -> None:
    node = shutil.which("node")
    assert node is not None
    result = subprocess.run(
        [node, "--test", "tests/frontend/claude-sdk.test.cjs", "tests/frontend/claude-sdk-renderer.test.cjs"],
        cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True,
        timeout=30, check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
