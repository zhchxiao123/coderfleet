"""Operator-facing, bounded title reads and explicit regeneration."""
from __future__ import annotations

import re
from typing import Callable

from fastapi import APIRouter, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from coderfleet.server.conversation_titles import TitleConflict
from coderfleet.server.models import ConversationResponse, ConversationTitleInfo
from coderfleet.server.scheduler import Scheduler


class TitleRegenerateRequest(BaseModel):
    expected_revision: int | None = Field(default=None, ge=0)
    expected_name: str | None = Field(default=None, max_length=200)


def build_title_router(get_scheduler: Callable[[], Scheduler]) -> APIRouter:
    router = APIRouter()

    @router.get("/api/conversation-titles")
    async def titles(ids: list[str] = Query(default=[])) -> list[dict]:
        if len(ids) > 50 or any(not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", identifier) for identifier in ids):
            raise HTTPException(422, "一次最多读取50个有效会话标题")
        def read() -> list[dict]:
            result = []
            for identifier in dict.fromkeys(ids):
                conv = get_scheduler().get_conversation(identifier)
                if conv is not None:
                    result.append({"id": conv.id, "name": conv.name,
                                   "title": ConversationTitleInfo(**conv.title.model_dump()).model_dump()})
            return result
        return await run_in_threadpool(read)

    @router.post("/api/conversations/{identifier}/title", response_model=ConversationResponse, status_code=202)
    async def regenerate(identifier: str, request: TitleRegenerateRequest) -> ConversationResponse:
        scheduler = get_scheduler()
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", identifier):
            raise HTTPException(422, "无效会话标识")
        if scheduler.get_conversation(identifier) is None:
            raise HTTPException(404, "会话不存在")
        try:
            conv = await run_in_threadpool(scheduler.titles.request, identifier,
                                          expected_revision=request.expected_revision,
                                          expected_name=request.expected_name)
        except TitleConflict as error:
            raise HTTPException(409, str(error)) from error
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        scheduler.titles.tick()
        return ConversationResponse.from_conversation(conv)

    return router
