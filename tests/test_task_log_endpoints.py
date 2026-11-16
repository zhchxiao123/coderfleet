"""test_task_log_endpoints.py — /api/tasks/{id}/logs 与 /output 不应阻塞事件循环。

回归背景：这两个接口曾经在 `async def` 里直接同步 `Path.read_text()`，任务日志文件可达数 MB，
同步读取会独占 coderfleet 单进程单事件循环，挤占同一时刻的其它并发请求（issue #44）。
"""
from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

import aiofiles
import pytest

from coderfleet.server import main as server_main
from coderfleet.server.models import AccountType, Task, TaskStatus
from coderfleet.server.scheduler import Scheduler

BLOCKING_READ_SECONDS = 0.3


def _use_scheduler(monkeypatch: pytest.MonkeyPatch, ws: Path) -> None:
    monkeypatch.setattr(server_main, "scheduler", Scheduler(ws))
    monkeypatch.setattr(server_main, "WORKSPACE_DIR", ws)


def _make_task_with_log(ws: Path, task_id: str) -> Path:
    task = Task(
        id=task_id, status=TaskStatus.done, account="alice", type=AccountType.claude,
        prompt="hello", project="/srv/x", project_name="web",
    )
    task.save(server_main.scheduler.tasks_dir)
    log_path = server_main.scheduler.get_log_path(task_id)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text("=== CoderFleet Task Log ===\nhello world\n", encoding="utf-8")
    return log_path


