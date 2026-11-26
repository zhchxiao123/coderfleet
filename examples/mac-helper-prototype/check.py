"""不经过模型的自检：用 MCP 客户端直接调辅助程序，核对鉴权、规则、截图、审计。"""
import asyncio
import json
import os
import sys

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

URL = os.environ["MAC_HELPER_URL"]
TOKEN = os.environ["MAC_HELPER_TOKEN"]
failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}")
    if not ok:
        failures.append(name)


def payload(result) -> dict:
    return json.loads(result.content[0].text)


async def main() -> None:
    async with httpx.AsyncClient() as http:
        reply = await http.post(URL, json={}, headers={"Authorization": "Bearer wrong"})
        check("wrong token is rejected", reply.status_code == 401, f"HTTP {reply.status_code}")
        reply = await http.post(URL, json={})
        check("missing token is rejected", reply.status_code == 401, f"HTTP {reply.status_code}")

    headers = {"Authorization": f"Bearer {TOKEN}", "X-CoderFleet-Task-Id": "check-task"}
    async with streamablehttp_client(URL, headers=headers) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            names = sorted(tool.name for tool in (await session.list_tools()).tools)
            check("tools listed", names == ["host_info", "run_command", "screenshot", "serial_ports"], str(names))

            ok = payload(await session.call_tool("run_command", {"argv": ["uname", "-s"]}))
            check("allowed command runs", ok.get("ran") and ok.get("exit_code") == 0, json.dumps(ok))

            burn = payload(await session.call_tool("run_command", {"argv": ["espefuse", "burn-efuse", "DIS_DOWNLOAD_MODE", "1"]}))
            check("efuse burn is denied", burn.get("ran") is False and burn.get("verdict") == "deny" and "espefuse" in burn.get("rule", ""), json.dumps(burn))

            flash = payload(await session.call_tool("run_command", {"argv": ["esptool", "write-flash", "0x0", "merged.bin"]}))
            check("flash without a human's approval does not run", flash.get("ran") is False and flash.get("verdict") == "deny-unconfirmed", json.dumps(flash))

            other = payload(await session.call_tool("run_command", {"argv": ["cat", "/etc/passwd"]}))
            check("unlisted command is denied", other.get("ran") is False and other.get("verdict") == "deny", json.dumps(other))

            shot = await session.call_tool("screenshot", {})
            image = shot.content[0]
            check("screenshot returns an image block", image.type == "image" and image.mimeType == "image/png" and len(image.data) > 1000, f"{image.type} {len(image.data)} base64 chars")

    sys.exit(1 if failures else 0)


asyncio.run(main())
