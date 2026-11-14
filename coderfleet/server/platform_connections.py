"""Explicit remote MCP connections, resolved from the selected account only."""

from __future__ import annotations
import json
from pathlib import Path
from typing import Any

from coderfleet.data.scripts.coderfleet_platform_tools import validate_connections


def _configured(workspace: Path, account: str) -> dict[str, Any]:
    servers: dict[str, Any] = {}
    for name in ("settings.json", ".claude.json"):
        path = workspace / "accounts" / account / name
        if not path.exists():
            continue
        if path.stat().st_size > 16 * 1024 * 1024:
            raise ValueError("账号 MCP 配置过大")
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (ValueError, OSError) as error:
            raise ValueError("无法读取账号 MCP 配置") from error
        if not isinstance(data, dict):
            raise ValueError("账号 MCP 配置格式无效")
        servers.update(data.get("mcpServers", {}))
        if name == ".claude.json":
            servers.update(
                data.get("projects", {}).get("/workspace", {}).get("mcpServers", {})
            )
    return servers


def available_connections(workspace: Path, account: str) -> list[dict[str, Any]]:
    result = []
    for name, server in sorted(_configured(workspace, account).items()):
        supported = True
        try:
            validate_connections({name: server})
        except ValueError:
            supported = False
        result.append(
            {
                "name": name,
                "type": server.get("type", "stdio")
                if isinstance(server, dict)
                else "invalid",
                "supported": supported,
            }
        )
    return result


def resolve_connections(
    workspace: Path, account: str, names: list[str]
) -> dict[str, Any]:
    if "fleet" in names:
        raise ValueError("fleet 是平台检索服务保留名称")
    if not names:
        return {}
    servers = _configured(workspace, account)
    if set(names) - set(servers):
        raise ValueError("选中的 MCP 已不在该账号配置中，请重新选择")
    return validate_connections({name: servers[name] for name in names})
