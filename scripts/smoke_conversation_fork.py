"""Opt-in real Claude fork check. Creates only new test sessions; never resumes user sessions."""
from __future__ import annotations

import argparse
import json
import shlex
import subprocess
import uuid
from pathlib import Path

from coderfleet.account_type_registry import _build_claude


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--container", required=True)
    parser.add_argument("--model", default="haiku")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    run_id = uuid.uuid4().hex[:10]
    words = [f"CODEWORD_{part}_{run_id}" for part in "ABC"]
    workdir = f"/tmp/coderfleet-fork-smoke-{run_id}"
    subprocess.run(["docker", "exec", args.container, "mkdir", "-p", workdir], check=True)

    def query(label: str, prompt: str, session: str = "", checkpoint: str = "", target: str = "") -> list[dict]:
        # Exercise the same Claude command builder used by the scheduler. Replace
        # the permissions/MCP preamble with a tool-free, hook-free test invocation.
        command = _build_claude(prompt, True, label, label, label, session, [], args.model,
                               fork_session_id=target, resume_session_at=checkpoint)
        flags = (f"--tools {shlex.quote('')} --strict-mcp-config "
                 f"--settings {shlex.quote(json.dumps({'disableAllHooks': True}))} --max-turns 1")
        command = command.replace("--dangerously-skip-permissions", flags)
        result = subprocess.run(["docker", "exec", "-w", workdir, args.container, "bash", "-c", command],
                                capture_output=True, text=True, timeout=150)
        (args.output / f"{label}.jsonl").write_text(result.stdout, encoding="utf-8")
        events = []
        for line in result.stdout.splitlines():
            try:
                events.append(json.loads(line))
            except ValueError:
                continue
        final = next((e for e in reversed(events) if e.get("type") == "result"), {})
        if result.returncode or final.get("is_error") or final.get("subtype") != "success":
            raise RuntimeError(f"{label} failed (exit={result.returncode}): {result.stderr[-500:]} {str(final)[:500]}")
        print(f"{label}: success", flush=True)
        return events

    a = query("A", f"Remember this exact token: {words[0]}. Reply only OK.")
    session = next(e["session_id"] for e in a if e.get("session_id"))
    b = query("B", f"Also remember {words[1]}. Reply only OK.", session)
    checkpoint = [e["uuid"] for e in b if e.get("type") == "assistant" and not e.get("parent_tool_use_id")][-1]
    query("C", f"Also remember {words[2]}. Reply only OK.", session)
    target = str(uuid.uuid4())
    question = "List all CODEWORD_ tokens previously given by me, exactly. Output the tokens only."
    branch = query("fork-B", question, session, checkpoint, target)
    branch_id = next(e["session_id"] for e in branch if e.get("session_id"))
    assert branch_id == target and branch_id != session

    def text(events: list[dict]) -> str:
        return "\n".join(e.get("result", "") for e in events if e.get("type") == "result")

    assert words[0] in text(branch) and words[1] in text(branch) and words[2] not in text(branch)
    parent = query("parent-followup", question, session)
    assert all(word in text(parent) for word in words)
    followup = query("branch-followup", question, branch_id)
    assert words[0] in text(followup) and words[1] in text(followup) and words[2] not in text(followup)
    (args.output / "result.json").write_text(json.dumps({"passed": True, "source_session_id": session,
        "target_session_id": target, "message_uuid": checkpoint, "model": args.model}, indent=2) + "\n")
    print("PASS: fork at B excludes C; parent and branch resume independently", flush=True)


if __name__ == "__main__":
    main()
