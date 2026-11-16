"""Operator-authenticated work views; these routes never create execution records."""
from __future__ import annotations

from typing import Callable, Literal

from fastapi import APIRouter, HTTPException, Query
from fastapi.concurrency import run_in_threadpool

from coderfleet.server.scheduler import Scheduler
from coderfleet.server.workbench import WorkbenchResponse, read_workbench


def build_workbench_router(get_scheduler: Callable[[], Scheduler]) -> APIRouter:
    router = APIRouter(prefix="/api/workbench")

    @router.get("", response_model=WorkbenchResponse)
    async def list_work(
        project_name: str = "", view: Literal["all", "attention", "running", "review", "blocked"] = "all",
        offset: int = Query(default=0, ge=0), limit: int = Query(default=50, ge=1, le=200),
    ) -> WorkbenchResponse:
        try:
            return await run_in_threadpool(read_workbench, get_scheduler(), project_name, view, offset, limit)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=error.args[0]) from error

    return router
