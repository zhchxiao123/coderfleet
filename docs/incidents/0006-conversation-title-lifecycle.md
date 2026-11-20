# Conversation titles stayed as prompt prefixes

## Symptom

Many sidebar names were truncated first prompts, often instructions to read project guidelines or greetings. Successful naming did not reliably refresh open headers and tabs. A delayed automatic result could replace a manually chosen name.

## Causes

The browser owned a one-shot generation request after the first new chat. Readiness races and request failures were silent and had no durable retry; mobile, Telegram and CLI did not share the lifecycle. Only the first input supplied context. Automatic results were saved through the manual rename API without a revision precondition.

The wrapper allowed only 64 output tokens. The configured reasoning model consumed all 64 tokens before producing visible text in three synthetic checks. Raising the output budget recovered those checks; HTTP success alone did not prove complete usable text. Historical prefix counts describe names, not a measured model failure rate.

## Fix

The scheduler owns a persistent, bounded title lifecycle with explicit opt-in for new ordinary chats. It retains first and recent meaningful goals, accepted native supplements and bounded public replies. The shared policy validates complete single-line output, attempts 256 tokens, and retries an output-limit error once at 1024 tokens. Background concurrency is two and automatic failed attempts are finite.

Conversation mutations compare title revision, current name, source and active status under one synchronous read-modify-write lock. Manual names, deleted records, archived conversations and updated native sessions survive delayed results and stale Task objects. Restart recovery and archive/restore preserve retry accounting. Unknown legacy names require explicit regeneration.

Desktop and mobile share revision-aware metadata merging. Polling reads a bounded set of exact conversation IDs and paints title nodes without rebuilding messages or drafts. Manual-edit requests retain the draft on errors; delayed mobile operations are bound to the exact action sheet instance. CLI and Telegram use the same server policy.

## Prevention and evidence

`tests/test_conversation_titles.py` covers output-budget exhaustion, greetings and short Chinese goals, intervening topics, native supplements, manual-name conflicts, restart recovery, deletion, archive and retry budgets. `tests/test_title_routes.py` checks authenticated reads/regeneration, conflicts, public metadata and CLI parity. Scheduler/FakeRuntime cases in `tests/test_claude_sdk_conversations.py` preserve titles across CLI and SDK resume.

`tests/frontend/conversation-titles.test.cjs` replays shared, desktop and mobile functions with delayed success/failure, reopened editors, out-of-order revisions and menu refresh. It is included by `tests/test_frontend_rendering.py`. These behavioral regressions are the guard against restoring browser-owned one-shot generation or unconditional title replacement.

The research and primary-source evidence are linked from [the investigation](../research/coderfleet-conversation-titles-20261118.md). On 2026-11-19, the actual service with the configured system model passed four synthetic scenarios, including guidelines followed by an Ink objective and a greeting that correctly made no model request. A controlled first failure also persisted across Scheduler reconstruction, respected its original backoff and recovered through a real model request on attempt two. The earlier single failure did not recur; its precise upstream cause remains unknown because the original run recorded no protocol detail. See [delivery evidence](../../.scratch/title-implementation-20261118/VERIFICATION.md). Production installation has its own active-task boundary.
