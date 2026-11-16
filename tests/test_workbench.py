"""Work views reuse ordinary conversations without creating another execution path."""
from __future__ import annotations

import asyncio
from datetime import timedelta
from pathlib import Path

import httpx
import pytest

from coderfleet.server import main as server_main
from coderfleet.server.models import AccountType, Board, BoardCard, Conversation, ConversationStatus, Task, WorkflowRun, utc_now
from coderfleet.server.runtime import FakeRuntime
from coderfleet.server.scheduler import Scheduler


@pytest.fixture
def workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Scheduler:
    (tmp_path / "projects.conf").write_text(
        f"NAME=mobile ACCOUNT=alice PATH={tmp_path / 'mobile'}\n", encoding="utf-8",
    )
    scheduler = Scheduler(tmp_path, runtime=FakeRuntime())
    monkeypatch.setattr(server_main, "scheduler", scheduler)
    return scheduler


def request(path: str) -> httpx.Response:
    async def get() -> httpx.Response:
        transport = httpx.ASGITransport(app=server_main.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.get(path, headers={"Authorization": f"Bearer {server_main._api_key}"})
    return asyncio.run(get())


def conversation(scheduler: Scheduler, identifier: str = "conv-1") -> Conversation:
    record = Conversation(
        id=identifier, name="分享实现在哪里？", account="alice", type=AccountType.claude,
        project=str(scheduler.workspace_dir / "mobile"), project_name="mobile",
    )
    record.save(scheduler.conversations_dir)
    return record


def task(scheduler: Scheduler, identifier: str = "task-1", **overrides: object) -> Task:
    values: dict[str, object] = {
        "id": identifier, "status": "done", "account": "alice", "type": "claude",
        "prompt": "说明分享实现", "project": str(scheduler.workspace_dir / "mobile"),
        "project_name": "mobile", "conversation_id": "conv-1",
        "created": "2026-11-15T09:00:00+00:00",
    }
    values.update(overrides)
    record = Task.model_validate(values)
    record.save(scheduler.tasks_dir)
    return record


def test_project_chat_appears_without_a_card_and_reading_does_not_create_work(workspace: Scheduler) -> None:
    conversation(workspace)
    task(workspace)
    before = {path.relative_to(workspace.workspace_dir): path.read_bytes()
              for path in workspace.workspace_dir.rglob("*") if path.is_file()}

    response = request("/api/workbench")

    assert response.status_code == 200, response.text
    data = response.json()
    assert data["total"] == 1
    assert data["items"][0]["conversation_id"] == "conv-1"
    assert data["items"][0]["card_id"] == ""
    assert data["items"][0]["status"] == "done"
    assert data["items"][0]["attention"] == []
    assert data["counts"]["review"] == 0
    after = {path.relative_to(workspace.workspace_dir): path.read_bytes()
             for path in workspace.workspace_dir.rglob("*") if path.is_file()}
    assert after == before


def test_inbox_opens_the_running_question_even_with_a_newer_queued_turn(workspace: Scheduler) -> None:
    conversation(workspace)
    task(workspace, "asking", status="running", pending_intervention={
        "kind": "native", "tool_call_id": "question-1", "token": "do-not-return-token",
        "deadline": (utc_now() + timedelta(minutes=10)).isoformat(),
        "questions": [{"question": "需要支持哪些系统？", "header": "平台", "options": []}],
    })
    task(workspace, "queued", status="pending", created="2026-11-15T10:00:00+00:00")

    response = request("/api/workbench?view=attention")

    assert response.status_code == 200
    data = response.json()
    assert data["total"] == 1
    assert data["items"][0]["task_id"] == "asking"
    assert data["items"][0]["queued_count"] == 1
    assert data["items"][0]["attention"][0] == {
        "kind": "question", "label": "待回答", "detail": "需要支持哪些系统？", "task_id": "asking",
        "card_id": "", "board_id": "",
    }
    assert "do-not-return-token" not in response.text


def test_existing_card_enriches_its_conversation_and_only_explicit_review_is_actionable(workspace: Scheduler) -> None:
    conversation(workspace)
    task(workspace)
    Board(id="board-1", name="功能改造").save(workspace.boards_dir)
    BoardCard(
        id="card-1", board_id="board-1", title="分享页修复", project_name="mobile",
        conversation_id="conv-1", status="review",
    ).save(workspace.board_cards_dir)
    BoardCard(
        id="card-empty", board_id="board-1", title="下个需求", project_name="mobile",
    ).save(workspace.board_cards_dir)

    all_work = request("/api/workbench").json()
    inbox = request("/api/workbench?view=attention").json()

    assert all_work["total"] == 2
    assert inbox["total"] == 1
    item = inbox["items"][0]
    assert item["conversation_id"] == "conv-1"
    assert item["card_id"] == "card-1"
    assert item["title"] == "分享页修复"
    assert item["status"] == "review"
    assert item["attention"][0]["kind"] == "review"
    assert item["task_count"] == 1


def test_workflow_approval_is_one_work_and_keeps_legacy_task_linkage(workspace: Scheduler) -> None:
    conversation(workspace)
    task(workspace, pipeline_id="legacy-1", conversation_id="")
    WorkflowRun(
        id="run-1", name="协议兼容检查", status="waiting_approval", legacy_pipeline_id="legacy-1",
        default_account="alice", project_map={"client": "mobile"},
        pending_approval_node_id="approve-1", approval_token="private-approval",
        node_executions=[{"node_id": "check-1", "task_id": "task-1", "state": "succeeded"}],
    ).save(workspace.workflow_runs_dir)

    response = request("/api/workbench?view=attention&project_name=mobile")

    assert response.status_code == 200
    data = response.json()
    assert data["total"] == 1
    assert data["items"][0]["workflow_run_id"] == "run-1"
    assert data["items"][0]["task_count"] == 1
    assert data["items"][0]["attention"][0]["kind"] == "approval"
    assert "private-approval" not in response.text
    assert sum(item["task_count"] for item in request("/api/workbench").json()["items"]) == 1


def test_resolved_failures_expired_questions_and_archived_records_leave_the_inbox(workspace: Scheduler) -> None:
    conversation(workspace)
    task(workspace, "failed-before", status="failed")
    task(workspace, "recovered", status="done", created="2026-11-15T10:00:00+00:00")
    expired = conversation(workspace, "expired")
    task(workspace, "expired-question", status="running", conversation_id=expired.id, pending_intervention={
        "tool_call_id": "old-question", "token": "private",
        "deadline": (utc_now() - timedelta(minutes=1)).isoformat(), "questions": [],
    })
    archived = conversation(workspace, "archived")
    archived.status = ConversationStatus.archived
    archived.save(workspace.conversations_dir)
    task(workspace, "archived-failure", status="failed", conversation_id=archived.id)
    task(workspace, "platform-failure", status="failed", platform_run_id="report-1")
    task(workspace, "hidden-task", status="failed", archived=True)

    assert request("/api/workbench?view=attention").json()["items"] == []
    rows = request("/api/workbench").json()["items"]
    assert {row["conversation_id"] for row in rows} == {"conv-1", "expired"}


def test_project_filter_pagination_and_unknown_projects_are_explicit(workspace: Scheduler) -> None:
    conversation(workspace)
    task(workspace)
    task(workspace, "one-off", conversation_id="", status="running")
    response = request("/api/workbench?project_name=mobile&limit=1&offset=1")
    assert response.status_code == 200
    assert response.json()["total"] == 2
    assert len(response.json()["items"]) == 1
    assert response.json()["counts"]["running"] == 1
    assert request("/api/workbench?project_name=missing").status_code == 404
    assert request("/api/workbench?limit=0").status_code == 422
    assert request("/api/workbench?view=unknown").status_code == 422


def test_a_broken_card_reference_remains_visible_without_opening_another_conversation(workspace: Scheduler) -> None:
    Board(id="board-1", name="功能改造").save(workspace.boards_dir)
    BoardCard(
        id="broken", board_id="board-1", title="待恢复专题", project_name="mobile",
        conversation_id="deleted-conversation", status="review",
    ).save(workspace.board_cards_dir)
    response = request("/api/workbench?view=attention")
    assert response.status_code == 200
    assert response.json()["total"] == 1
    item = response.json()["items"][0]
    assert item["board_id"] == "board-1"
    assert item["card_id"] == "broken"
    assert item["conversation_id"] == ""
    assert item["attention"][0]["kind"] == "blocked"
