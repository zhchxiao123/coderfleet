from __future__ import annotations
import asyncio
import os
import base64
import json
from pathlib import Path
import re
import subprocess
import tempfile
import time
import urllib.request
import socket

import websockets
from fastapi import FastAPI
from fastapi.responses import HTMLResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
import uvicorn

from coderfleet.server.models import Task, AccountType, TaskStatus
from coderfleet.server.platform_agent import PlatformHarness, PlatformSettings
from coderfleet.server.platform_routes import build_platform_router
from coderfleet.server.runtime import FakeRuntime, FakeProcess
from coderfleet.server.scheduler import Scheduler

OUT = Path(
    os.environ.get(
        "CODERFLEET_BROWSER_OUTPUT", tempfile.mkdtemp(prefix="platform-chat-browser-")
    )
)
OUT.mkdir(parents=True, exist_ok=True)
ROOT = Path(tempfile.mkdtemp(prefix="fixture-", dir=OUT))
STATIC = Path.cwd() / "coderfleet/server/static"


class Runtime(FakeRuntime):
    fail_next = False

    async def exec(self, *a, **kw):
        return FakeProcess(stdout_chunks=[b'{"alive":false}'])

    async def run(self, spec):
        await asyncio.sleep(0.3)
        workspace = Path(next(src for src, dst in spec.mounts if dst == "/workspace"))
        request = json.loads(
            next((workspace / ".coderfleet-tasks").glob("*.sdk.json")).read_text()
        )
        if request.get('platform_snapshot'):
            snapshot=json.loads(Path(next(src for src,dst in spec.mounts if dst=='/platform-data/snapshot.json:ro')).read_text())
            ids=[row['id']for row in snapshot['activities']]
        else:
            from coderfleet.server.platform_retrieval import PlatformReader
            reader=PlatformReader(scheduler,workspace.parent.name)
            for task in reader.call('list_tasks',{})['tasks']:reader.call('read_task',{'task_id':task['id']})
            snapshot=reader.catalog;ids=list(reader.sources())
        if self.fail_next:
            self.fail_next = False
            (
                workspace
                / ".coderfleet-tasks"
                / (request["task_id"] + ".platform-progress.json")
            ).write_text(
                json.dumps(
                    {
                        "task_id": request["task_id"],
                        "snapshot_fingerprint": snapshot["fingerprint"],
                        "read": 1,
                        "total": len(ids),
                        "phase": "reading",
                        "turns_used": 3,
                        "max_turns": 24,
                    }
                )
            )
            await asyncio.sleep(3)
            events = [
                {
                    "type": "result",
                    "subtype": "error_max_turns",
                    "terminal_reason": "max_turns",
                    "is_error": True,
                },
                {
                    "type": "system",
                    "subtype": "coderfleet_platform_coverage",
                    "task_id": request["task_id"],
                    "snapshot_fingerprint": snapshot["fingerprint"],
                    "source_ids": ids[:1],
                    "total": len(ids),
                },
            ]
            return FakeProcess(
                returncode=1,
                stdout_chunks=[
                    ("\n".join(json.dumps(v) for v in events) + "\n").encode()
                ],
            )
        events = [
            {
                "type": "system",
                "subtype": "coderfleet_platform_coverage",
                "task_id": request["task_id"],
                "snapshot_fingerprint": snapshot["fingerprint"],
                "manifest_read": True,
                "source_ids": ids,
            },
            {
                "type": "result",
                "subtype": "success",
                "is_error": False,
                "structured_output": {
                    "answer_markdown": '## 今日进展\n\n**代理问题**尚待处理。\n\n- 已确认暂停发布\n\n<script>window.XSS=1</script><img src=x onerror="window.XSS=2">',
                    "source_ids": ids,
                },
            },
        ]
        return FakeProcess(
            stdout_chunks=[("\n".join(json.dumps(v) for v in events) + "\n").encode()]
        )


