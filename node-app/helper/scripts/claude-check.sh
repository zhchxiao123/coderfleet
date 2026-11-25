#!/usr/bin/env bash
# A real Claude Code session against the helper: one allowed command, one refused.
# The helper lives only inside this script. Usage: scripts/claude-check.sh [output-dir]
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="$(mkdir -p "${1:-/tmp/cfh-claude-check}" && cd "${1:-/tmp/cfh-claude-check}" && pwd)"
WORK="$(mktemp -d)"
export CODERFLEET_HELPER_HOME="$WORK/home"
mkdir -p "$WORK/project" "$WORK/bin" "$CODERFLEET_HELPER_HOME"
# `stamp` prints a code only this machine knows, so the answer proves the command ran here.
CODE="$(node -e 'console.log(require("crypto").randomInt(100000, 999999))')"
printf '#!/bin/sh\necho "stamp %s $(/usr/bin/uname -s)"\n' "$CODE" >"$WORK/bin/stamp"
printf '#!/bin/sh\necho ran >> EXECUTED\n' >"$WORK/bin/sudo"
chmod +x "$WORK/bin/stamp" "$WORK/bin/sudo"
cat >"$CODERFLEET_HELPER_HOME/policy.json" <<JSON
{"path": ["$WORK/bin"], "rules": [{"program": "stamp", "action": "allow"}, {"program": "sudo", "action": "allow"}], "gui_tools": []}
JSON

node src/main.ts serve --port 0 >"$OUT/helper.log" 2>&1 &
HELPER=$!
trap 'kill "$HELPER" 2>/dev/null || true; wait "$HELPER" 2>/dev/null || true; rm -rf "$WORK"' EXIT
for _ in $(seq 50); do [[ -f "$CODERFLEET_HELPER_HOME/run.json" ]] && break; sleep 0.1; done
PORT="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).port)' "$CODERFLEET_HELPER_HOME/run.json")"
export CFH_TOKEN="$(node src/main.ts token --root "$WORK/project" --task claude-check --label claude-check)"
export CFH_URL="http://127.0.0.1:$PORT/mcp"
cat >"$WORK/mcp.json" <<'JSON'
{"mcpServers": {"machine": {"type": "http", "url": "${CFH_URL}", "headers": {"Authorization": "Bearer ${CFH_TOKEN}"}}}}
JSON
PROMPT='Use only the machine MCP tools. Do these in order, then report:
1. Call machine_info.
2. Call run_command with argv ["stamp"].
3. Call run_command with argv ["sudo","stamp"]. Do not retry or work around a refusal.
Final answer, exactly three lines:
SYSTEM=<system from machine_info>
STAMP=<stdout of step 2>
SUDO=<verdict of step 3>/<rule of step 3>'
(cd "$WORK/project" && claude -p "$PROMPT" --mcp-config "$WORK/mcp.json" --strict-mcp-config \
  --allowedTools "mcp__machine__*" --output-format stream-json --verbose </dev/null) >"$OUT/claude-stream.jsonl"
node src/main.ts audit >"$OUT/audit.jsonl"
node - "$OUT" "$CODE" "$WORK/project/EXECUTED" <<'JS' | tee "$OUT/summary.txt"
const fs = require('fs');
const [out, code, marker] = process.argv.slice(2);
const calls = [];
let final = '';
for (const line of fs.readFileSync(out + '/claude-stream.jsonl', 'utf8').split('\n').filter(Boolean)) {
  const event = JSON.parse(line);
  if (event.type === 'assistant') for (const block of event.message.content) if (block.type === 'tool_use') calls.push(block.name);
  if (event.type === 'result') final = event.result || '';
}
const audit = fs.readFileSync(out + '/audit.jsonl', 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
console.log('tool calls:', JSON.stringify(calls));
console.log(final);
console.log('expected stamp code:', code);
console.log('audit:', JSON.stringify(audit.map(line => [line.tool, line.verdict, line.rule ?? null, line.exit_code ?? null])));
const ok = final.includes('stamp ' + code) && /SUDO=deny\/builtin:sudo/.test(final) && !fs.existsSync(marker)
  && audit.some(line => line.rule === 'stamp' && line.exit_code === 0) && audit.some(line => line.rule === 'builtin:sudo' && line.verdict === 'deny');
console.log('RESULT:', ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
JS
