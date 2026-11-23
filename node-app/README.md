# CoderFleet desktop

CoderFleet runs several AI coding accounts (Claude Code, Codex, Antigravity and others) in their own Docker containers on one machine. The desktop App manages everything that used to need the `coderfleet` commands: accounts and their login, projects and their containers, the shared image, proxy settings, terminals and conversations.

## Architecture

- **App and backend.** The Electron App talks to a Node.js backend over HTTP with a token. For this computer, the App creates the backend configuration (random token, workspace `~/.coderfleet`) and starts the backend itself. The App can also connect to a backend on another Docker host; remote tokens are kept in the system keychain. The renderer has no network or file access; every request goes through the App's main process.
- **Workspace.** The backend reads and writes the CoderFleet workspace in the Python formats: `config.conf`, `accounts.conf`, `projects.conf`, `accounts/<name>/`. **初始化工作区** creates a new one from the files bundled in `template/` (Dockerfile, entrypoint, helper scripts).
- **Containers.** Each project runs in its account's persistent container (`<type>-<project>`), generated into `docker-compose.yml` (`src/compose.ts`, a port of `compose.py`; a test compares both generators' output) and started, stopped and removed with `docker compose` / `docker rm`. Containers of relay accounts join only the internal network, so all their traffic goes through the relay. Software installed with `sudo` inside a container stays until the container is recreated. Image builds use Docker's own network.
- **Turns.** A conversation turn starts a worker inside the project container with `docker exec -d … setsid -w node …`. The workers, the control mailbox and the Claude Agent SDK bundle are copied once per content hash into the project's `.coderfleet-tasks/node-workers-<hash>/`. The backend and the worker share only files in `.coderfleet-tasks`, with the Python service's layout: `<task>.sdk.json`, `<task>.log` (stream-json events), `<task>.exit`, `<task>.sdk-state.json`, `<task>.control/`. After a backend restart, running turns and pending approvals continue; a prompt is never replayed.
  - **Claude Code:** TypeScript Claude Agent SDK with the container's `claude`. It supports tool approvals, native questions, interrupt and resume.
  - **Codex:** `codex exec --json` with the Python scheduler's flags (`workspace-write` sandbox), resume by thread ID.
  - **Antigravity:** `agy acp`, with tool approvals, interrupt and resume.
- **Terminals.** Login and project shells run inside containers through `script`, so the host needs no native terminal module. The App shows them with xterm.js.

## Develop

Requires Node.js 22.18 or newer and Docker.

~~~sh
npm ci
npm run build     # TypeScript, the vendored Claude Agent SDK and xterm.js
npm test
npm run desktop
~~~

`npm run package` builds the desktop App for the current platform under `out/`.

To review the interface in a browser with sample data (fake Docker and fake CLIs):

~~~sh
node scripts/preview.mjs 5173
CHROMIUM_PATH=/path/to/chrome node scripts/screenshots.mjs /tmp/shots light
~~~

## Remote backend

On the Docker host, run `node dist/cli.js serve /path/config.json` with a configuration like this one:

~~~json
{ "port": 8877, "token": "a random token of 24+ characters", "workspace": "~/.coderfleet", "stateDirectory": "./node-state" }
~~~

The backend listens on loopback. Forward it with `ssh -N -L 127.0.0.1:8878:127.0.0.1:8877 user@host`, or put it behind HTTPS. Then add it in **设置 → 后端连接**.

## Status

This is the MVP: accounts, projects, containers, image, settings, terminals and conversations. Python and this backend keep separate conversation records; don't run turns for the same project from both at once. Not migrated yet: workflows, boards, schedules, Telegram, MCP bridge, the platform assistant, and the remaining account types' conversations (OpenCode, Hermes, Grok, Kimi, Pi can be managed and used from the terminal).
