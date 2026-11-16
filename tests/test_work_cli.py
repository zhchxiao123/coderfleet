"""The CLI consumes the same authenticated work view as the Web UI."""
import json

import httpx
from click.testing import CliRunner

from coderfleet.cli import main


def test_work_inbox_uses_scoped_operator_api_and_exposes_original_task(monkeypatch) -> None:
    monkeypatch.setenv("CODERFLEET_API", "http://test")
    monkeypatch.setenv("CODERFLEET_API_KEY", "test-key")
    calls = []

    def get(url, **kwargs):
        if url.endswith("/api/health"):
            return httpx.Response(200, json={"status": "ok"}, request=httpx.Request("GET", url))
        calls.append((url, kwargs))
        payload = {"items": [{
            "id": "conversation:conv-1", "title": "分享页修复", "status": "running",
            "project_names": ["mobile"], "conversation_id": "conv-1", "task_id": "task-1",
            "attention": [{"kind": "question", "label": "待回答", "detail": "选择支持的平台"}],
        }], "total": 1, "offset": 0, "limit": 50}
        return httpx.Response(200, json=payload, request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx, "get", get)
    result = CliRunner().invoke(main, ["work", "inbox", "--project", "mobile", "--json"])

    assert result.exit_code == 0, result.output
    assert json.loads(result.output)["items"][0]["task_id"] == "task-1"
    assert calls[0][0] == "http://test/api/workbench"
    assert calls[0][1]["params"]["view"] == "attention"
    assert calls[0][1]["params"]["project_name"] == "mobile"
    assert calls[0][1]["headers"] == {"Authorization": "Bearer test-key"}
