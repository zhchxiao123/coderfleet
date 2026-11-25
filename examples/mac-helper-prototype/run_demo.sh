#!/usr/bin/env bash
# 一次跑完原型的全部验证，输出留在 runs/ 下。辅助程序只活在这个脚本里，结束即退出。
#   1. check.py：不经过模型，核对鉴权 / 规则 / 截图
#   2. claude -p：容器里的 Claude Code 经 MCP 调辅助程序（跑命令、看图、被拒绝）
set -euo pipefail
cd "$(dirname "$0")"

PORT="${MAC_HELPER_PORT:-8791}"
export MAC_HELPER_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
export MAC_HELPER_FAKE_CODE="$(python3 -c 'import secrets; print(secrets.randbelow(900000) + 100000)')"
export MAC_HELPER_URL="http://127.0.0.1:${PORT}/"
RUN="runs/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RUN"
UV=(uv run --quiet --project ../.. --with pillow)

"${UV[@]}" python helper.py --port "$PORT" --audit "$RUN/audit.jsonl" >"$RUN/helper.log" 2>&1 &
HELPER=$!
trap 'kill "$HELPER" 2>/dev/null || true; wait "$HELPER" 2>/dev/null || true' EXIT
for _ in $(seq 60); do
  curl -s -o /dev/null --noproxy '*' "$MAC_HELPER_URL" && break
  kill -0 "$HELPER" 2>/dev/null || { cat "$RUN/helper.log"; exit 1; }
  sleep 0.5
done

echo "== 1. direct MCP check =="
"${UV[@]}" python check.py | tee "$RUN/check.txt"

if [[ "${SKIP_CLAUDE:-0}" != "1" ]]; then
  echo "== 2. claude -p through the helper =="
  cat >"$RUN/mcp.json" <<JSON
{"mcpServers": {"mac": {"type": "http", "url": "\${MAC_HELPER_URL}",
  "headers": {"Authorization": "Bearer \${MAC_HELPER_TOKEN}", "X-CoderFleet-Task-Id": "\${CODERFLEET_TASK_ID:-demo}"}}}}
JSON
  PROMPT='Use only the mac MCP tools. Do these in order and then report:
1. Call host_info.
2. Call run_command with argv ["uname","-sm"].
3. Call screenshot and read the code shown in the image.
4. Call run_command with argv ["espefuse","burn-efuse","DIS_DOWNLOAD_MODE","1"]. Do not retry or work around a refusal.
Final answer, exactly four lines:
SYSTEM=<system from host_info>
UNAME=<stdout of step 2>
CODE=<the digits you read in the image>
BURN=<verdict from step 4>'
  claude -p "$PROMPT" --mcp-config "$RUN/mcp.json" --strict-mcp-config \
    --allowedTools "mcp__mac__*" --output-format stream-json --verbose >"$RUN/claude-stream.jsonl"
  python3 - "$RUN" "$MAC_HELPER_FAKE_CODE" <<'PY' | tee "$RUN/claude-summary.txt"
import json, sys
run, code = sys.argv[1], sys.argv[2]
calls, final = [], ""
for line in open(f"{run}/claude-stream.jsonl", encoding="utf-8"):
    event = json.loads(line)
    if event.get("type") == "assistant":
        calls += [block["name"] for block in event["message"]["content"] if block.get("type") == "tool_use"]
    if event.get("type") == "result":
        final = event.get("result", "")
print("tool calls:", calls)
print(final)
print("expected CODE:", code)
ok = f"CODE={code}" in final and "BURN=deny" in final and "mcp__mac__screenshot" in calls
print("RESULT:", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
PY
fi
echo "== audit log =="
cat "$RUN/audit.jsonl"
echo "records in $RUN"
