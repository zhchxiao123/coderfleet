"""Read-only work and attention views over the existing execution records."""
from __future__ import annotations

from functools import lru_cache
from typing import TYPE_CHECKING, Literal, TypedDict

from pydantic import BaseModel, Field

from coderfleet.server.models import BoardCard, Conversation, Task, TaskStatus, WorkflowRun, now_iso, parse_iso, utc_now

if TYPE_CHECKING:
    from coderfleet.server.scheduler import Scheduler


class WorkAttention(BaseModel):
    kind: Literal["question", "permission", "approval", "review", "blocked"]
    label: str
    detail: str = ""
    task_id: str = ""
    card_id: str = ""
    board_id: str = ""


class WorkItem(BaseModel):
    id: str
    kind: Literal["conversation", "task", "workflow", "card"]
    title: str
    project_names: list[str] = Field(default_factory=list)
    account: str = ""
    status: str = "idle"
    updated: str
    conversation_id: str = ""
    workflow_run_id: str = ""
    task_id: str = ""
    card_id: str = ""
    board_id: str = ""
    task_count: int = 0
    queued_count: int = 0
    attention: list[WorkAttention] = Field(default_factory=list)


class WorkbenchResponse(BaseModel):
    items: list[WorkItem]
    total: int
    counts: dict[str, int]
    projects: list[str]
    offset: int
    limit: int
    generated_at: str


def _current_task(tasks: list[Task]) -> Task | None:
    ordered = sorted(tasks, key=lambda task: (parse_iso(task.created), task.id), reverse=True)
    return next((task for task in ordered if task.status == TaskStatus.running), None) or next(
        (task for task in ordered if task.status in (TaskStatus.pending, TaskStatus.scheduled)), None,
    ) or next(iter(ordered), None)


def _task_attention(tasks: list[Task], *, include_failure: bool = True) -> list[WorkAttention]:
    attention = []
    for task in tasks:
        pending = task.pending_intervention
        if task.status != TaskStatus.running or pending is None:
            continue
        try:
            if parse_iso(pending.deadline) <= utc_now():
                continue
        except ValueError:
            continue
        permission = pending.kind == "permission"
        detail = pending.tool_name if permission else "；".join(question.question for question in pending.questions)
        attention.append(WorkAttention(
            kind="permission" if permission else "question", label="待授权" if permission else "待回答",
            detail=detail[:400], task_id=task.id,
        ))
    current = _current_task(tasks)
    if include_failure and current and current.status == TaskStatus.failed:
        attention.append(WorkAttention(kind="blocked", label="执行失败", detail="查看原运行后决定重试或继续", task_id=current.id))
    return attention


class TaskFields(TypedDict):
    status: str
    task_id: str
    task_count: int
    queued_count: int
    attention: list[WorkAttention]


def _task_fields(tasks: list[Task]) -> TaskFields:
    current = _current_task(tasks)
    return {
        "status": current.status.value if current else "idle",
        "task_id": current.id if current else "", "task_count": len(tasks),
        "queued_count": sum(task.status in (TaskStatus.pending, TaskStatus.scheduled) for task in tasks),
        "attention": _task_attention(tasks),
    }


def _apply_cards(item: WorkItem, cards: list[BoardCard]) -> None:
    if not cards:
        return
    cards = sorted(cards, key=lambda card: (parse_iso(card.updated), card.id), reverse=True)
    primary = next((card for card in cards if card.status.value == "review"), cards[0])
    item.card_id, item.board_id, item.title = primary.id, primary.board_id, primary.title
    item.project_names = sorted(set(item.project_names + [card.project_name for card in cards if card.project_name]))
    if item.status not in ("running", "pending", "scheduled", "waiting_approval"):
        item.status = primary.status.value
    for card in cards:
        if card.status.value in ("review", "blocked"):
            kind: Literal["review", "blocked"] = "review" if card.status.value == "review" else "blocked"
            item.attention.append(WorkAttention(
                kind=kind, label="待验收" if kind == "review" else "工作受阻", detail=card.title,
                task_id=item.task_id, card_id=card.id, board_id=card.board_id,
            ))