def _simulate_slow_disk(monkeypatch: pytest.MonkeyPatch, target: Path) -> None:
    """把 `target` 这一个文件的 Path.read_text 换成"读之前先阻塞 sleep"，模拟慢磁盘/大文件读取。
    只针对目标文件打补丁，避免连带拖慢 scheduler.get_task() 内部读取任务 JSON 等无关调用，
    污染"是否阻塞事件循环"这个信号。"""
    real_read_text = Path.read_text

    def slow_read_text(self, *args, **kwargs):
        if self == target:
            time.sleep(BLOCKING_READ_SECONDS)
        return real_read_text(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", slow_read_text)


async def _run_with_concurrent_marker(coro) -> list[float]:
    """并发跑一个高频 marker 协程；如果 coro 同步阻塞了事件循环，marker 的第一次 tick
    会被推迟到 coro 的阻塞操作结束之后，而不是按预期的高频间隔触发。"""
    tick_times: list[float] = []

    async def marker():
        for _ in range(5):
            tick_times.append(time.perf_counter())
            await asyncio.sleep(0.02)

    await asyncio.gather(coro, marker())
    return tick_times


def test_get_logs_does_not_block_event_loop(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    ws = tmp_path / "workspace"
    ws.mkdir()
    _use_scheduler(monkeypatch, ws)
    log_path = _make_task_with_log(ws, "big-task")
    _simulate_slow_disk(monkeypatch, log_path)

    t0 = time.perf_counter()
    tick_times = asyncio.run(_run_with_concurrent_marker(server_main.get_logs("big-task")))

    first_tick_delay = tick_times[0] - t0
    assert first_tick_delay < BLOCKING_READ_SECONDS / 2, (
        f"marker 的第一次 tick 延迟了 {first_tick_delay:.3f}s，"
        f"说明 get_logs 同步阻塞了事件循环（模拟的慢读取耗时 {BLOCKING_READ_SECONDS}s）"
    )


def test_get_task_output_does_not_block_event_loop(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    ws = tmp_path / "workspace"
    ws.mkdir()
    _use_scheduler(monkeypatch, ws)
    log_path = _make_task_with_log(ws, "big-task")
    _simulate_slow_disk(monkeypatch, log_path)

    t0 = time.perf_counter()
    tick_times = asyncio.run(_run_with_concurrent_marker(server_main.get_task_output("big-task")))

    first_tick_delay = tick_times[0] - t0
    assert first_tick_delay < BLOCKING_READ_SECONDS / 2, (
        f"marker 的第一次 tick 延迟了 {first_tick_delay:.3f}s，"
        f"说明 get_task_output 同步阻塞了事件循环（模拟的慢读取耗时 {BLOCKING_READ_SECONDS}s）"
    )


def test_get_logs_returns_log_content(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    ws = tmp_path / "workspace"
    ws.mkdir()
    _use_scheduler(monkeypatch, ws)
    _make_task_with_log(ws, "t1")

    result = asyncio.run(server_main.get_logs("t1"))
    assert "hello world" in result


def test_get_logs_missing_file_raises_404(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    ws = tmp_path / "workspace"
    ws.mkdir()
    _use_scheduler(monkeypatch, ws)

    with pytest.raises(Exception) as exc_info:
        asyncio.run(server_main.get_logs("does-not-exist"))
    assert getattr(exc_info.value, "status_code", None) == 404


@pytest.mark.parametrize("mode", ["skip_bytes", "tail"])
@pytest.mark.parametrize("trailing_newline", [True, False])
def test_stream_logs_reassembles_initial_partial_image_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mode: str, trailing_newline: bool,
) -> None:
    _use_scheduler(monkeypatch, tmp_path)
    log_path = _make_task_with_log(tmp_path, "image-stream")
    task = server_main.scheduler.get_task("image-stream")
    assert task is not None
    task.update_status(TaskStatus.running, server_main.scheduler.tasks_dir)
    header = b"=== CoderFleet Task Log ===\n"
    previous = b'{"type":"system","subtype":"init"}\n'
    event = json.dumps({"type": "user", "message": {"content": [{
        "type": "tool_result", "tool_use_id": "image", "content": [
            {"type": "text", "text": "图片说明"},
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "aZ09+/" * 16000}},
        ],
    }]}}, ensure_ascii=False).encode("utf-8")
    split_at = event.index("图片说明".encode("utf-8")) + 1
    log_path.write_bytes(header + previous + event[:split_at])

    async def drive() -> list[str]:
        response = await server_main.stream_logs(
            task.id, tail=1 if mode == "tail" else 0,
            skip_bytes=len(header) if mode == "skip_bytes" else 0,
        )
        iterator = response.body_iterator
        try:
            assert await anext(iterator) == "data: " + previous.decode().rstrip() + "\n\n"
            with log_path.open("ab") as stream:
                stream.write(event[split_at:] + (b"\n" if trailing_newline else b""))
            task.update_status(TaskStatus.done, server_main.scheduler.tasks_dir)
            return [frame async for frame in iterator]
        finally:
            await iterator.aclose()

    frames = asyncio.run(asyncio.wait_for(drive(), timeout=3))
    assert frames == ["data: " + event.decode("utf-8") + "\n\n", "data: [DONE]\n\n"]


def test_stream_logs_does_not_reread_growth_between_stat_and_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _use_scheduler(monkeypatch, tmp_path)
    log_path = _make_task_with_log(tmp_path, "growing-stream")
    task = server_main.scheduler.get_task("growing-stream")
    assert task is not None
    task.update_status(TaskStatus.running, server_main.scheduler.tasks_dir)
    header = b"=== CoderFleet Task Log ===\n"
    previous = b'{"type":"system","subtype":"init"}\n'
    event = b'{"type":"user","message":{"content":[]}}\n'
    split_at = 15
    log_path.write_bytes(header + previous)
    real_open = aiofiles.open
    grow_on_read = False

    def opening(file, mode="r", *args, **kwargs):
        nonlocal grow_on_read
        if Path(file) == log_path and mode == "rb" and grow_on_read:
            grow_on_read = False
            with log_path.open("ab") as stream:
                stream.write(event[split_at:])
        return real_open(file, mode, *args, **kwargs)

    monkeypatch.setattr(aiofiles, "open", opening)

    async def drive() -> list[str]:
        nonlocal grow_on_read
        response = await server_main.stream_logs(task.id, tail=0, skip_bytes=len(header))
        iterator = response.body_iterator
        try:
            await anext(iterator)
            with log_path.open("ab") as stream:
                stream.write(event[:split_at])
            grow_on_read = True
            first = await anext(iterator)
            task.update_status(TaskStatus.done, server_main.scheduler.tasks_dir)
            return [first] + [frame async for frame in iterator]
        finally:
            await iterator.aclose()

    frames = asyncio.run(asyncio.wait_for(drive(), timeout=3))
    assert frames == ["data: " + event.decode().rstrip() + "\n\n", "data: [DONE]\n\n"]
