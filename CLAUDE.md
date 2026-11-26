# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

CoderFleet runs several AI coding accounts (Claude Code, Codex, Antigravity, OpenCode and others) in their own Docker containers on one machine, pooling quota across accounts. It ships as a desktop App with its own Node.js backend (`node-app/`) and a chat-only phone App (`mobile/`). The earlier Python CLI and Web console are no longer in this repository (last state: branch `legacy/python`).

## Key commands

```bash
# Desktop App and backend
cd node-app
npm ci
npm test              # build + all backend, App and helper tests
npm run desktop       # run the App from source
npm run package       # desktop App for the current platform, under out/

# Phone App
cd mobile
flutter pub get
flutter analyze
flutter test
```

Releases: `scripts/release.sh <version>` (sets the version in both Apps, commits, tags `app-v<version>`, pushes); `.github/workflows/app.yml` builds every platform and creates the GitHub Release. Never bump the version or tag by hand; the rules are in `RELEASING.md`.

## Architecture

| Part | Role |
|------|------|
| `node-app/src/` | Node.js backend and the Electron main process: workspace files, docker-compose generation, container lifecycle, turns (one worker per account type), terminals, notifications, phone access. |
| `node-app/ui/` | The App's renderer (no build step). |
| `node-app/helper/` | Machine helper that lets agents in containers act on the host under the owner's rules. |
| `node-app/template/` | Files a new workspace is created from: Dockerfile, entrypoint, container-side scripts. |
| `mobile/` | Flutter App for iOS and Android; talks to the backend with a revocable device token. |

`node-app/README.md` and `mobile/README.md` describe each part in detail; read them before changing it.

### Data storage (workspace, `~/.coderfleet` by default)

- `config.conf`, `accounts.conf`, `projects.conf` — authoritative config files; `docker-compose.yml` is **generated** from these, never edit it manually.
- `accounts/<name>/` — per-account CLI auth data mounted into containers.
- `conversations/<id>.json`, `tasks/<id>.json`, `tasks/<id>.log` — conversation and turn records. The format is the one the Python version wrote, so older workspaces keep their history.

### Network isolation

Containers of relay accounts join an `internal: true` Docker network; they cannot reach the public internet directly. All traffic is forced through a `coderfleet-proxy-relay` container running gost, which forwards to the host proxy. `PROXY=off` accounts skip the relay and connect to the default bridge.

## North Star

CoderFleet's job is to let one operator run more AI-coding-CLI work than any single account's quota allows, by pooling several accounts behind strict per-account isolation — container, auth, and proxy egress never leak into each other. When a trade-off isn't covered by an explicit rule, prefer whichever option (1) keeps account/container/proxy isolation intact over one that's more convenient to build, and (2) never loses or silently corrupts conversation state a real user is depending on to resume work.

## Cross-cutting invariants

- **State-file mutations must be a single synchronous read-modify-write, never a separate read then a later write.** Load → mutate with no `await` in between → save. Applies to every JSON store in the workspace.
- **Don't duplicate cross-entry-point logic or constants — extract one shared helper/constant.** The desktop App, the phone App's API and the backend CLI must call the same code for the same rule.
- **Never silently fall back to a stale or "most recent" default when a reference is invalid — reject or warn explicitly.**
- **A list rerender must not discard an in-progress inline edit.**
- **A model field must be fully wired end-to-end (read + write + UI) before it ships — no half-wired placeholder fields.**

## Iron rules

- **Run the full test suite of the part you changed before reporting the work done.** `cd node-app && npm test`; `cd mobile && flutter analyze && flutter test`. Treat a change as incomplete until it passes, or any failures are understood and called out.

## Reference map

| When you're working on... | Read first |
|---|---|
| the desktop App or backend | `node-app/README.md` |
| the phone App | `mobile/README.md` |
| triaging or filing GitHub issues, applying labels | `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md` |
| domain modeling, ADRs | `docs/agents/domain.md` |

## Maintaining this map

The map grows only on triggers — never speculatively:

1. **After an incident** — write the postmortem in `docs/incidents/`
   (append-only is legal there), then ask "what grep would have prevented
   this" → a new guard, or an append to an existing one.
2. **Same mistake twice** — triage into exactly one layer:
   machine-checkable → guard in `scripts/verify.sh`'s CHECKS;
   cross-cutting → bullet above;
   domain detail → docs/ file + a Reference-map row.

Guards: `bash scripts/verify.sh` before every push (kept under 30s).

# RTK (Rust Token Killer) - Token-Optimized Commands

## Golden Rule

**Always prefix commands with `rtk`**. If RTK has a dedicated filter, it uses it. If not, it passes through unchanged. This means RTK is always safe to use.

