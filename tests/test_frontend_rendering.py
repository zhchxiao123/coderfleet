"""Run behavioral JS regressions alongside the Python suite when Node is available."""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest


NODE = shutil.which("node")
ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(NODE is None, reason="Node.js is required for the frontend behavioral tests")
@pytest.mark.parametrize("script", ["rendering.test.cjs", "workbench.test.cjs"])
def test_frontend_rendering_regressions(script: str) -> None:
    assert NODE is not None
    result = subprocess.run(
        [NODE, "--test", f"tests/frontend/{script}"],
        cwd=ROOT, capture_output=True, text=True, timeout=30, check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
