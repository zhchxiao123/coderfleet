"""
Mac 辅助程序原型（研究用，见 docs/research/mac-helper-for-container-agents-20261125.md）。

一个带令牌的 MCP 服务器（Streamable HTTP）：容器里的 Claude Code 通过它在这台
机器上跑命令、截屏、列串口。每次调用先过 policy.json（拒绝 / 要人确认 / 放行，
默认拒绝），再写一行审计日志。

刻意不带 `from __future__ import annotations`，原因同 coderfleet/server/mcp_bridge.py。
"""
import argparse
import hmac
import json
import os
import platform
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from glob import glob
from pathlib import Path

import uvicorn
from mcp.server.fastmcp import FastMCP, Image
from starlette.responses import JSONResponse

HERE = Path(__file__).resolve().parent
IS_MAC = sys.platform == "darwin"
OUTPUT_TAIL = 4000

mcp_server = FastMCP("mac", streamable_http_path="/")
_state: dict = {}


def load_policy(path: Path) -> dict:
    raw = json.loads(path.read_text(encoding="utf-8"))
    return {key: [re.compile(p) for p in raw.get(key, [])] for key in ("deny", "confirm", "allow")}


def decide(policy: dict, argv: list[str]) -> tuple[str, str]:
    """返回 (deny|confirm|allow, 命中的规则)。顺序固定：拒绝 > 确认 > 放行，都不中就拒绝。"""
    line = shlex.join(argv)
    for verdict in ("deny", "confirm", "allow"):
        for rule in policy[verdict]:
            if rule.search(line):
                return verdict, rule.pattern
    return "deny", "(no rule matched)"


def ask_human(line: str) -> bool:
    """要人确认的命令：Mac 上弹系统对话框；别的系统没有人可问，一律不放行。"""
    forced = os.environ.get("MAC_HELPER_TEST_CONFIRM")  # 只给自检脚本用
    if forced:
        return forced == "approve"
    if not IS_MAC:
        return False
    script = (
        'display dialog "CoderFleet 里的 AI 想在这台 Mac 上运行：\\n\\n" & (item 1 of argv) '
        '& "\\n\\n允许吗？" buttons {"拒绝", "允许"} default button "拒绝" with icon caution giving up after 120'
    )
    wrapped = f"on run argv\n{script}\nend run"
    done = subprocess.run(["osascript", "-e", wrapped, line], capture_output=True, text=True)
    return done.returncode == 0 and "button returned:允许" in done.stdout


def audit(tool: str, **fields) -> None:
    request = mcp_server.get_context().request_context.request
    task_id = request.headers.get("x-coderfleet-task-id", "") if request else ""
    record = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "task_id": task_id, "tool": tool, **fields}
    with _state["audit"].open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False) + "\n")


@mcp_server.tool()
def host_info() -> dict:
    """这台机器是什么、装了哪些能用的工具。先调它，再决定怎么做。"""
    info = {
        "system": platform.system(),
        "release": platform.release(),
        "machine": platform.machine(),
        "tools": {name: bool(shutil.which(name)) for name in ("screencapture", "osascript", "esptool", "xcodebuild", "cua-driver", "peekaboo")},
    }
    audit("host_info")
    return info


@mcp_server.tool()
def run_command(argv: list[str], cwd: str = "", timeout_s: int = 120) -> dict:
    """在这台机器上运行一条命令（不经过 shell，argv 是参数数组）。

    命令先过本机的规则：有的直接拒绝，有的要机器主人当场点「允许」，都不在
    放行清单里的也拒绝。被拒绝时不要换个写法绕过，把原因告诉用户。
    """
    if not argv:
        raise ValueError("argv is empty")
    verdict, rule = decide(_state["policy"], argv)
    if verdict == "confirm":
        verdict = "allow" if ask_human(shlex.join(argv)) else "deny-unconfirmed"
    if verdict != "allow":
        audit("run_command", argv=argv, verdict=verdict, rule=rule)
        return {"ran": False, "verdict": verdict, "rule": rule}
    started = time.monotonic()
    try:
        done = subprocess.run(argv, cwd=cwd or None, capture_output=True, text=True, timeout=timeout_s)
        result = {"ran": True, "exit_code": done.returncode, "stdout": done.stdout[-OUTPUT_TAIL:], "stderr": done.stderr[-OUTPUT_TAIL:]}
    except subprocess.TimeoutExpired:
        result = {"ran": True, "exit_code": None, "error": f"timeout after {timeout_s}s"}
    except OSError as error:
        result = {"ran": False, "verdict": "allow", "error": str(error)}
    audit("run_command", argv=argv, verdict="allow", rule=rule, exit_code=result.get("exit_code"), seconds=round(time.monotonic() - started, 2))
    return result


@mcp_server.tool()
def screenshot() -> Image:
    """截一张当前屏幕的图。Mac 上是真屏幕；别的系统上是一张带随机验证码的示意图。"""
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "screen.png"
        if IS_MAC:
            subprocess.run(["screencapture", "-x", "-t", "png", str(path)], check=True, timeout=30)
            # 模型一侧的图片长边上限见研究文档；这里先缩到 1568，坐标换算留给正式版。
            subprocess.run(["sips", "-Z", "1568", str(path)], check=True, capture_output=True, timeout=30)
            note = "real"
        else:
            from PIL import Image as PILImage, ImageDraw

            code = _state["fake_code"]
            canvas = PILImage.new("RGB", (640, 360), "white")
            draw = ImageDraw.Draw(canvas)
            draw.rectangle((20, 20, 620, 340), outline="black", width=3)
            draw.text((60, 120), f"FAKE SCREEN  CODE {code}", fill="black", font_size=40)
            canvas.save(path)
            note = "synthetic"
        data = path.read_bytes()
    audit("screenshot", kind=note, bytes=len(data))
    return Image(data=data, format="png")


@mcp_server.tool()
def serial_ports() -> list[str]:
    """列出这台机器上的串口设备（开发板插上以后会出现在这里）。"""
    patterns = ["/dev/cu.*"] if IS_MAC else ["/dev/ttyUSB*", "/dev/ttyACM*"]
    ports = sorted(port for pattern in patterns for port in glob(pattern))
    audit("serial_ports", count=len(ports))
    return ports


def build_app(token: str):
    app = mcp_server.streamable_http_app()

    @app.middleware("http")
    async def require_token(request, call_next):
        given = request.headers.get("authorization", "")
        if not hmac.compare_digest(given.encode(), f"Bearer {token}".encode()):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        return await call_next(request)

    return app


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8791)
    parser.add_argument("--policy", type=Path, default=HERE / "policy.json")
    parser.add_argument("--audit", type=Path, default=HERE / "audit.jsonl")
    args = parser.parse_args()
    token = os.environ.get("MAC_HELPER_TOKEN", "")
    if len(token) < 24:
        sys.exit("MAC_HELPER_TOKEN must be set to a random value of at least 24 characters")
    _state.update(policy=load_policy(args.policy), audit=args.audit, fake_code=os.environ.get("MAC_HELPER_FAKE_CODE", "000000"))
    uvicorn.run(build_app(token), host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