**Important**: Even in command chains with `&&`, use `rtk`:
```bash
# ❌ Wrong
git add . && git commit -m "msg" && git push

# ✅ Correct
rtk git add . && rtk git commit -m "msg" && rtk git push
```

## RTK Commands by Workflow

### Build & Compile (80-90% savings)
```bash
rtk cargo build         # Cargo build output
rtk cargo check         # Cargo check output
rtk cargo clippy        # Clippy warnings grouped by file (80%)
rtk tsc                 # TypeScript errors grouped by file/code (83%)
rtk lint                # ESLint/Biome violations grouped (84%)
rtk prettier --check    # Files needing format only (70%)
rtk next build          # Next.js build with route metrics (87%)
```

### Test (60-99% savings)
```bash
rtk cargo test          # Cargo test failures only (90%)
rtk go test             # Go test failures only (90%)
rtk jest                # Jest failures only (99.5%)
rtk vitest              # Vitest failures only (99.5%)
rtk playwright test     # Playwright failures only (94%)
rtk pytest              # Python test failures only (90%)
rtk rake test           # Ruby test failures only (90%)
rtk rspec               # RSpec test failures only (60%)
rtk test <cmd>          # Generic test wrapper - failures only
```

### Git (59-80% savings)
```bash
rtk git status          # Compact status
rtk git log             # Compact log (works with all git flags)
rtk git diff            # Compact diff (80%)
rtk git show            # Compact show (80%)
rtk git add             # Ultra-compact confirmations (59%)
rtk git commit          # Ultra-compact confirmations (59%)
rtk git push            # Ultra-compact confirmations
rtk git pull            # Ultra-compact confirmations
rtk git branch          # Compact branch list
rtk git fetch           # Compact fetch
rtk git stash           # Compact stash
rtk git worktree        # Compact worktree
```

Note: Git passthrough works for ALL subcommands, even those not explicitly listed.

### GitHub (26-87% savings)
```bash
rtk gh pr view <num>    # Compact PR view (87%)
rtk gh pr checks        # Compact PR checks (79%)
rtk gh run list         # Compact workflow runs (82%)
rtk gh issue list       # Compact issue list (80%)
rtk gh api              # Compact API responses (26%)
```

### JavaScript/TypeScript Tooling (70-90% savings)
```bash
rtk pnpm list           # Compact dependency tree (70%)
rtk pnpm outdated       # Compact outdated packages (80%)
rtk pnpm install        # Compact install output (90%)
rtk npm run <script>    # Compact npm script output
rtk npx <cmd>           # Compact npx command output
rtk prisma              # Prisma without ASCII art (88%)
```

### Files & Search (60-75% savings)
```bash
rtk ls <path>           # Tree format, compact (65%)
rtk read <file>         # Code reading with filtering (60%)
rtk grep <pattern>      # Search grouped by file (75%). Format flags (-c, -l, -L, -o, -Z) run raw.
rtk find <pattern>      # Find grouped by directory (70%)
```

### Analysis & Debug (70-90% savings)
```bash
rtk err <cmd>           # Filter errors only from any command
rtk log <file>          # Deduplicated logs with counts
rtk json <file>         # JSON structure without values
rtk deps                # Dependency overview
rtk env                 # Environment variables compact
rtk summary <cmd>       # Smart summary of command output
rtk diff                # Ultra-compact diffs
```

### Infrastructure (85% savings)
```bash
rtk docker ps           # Compact container list
rtk docker images       # Compact image list
rtk docker logs <c>     # Deduplicated logs
rtk kubectl get         # Compact resource list
rtk kubectl logs        # Deduplicated pod logs
```

### Network (65-70% savings)
```bash
rtk curl <url>          # Compact HTTP responses (70%)
rtk wget <url>          # Compact download output (65%)
```

### Meta Commands
```bash
rtk gain                # View token savings statistics
rtk gain --history      # View command history with savings
rtk discover            # Analyze Claude Code sessions for missed RTK usage
rtk proxy <cmd>         # Run command without filtering (for debugging)
rtk init                # Add RTK instructions to CLAUDE.md
rtk init --global       # Add RTK to ~/.claude/CLAUDE.md
```

## Token Savings Overview

| Category | Commands | Typical Savings |
|----------|----------|-----------------|
| Tests | vitest, playwright, cargo test | 90-99% |
| Build | next, tsc, lint, prettier | 70-87% |
| Git | status, log, diff, add, commit | 59-80% |
| GitHub | gh pr, gh run, gh issue | 26-87% |
| Package Managers | pnpm, npm, npx | 70-90% |
| Files | ls, read, grep, find | 60-75% |
| Infrastructure | docker, kubectl | 85% |
| Network | curl, wget | 65-70% |

Overall average: **60-90% token reduction** on common development operations.
<!-- /rtk-instructions -->
