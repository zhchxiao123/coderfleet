"""Authenticated operator entry points for the platform harness."""

from __future__ import annotations

from typing import Any, Callable

from fastapi import APIRouter, HTTPException, Query
from fastapi.concurrency import run_in_threadpool

from coderfleet.server.platform_agent import (
    PlatformConflict,
    PlatformHarness,
    PlatformRequest,
    PlatformSettings,
)
from coderfleet.server.scheduler import Scheduler


def build_platform_router(get_scheduler: Callable[[], Scheduler]) -> APIRouter:
    router = APIRouter(prefix="/api/platform")

    def harness() -> PlatformHarness:
        return PlatformHarness(get_scheduler())

    def failure(error: Exception) -> HTTPException:
        return HTTPException(
            status_code=404
            if isinstance(error, KeyError)
            else 409
            if isinstance(error, PlatformConflict)
            else 422,
            detail=str(error),
        )

    @router.get("")
    async def info() -> dict[str, Any]:
        return await run_in_threadpool(harness().info)

    @router.put("/settings")
    async def configure(settings: PlatformSettings) -> dict[str, Any]:
        try:
            return await run_in_threadpool(harness().configure, settings)
        except ValueError as error:
            raise failure(error) from error

    @router.post("/preview")
    async def preview(request: PlatformRequest) -> dict[str, Any]:
        try:
            return await run_in_threadpool(harness().preview, request)
        except ValueError as error:
            raise failure(error) from error

    @router.post("/runs", status_code=201)
    async def create(request: PlatformRequest) -> dict[str, Any]:
        try:
            return await harness().create(request)
        except ValueError as error:
            raise failure(error) from error

    @router.get("/runs")
    async def runs(date: str = "", summary: bool = False) -> list[dict[str, Any]]:
        return await run_in_threadpool(harness().list, date, summary)

    @router.get("/requests")
    async def lookup(
        request_id: str = Query(min_length=1, max_length=128),
    ) -> dict[str, Any]:
        import hashlib

        try:
            return await run_in_threadpool(
                harness().get, hashlib.sha256(request_id.encode()).hexdigest()[:32]
            )
        except (ValueError, KeyError) as error:
            raise failure(error) from error

    @router.get("/runs/{identifier}")
    async def get(identifier: str) -> dict[str, Any]:
        try:
            return await run_in_threadpool(harness().get, identifier)
        except (ValueError, KeyError) as error:
            raise failure(error) from error

    @router.get("/runs/{identifier}/thread")
    async def thread(identifier: str) -> list[dict[str, Any]]:
        try:
            return await run_in_threadpool(harness().thread, identifier)
        except (ValueError, KeyError) as error:
            raise failure(error) from error

    @router.get("/runs/{identifier}/sources/{source_id}")
    async def source(identifier: str, source_id: str) -> dict[str, Any]:
        try:
            return await run_in_threadpool(harness().source, identifier, source_id)
        except (ValueError, KeyError) as error:
            raise failure(error) from error

    @router.post("/runs/{identifier}/cancel")
    async def cancel(identifier: str) -> dict[str, Any]:
        try:
            return await harness().cancel(identifier)
        except (ValueError, KeyError) as error:
            raise failure(error) from error

    return router