(ROOT / "accounts.conf").write_text(
    "NAME=fixture TYPE=claude PROXY=off CLAUDE_BACKEND=sdk\n"
)
scheduler = Scheduler(ROOT, runtime=Runtime())
scheduler._get_ephemeral_network = lambda _: None
PlatformHarness(scheduler).configure(
    PlatformSettings(
        account="fixture", timezone="America/Los_Angeles", image="fixture:ui"
    )
)
task = Task(
    id="fixture-source",
    status=TaskStatus.done,
    account="fixture",
    type=AccountType.claude,
    prompt="请检查代理问题",
    project="/fixture",
    project_name="演示项目",
    created="2026-11-12T16:00:00Z",
    finished="2026-11-12T17:00:00Z",
)
task.save(scheduler.tasks_dir)
scheduler.get_log_path(task.id).write_text(
    '{"type":"result","result":"暂停发布，等待确认。"}\n'
)
app = FastAPI()
app.include_router(build_platform_router(lambda: scheduler))
app.mount("/static", StaticFiles(directory=STATIC))


@app.get("/")
async def index():
    s = (STATIC / "index.html").read_text()
    s = re.sub(r'<script src="/static/js/app.js[^>]+></script>', "", s)
    s = s.replace("</body>", '<script>showPage("digest")</script></body>')
    return HTMLResponse(s)


@app.get("/api/tasks/{identifier}/logs")
async def logs(identifier: str):
    return PlainTextResponse(scheduler.get_log_path(identifier).read_text())


class CDP:
    def __init__(self, ws):
        self.ws = ws
        self.serial = 0
        self.events = []

    async def call(self, method, params=None):
        self.serial += 1
        identifier = self.serial
        await self.ws.send(
            json.dumps({"id": identifier, "method": method, "params": params or {}})
        )
        while True:
            value = json.loads(await asyncio.wait_for(self.ws.recv(), 10))
            if value.get("id") == identifier:
                assert "error" not in value, value
                return value.get("result", {})
            self.events.append(value)

    async def evaluate(self, expression):
        r = await self.call(
            "Runtime.evaluate",
            {"expression": expression, "awaitPromise": True, "returnByValue": True},
        )
        assert "exceptionDetails" not in r, r
        return r.get("result", {}).get("value")

    async def until(self, expression):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if await self.evaluate(expression):
                return
            await asyncio.sleep(0.1)
        print(
            await self.evaluate(
                'document.body.innerText.slice(0,5000)+" URL "+location.href'
            ),
            flush=True,
        )
        raise TimeoutError(expression)