def read_workbench(
    scheduler: Scheduler, project_name: str = "", view: str = "all", offset: int = 0, limit: int = 50,
) -> WorkbenchResponse:
    projects = scheduler.list_projects()
    if project_name and not any(project.name == project_name for project in projects):
        raise KeyError(f"项目 '{project_name}' 不存在")
    tasks = [task for task in scheduler.list_tasks() if not task.archived and not task.platform_run_id]
    cards = [card for card in BoardCard.load_all(scheduler.board_cards_dir) if not card.archived]
    conversations = Conversation.load_all(scheduler.conversations_dir)
    archived = {conversation.id for conversation in conversations if conversation.status.value == "archived"}
    tasks = [task for task in tasks if task.conversation_id not in archived]

    @lru_cache(maxsize=None)
    def project_for(name: str, path: str, account: str) -> str:
        if name:
            return name
        owner = scheduler.find_project_for_path(path, account)
        return owner.name if owner else ""

    items: list[WorkItem] = []
    assigned: set[str] = set()
    claimed_cards: set[str] = set()
    shared_conversations: set[str] = set()
    for run in WorkflowRun.load_all(scheduler.workflow_runs_dir):
        node_ids = {node.task_id for node in run.node_executions if node.task_id}
        pipeline_ids = {run.id, run.legacy_pipeline_id} - {""}
        scoped = [task for task in tasks if task.id in node_ids or task.pipeline_id in pipeline_ids]
        assigned.update(task.id for task in scoped)
        if run.shared_conversation_id:
            shared_conversations.add(run.shared_conversation_id)
        names = set(run.project_map.values()) | {node.project_name for node in run.node_executions}
        names.update(project_for(task.project_name, task.project, task.account) for task in scoped)
        item = WorkItem(
            id=f"workflow:{run.id}", kind="workflow", title=run.name or "工作流运行",
            project_names=sorted(names - {""}), account=run.default_account,
            updated=run.updated, workflow_run_id=run.id, **_task_fields(scoped),
        )
        item.status = run.status
        item.attention = _task_attention([task for task in scoped if task.id in node_ids], include_failure=False)
        if run.status == "waiting_approval" and run.pending_approval_node_id:
            item.attention.append(WorkAttention(kind="approval", label="待审批", detail="打开原工作流查看并审批"))
        elif run.status in ("failed", "partial"):
            item.attention.append(WorkAttention(kind="blocked", label="工作流受阻", detail="查看失败节点和依赖"))
        linked = [card for card in cards if card.pipeline_id in pipeline_ids
                  or (run.shared_conversation_id and card.conversation_id == run.shared_conversation_id)]
        _apply_cards(item, linked)
        claimed_cards.update(card.id for card in linked)
        items.append(item)
    for conversation in conversations:
        if conversation.id in archived:
            continue
        scoped = [task for task in tasks if task.conversation_id == conversation.id and task.id not in assigned]
        assigned.update(task.id for task in scoped)
        if not scoped and conversation.id in shared_conversations:
            continue
        current = _current_task(scoped)
        owner = project_for(conversation.project_name, conversation.project, conversation.account)
        item = WorkItem(
            id=f"conversation:{conversation.id}", kind="conversation", title=conversation.name,
            project_names=[owner] if owner else [], account=conversation.account,
            updated=(current.finished or current.created) if current else conversation.updated,
            conversation_id=conversation.id, **_task_fields(scoped),
        )
        linked = [card for card in cards if card.conversation_id == conversation.id and not card.pipeline_id]
        _apply_cards(item, linked)
        claimed_cards.update(card.id for card in linked)
        items.append(item)
    for task in tasks:
        if task.id in assigned:
            continue
        owner = project_for(task.project_name, task.project, task.account)
        items.append(WorkItem(
            id=f"task:{task.id}", kind="task", title=task.prompt[:180],
            project_names=[owner] if owner else [], account=task.account,
            updated=task.finished or task.created, **_task_fields([task]),
        ))
    for card in cards:
        if card.id in claimed_cards or card.conversation_id in archived:
            continue
        item = WorkItem(
            id=f"card:{card.id}", kind="card", title=card.title, updated=card.updated,
            project_names=[card.project_name] if card.project_name else [],
        )
        _apply_cards(item, [card])
        if card.conversation_id or card.pipeline_id:
            item.status = "blocked"
            item.attention = [WorkAttention(
                kind="blocked", label="关联记录不可用", detail="打开原专题检查执行引用，不会自动切换其他会话",
                card_id=card.id, board_id=card.board_id,
            )]
        items.append(item)
    if project_name:
        items = [item for item in items if project_name in item.project_names]
    counts = {
        "all": len(items), "attention": sum(bool(item.attention) for item in items),
        "running": sum(item.status == "running" for item in items),
        "review": sum(any(attention.kind == "review" for attention in item.attention) for item in items),
        "blocked": sum(any(attention.kind == "blocked" for attention in item.attention) for item in items),
    }
    if view == "attention":
        items = [item for item in items if item.attention]
    elif view == "running":
        items = [item for item in items if item.status == "running"]
    elif view in ("review", "blocked"):
        items = [item for item in items if any(attention.kind == view for attention in item.attention)]
    items.sort(key=lambda item: (bool(item.attention), item.status == "running", parse_iso(item.updated), item.id), reverse=True)
    return WorkbenchResponse(
        items=items[offset:offset + limit], total=len(items), counts=counts,
        projects=[project.name for project in projects], offset=offset, limit=limit,
        generated_at=now_iso(),
    )