async def main():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error")
    )
    serving = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.05)
    binary = Path(os.environ["CODERFLEET_TEST_CHROME"])
    process = subprocess.Popen(
        [
            str(binary),
            "--headless",
            "--disable-gpu",
            "--no-sandbox",
            "--remote-debugging-port=0",
            "--user-data-dir=" + str(ROOT / "chrome"),
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.monotonic() + 10
        while (
            not (ROOT / "chrome/DevToolsActivePort").exists()
            and time.monotonic() < deadline
        ):
            await asyncio.sleep(0.1)
        debug_port = (ROOT / "chrome/DevToolsActivePort").read_text().splitlines()[0]
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        pages = json.loads(
            opener.open("http://127.0.0.1:" + debug_port + "/json/list").read()
        )
        async with websockets.connect(pages[0]["webSocketDebuggerUrl"]) as ws:
            cdp = CDP(ws)
            await cdp.call("Runtime.enable")
            await cdp.call("Page.enable")
            await cdp.call(
                "Emulation.setDeviceMetricsOverride",
                {
                    "width": 1360,
                    "height": 1050,
                    "deviceScaleFactor": 1,
                    "mobile": False,
                },
            )
            await cdp.call("Page.navigate", {"url": f"http://127.0.0.1:{port}/"})
            await cdp.until(
                "document.querySelector('#platform-timezone')?.value==='America/Los_Angeles'"
            )
            assert await cdp.evaluate(
                "!document.querySelector('#platform-more').open && !!document.querySelector('.platform-welcome')"
            )
            screenshot = await cdp.call(
                "Page.captureScreenshot",
                {"format": "png", "captureBeyondViewport": False},
            )
            (OUT / "platform-chat-welcome.png").write_bytes(
                base64.b64decode(screenshot["data"])
            )
            await cdp.evaluate(
                "document.querySelector('#platform-date').value='2026-11-12';document.querySelector('#platform-daily').click()"
            )
            await cdp.until(
                "document.querySelector('.platform-turn:last-child .markdown-body h2')?.textContent==='今日进展'"
            )
            assert await cdp.evaluate(
                "document.querySelectorAll('.platform-user').length===1 && !document.querySelector('#platform-question').value"
            )
            assert not await cdp.evaluate("!!window.XSS")
            assert not await cdp.evaluate(
                "!!document.querySelector('#platform-result script,#platform-result img')"
            )
            await cdp.evaluate(
                "document.querySelector('#platform-question').value='那应该先处理哪个？';document.querySelector('#platform-question').dispatchEvent(new Event('input'));document.querySelector('#platform-question').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))"
            )
            await cdp.until(
                "document.querySelectorAll('.platform-turn .markdown-body').length===2"
            )
            assert await cdp.evaluate(
                "document.querySelectorAll('.platform-user').length===2 && document.querySelector('#platform-date').disabled"
            )
            assert len(list((ROOT / "platform/runs").glob("*/run.json"))) == 2
            requests = [
                json.loads(path.read_text())
                for path in (ROOT / "platform/runs").glob("*/run.json")
            ]
            assert (
                sum(bool(row["request"].get("parent_run_id")) for row in requests) == 1
            )
            assert any(
                "那应该先处理哪个" in task.prompt and "read_reply" in task.prompt
                for task in scheduler.list_tasks()
            )
            await cdp.evaluate(
                "document.querySelector('#platform-result .platform-sources').closest('details').open=true;document.querySelector('.platform-sources button').click()"
            )
            await cdp.until(
                "document.querySelector('.platform-sources pre').textContent.includes('代理')"
            )
            # No Enter submission during IME or Shift+Enter; refresh keeps the draft and thread.
            await cdp.evaluate(
                "document.querySelector('#platform-question').value='unsent draft';document.querySelector('#platform-question').dispatchEvent(new Event('input'));document.querySelector('#platform-question').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true}));document.querySelector('#platform-question').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}))"
            )
            assert len(list((ROOT / "platform/runs").glob("*/run.json"))) == 2
            await cdp.call("Page.reload")
            await cdp.until("document.querySelectorAll('.platform-user').length===2")
            assert await cdp.evaluate(
                "document.querySelector('#platform-question').value==='unsent draft'"
            )
            # A response lost after acceptance must be looked up on reload, never replayed.
            await cdp.evaluate(
                "document.querySelector('#platform-question').value='继续说明';document.querySelector('#platform-question').dispatchEvent(new Event('input'));window.originalFetch=window.fetch;window.fetch=async(...args)=>{const response=await window.originalFetch(...args);if(String(args[0]).endsWith('/api/platform/runs')&&args[1]?.method==='POST'&&!window.lost){window.lost=true;throw new TypeError('fixture lost response');}return response;};document.querySelector('#platform-form').requestSubmit()"
            )
            await cdp.until(
                "document.querySelector('#platform-message').textContent.includes('fixture lost response')"
            )
            assert await cdp.evaluate(
                "!!localStorage.getItem('cf-platform-pending-v1')"
            )
            assert await cdp.evaluate(
                "document.querySelector('#platform-question').readOnly"
            ), "uncertain request must protect the original draft"
            await cdp.call("Page.reload")
            await cdp.until(
                "document.querySelectorAll('.platform-turn .markdown-body').length===3"
            )
            assert not await cdp.evaluate(
                "!!localStorage.getItem('cf-platform-pending-v1')"
            )
            assert len(list((ROOT / "platform/runs").glob("*/run.json"))) == 3
            # A malformed 2xx receipt is still unknown and must retain the exact nonce.
            await cdp.evaluate(
                "PlatformAgent.startNew();document.querySelector('#platform-date').value='2026-11-12';document.querySelector('#platform-question').value='corrupt receipt';document.querySelector('#platform-question').dispatchEvent(new Event('input'));window.realFetch=window.fetch;window.fetch=async(...args)=>{const response=await window.realFetch(...args);if(String(args[0]).endsWith('/api/platform/runs')&&args[1]?.method==='POST'&&!window.corrupted){window.corrupted=true;return new Response('{',{status:201,headers:{'Content-Type':'application/json'}});}return response;};document.querySelector('#platform-form').requestSubmit()"
            )
            await cdp.until(
                "document.querySelector('#platform-message').textContent.includes('服务返回异常')"
            )
            assert await cdp.evaluate(
                "!!localStorage.getItem('cf-platform-pending-v1')"
            ), "malformed success discarded request identity"
            await cdp.evaluate(
                "document.querySelector('#platform-form').requestSubmit()"
            )
            await cdp.until(
                "document.querySelector('.platform-turn .markdown-body') && !localStorage.getItem('cf-platform-pending-v1')"
            )
            assert len(list((ROOT / "platform/runs").glob("*/run.json"))) == 4
            # An acknowledged POST is recoverable even if transcript loading fails.
            await cdp.evaluate(
                "PlatformAgent.startNew();document.querySelector('#platform-question').value='accepted then transcript load fails';document.querySelector('#platform-question').dispatchEvent(new Event('input'));window.safeFetch=window.fetch;window.fetch=async(...args)=>{if(String(args[0]).endsWith('/thread')&&!window.threadFailed){window.threadFailed=true;throw new TypeError('fixture transcript unavailable');}const response=await window.safeFetch(...args);if(String(args[0]).endsWith('/api/platform/runs')&&args[1]?.method==='POST')window.acceptedId=(await response.clone().json()).id;return response;};document.querySelector('#platform-form').requestSubmit()"
            )
            await cdp.until(
                "document.querySelector('#platform-message').textContent.includes('fixture transcript unavailable')"
            )
            assert await cdp.evaluate(
                "localStorage.getItem('cf-platform-selected-v2')===window.acceptedId"
            ), "accepted message lost its recovery pointer"
            await cdp.call("Page.reload")
            await cdp.until(
                "document.querySelector('.platform-user p')?.textContent==='accepted then transcript load fails'"
            )
            await cdp.until("!!document.querySelector('.platform-turn .markdown-body')")
            assert len(list((ROOT / "platform/runs").glob("*/run.json"))) == 5
            # A hidden new-chat draft cannot override the current conversation's daily scope.
            await cdp.evaluate(
                "window.currentReply=localStorage.getItem('cf-platform-selected-v2');PlatformAgent.startNew();document.querySelector('#platform-date').value='1900-01-01';document.querySelector('#platform-question').value='keep this new-chat draft';document.querySelector('#platform-question').dispatchEvent(new Event('input'));document.querySelector('#platform-runs button').click()"
            )
            await cdp.until(
                "document.querySelector('.platform-user p')?.textContent==='accepted then transcript load fails'"
            )
            await cdp.evaluate(
                "window.scopeFetch=window.fetch;window.fetch=async(...args)=>{if(String(args[0]).endsWith('/api/platform/runs')&&args[1]?.method==='POST')window.dailyBody=JSON.parse(args[1].body);return window.scopeFetch(...args);};document.querySelector('#platform-daily').click()"
            )
            await cdp.until("!!window.dailyBody")
            assert await cdp.evaluate("window.dailyBody.date==='2026-11-12'"), (
                "daily shortcut silently switched to a hidden draft scope"
            )
            await cdp.until(
                "document.querySelector('.platform-turn .markdown-body h2')?.textContent==='今日进展'"
            )
            assert await cdp.evaluate(
                "JSON.parse(localStorage.getItem('cf-platform-drafts-v2')).new.question==='keep this new-chat draft'"
            ), "daily shortcut deleted an unrelated draft"
            await cdp.evaluate(
                "document.querySelector('#platform-question').value='follow-up draft';document.querySelector('#platform-question').dispatchEvent(new Event('input'));document.querySelector('#platform-new').click()"
            )
            assert await cdp.evaluate(
                "!!document.querySelector('.platform-welcome') && !document.querySelector('#platform-date').disabled"
            )
            await cdp.evaluate(
                "document.querySelector('#platform-runs button').click()"
            )
            await cdp.until("document.querySelectorAll('.platform-user').length===1")
            assert await cdp.evaluate(
                "document.querySelector('#platform-question').value==='follow-up draft'"
            )
            screenshot = await cdp.call(
                "Page.captureScreenshot",
                {"format": "png", "captureBeyondViewport": False},
            )
            (OUT / "platform-chat-desktop.png").write_bytes(
                base64.b64decode(screenshot["data"])
            )
            await cdp.evaluate(
                "document.documentElement.setAttribute('data-theme','dark')"
            )
            screenshot = await cdp.call(
                "Page.captureScreenshot",
                {"format": "png", "captureBeyondViewport": False},
            )
            (OUT / "platform-chat-dark.png").write_bytes(
                base64.b64decode(screenshot["data"])
            )
            await cdp.evaluate(
                "document.documentElement.setAttribute('data-theme','light')"
            )
            for width in (1440, 1024, 768, 375):
                await cdp.call(
                    "Emulation.setDeviceMetricsOverride",
                    {
                        "width": width,
                        "height": 900,
                        "deviceScaleFactor": 1,
                        "mobile": width < 768,
                    },
                )
                assert await cdp.evaluate(
                    "document.documentElement.scrollWidth<=window.innerWidth"
                ), "horizontal overflow"
                assert await cdp.evaluate(
                    "document.querySelector('#platform-submit').getBoundingClientRect().bottom<=window.innerHeight"
                ), "composer offscreen"
            screenshot = await cdp.call(
                "Page.captureScreenshot",
                {"format": "png", "captureBeyondViewport": False},
            )
            (OUT / "platform-chat-mobile.png").write_bytes(
                base64.b64decode(screenshot["data"])
            )
            # More carries scope/settings and is operable without covering the composer.
            await cdp.evaluate("document.querySelector('#platform-more').open=true")
            assert await cdp.evaluate(
                "document.querySelector('.platform-options').getBoundingClientRect().top>=0"
            )
            # Active reads show real progress; limit failures terminate visibly without replay.
            await cdp.call(
                "Emulation.setDeviceMetricsOverride",
                {
                    "width": 1360,
                    "height": 1050,
                    "deviceScaleFactor": 1,
                    "mobile": False,
                },
            )
            scheduler.runtime.fail_next = True
            await cdp.evaluate(
                "document.querySelector('#platform-more').open=false;PlatformAgent.startNew();document.querySelector('#platform-date').value='2026-11-12';document.querySelector('#platform-question').value='今天做了哪些事情';document.querySelector('#platform-question').dispatchEvent(new Event('input'));document.querySelector('#platform-form').requestSubmit()"
            )
            await cdp.until(
                "document.querySelector('#platform-result').textContent.includes('已读取 1/2 条活动')"
            )
            await cdp.until(
                "document.querySelector('#platform-result')?.textContent.includes('24 轮')"
            )
            assert await cdp.evaluate(
                "document.querySelector('#platform-result').textContent.includes('已读取 1/2 条活动') && document.querySelector('#platform-result').textContent.includes('不会自动重放')"
            )
            assert len(list((ROOT / "platform/runs").glob("*/run.json"))) == 7
            await cdp.call("Page.reload")
            await cdp.until(
                "document.querySelector('#platform-result')?.textContent.includes('24 轮')"
            )
            assert len(list((ROOT / "platform/runs").glob("*/run.json"))) == 7
            failures = [
                event
                for event in cdp.events
                if event.get("method") == "Runtime.exceptionThrown"
            ]
            assert not failures, failures
            (OUT / "browser-accepted.json").write_text(
                json.dumps(
                    {
                        "chat_layout": True,
                        "live_progress_and_limit_error_no_replay": True,
                        "real_followup_context": True,
                        "sources": True,
                        "markdown_sanitized": True,
                        "drafts_and_navigation": True,
                        "ime_and_shift_enter": True,
                        "lost_response_no_replay": True,
                        "malformed_success_no_replay": True,
                        "acknowledged_pointer_survives_load_failure": True,
                        "daily_scope_and_unrelated_draft_preserved": True,
                        "light_dark": True,
                        "responsive_widths": [375, 768, 1024, 1440],
                        "runtime_errors": failures,
                    },
                    indent=2,
                )
            )
            print("Chat browser acceptance passed", flush=True)

    finally:
        process.terminate()
        process.wait(timeout=10)
        server.should_exit = True
        try:
            await asyncio.wait_for(serving, 5)
        except asyncio.TimeoutError:
            serving.cancel()


if __name__ == "__main__":
    asyncio.run(main())
