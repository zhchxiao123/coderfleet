# CoderFleet desktop

CoderFleet runs several AI coding accounts (Claude Code, Codex, Antigravity and others) in their own Docker containers on one machine. The desktop App manages everything that used to need the `coderfleet` commands: accounts and their login, projects and their containers, the shared image, proxy settings, terminals and conversations.

## Architecture

- **App and backend.** The Electron App talks to a Node.js backend over HTTP with a token. For this computer, the App creates the backend configuration (random token, workspace `~/.coderfleet`) and starts the backend itself. The App can also connect to a backend on another Docker host; remote tokens are kept in the system keychain. The renderer has no network or file access; every request goes through the App's main process.
- **Workspace.** The backend reads and writes the CoderFleet workspace in the Python formats: `config.conf`, `accounts.conf`, `projects.conf`, `accounts/<name>/`. **初始化工作区** creates a new one from the files bundled in `template/` (Dockerfile, entrypoint, helper scripts).
- **Several accounts in one project.** A project is built on one account and can hold more, one of each type and all with the same proxy setting (`SECONDARY_ACCOUNTS` in `projects.conf`; `projectAccounts` in `src/conf.ts` holds the rules, the Projects page's 「账号…」 and `PUT projects/<name>/accounts` change them). They share the project's one container: every account's directory is mounted, and the container has no account-wide environment; each turn brings its own account's (`docker exec --env-file`). A conversation stays with the account it began with; a new one starts with the account the project used last unless another is picked. An added account works once the container is recreated (restart the project); the conversations of a removed one can still be read. Scheduled runs use the account the project used last.
- **Containers.** Each project runs in its account's persistent container (`<type>-<project>`), generated into `docker-compose.yml` (`src/compose.ts`; a test compares its output with a recorded file) and started, stopped and removed with `docker compose` / `docker rm`. The Projects page and `coderfleet-backend containers start|stop|restart [project]` also act on all containers at once (`Lifecycle.startAll/stopAll/restartAll`): stop keeps the containers and takes the relay down with them; an operation on all and one on a single project never run together. Containers of relay accounts join only the internal network, so all their traffic goes through the relay. Software installed with `sudo` inside a container stays until the container is recreated. The shared image is either downloaded (`Lifecycle.pull`: the image `.github/workflows/image.yml` publishes for each App version, for this Docker's processor, tagged with the workspace's image name; the image platform setting follows) or built from the workspace's `Dockerfile` (`Lifecycle.build`); both from the App and `coderfleet-backend image status|pull|build`, and both use Docker's own network.
- **Project images.** A project's container runs the shared image unless the project has its own (`IMAGE` in `projects.conf`, as in the Python version). The Projects page's 「镜像…」 sets the name and edits `projects/<name>/Dockerfile` in the workspace; 保存并构建 builds it with that directory as the context (`Lifecycle.buildProject`), under the given name or `coderfleet-<name>:latest`, and writes the name back. `GET`/`PUT projects/<name>/image`, `POST projects/<name>/image/build` and `coderfleet-backend image project <project> …` are the same thing; all need the main token. The container uses a new image once it is recreated.
- **Turns.** A conversation turn starts a worker inside the project container with `docker exec -d … setsid -w node …`. The workers, the control mailbox and the Claude Agent SDK bundle are copied once per content hash into the project's `.coderfleet-tasks/node-workers-<hash>/`. The backend and the worker share only files in `.coderfleet-tasks`, with the Python service's layout: `<task>.sdk.json`, `<task>.log` (stream-json events), `<task>.exit`, `<task>.sdk-state.json`, `<task>.control/`. After a backend restart, running turns and pending approvals continue; a prompt is never replayed.
  Each account type runs through its official programmatic interface where one exists:

  | Type | Interface |
  | --- | --- |
  | Claude Code | TypeScript Claude Agent SDK with the container's `claude`: tool approvals, native questions, interrupt, resume |
  | Codex | TypeScript Codex SDK (`@openai/codex-sdk`) with the container's `codex`: its own sandbox off (bubblewrap cannot run in a container; the container is the boundary), resume by thread ID |
  | OpenCode | OpenCode SDK (`@opencode-ai/sdk`) against `opencode serve` started on loopback in the container: tool approvals, abort, resume |
  | Pi | Pi's own SDK (`createAgentSession` from the globally installed package), in the worker process; Pi has no approvals |
  | Antigravity, Kimi Code, Grok | Agent Client Protocol over stdio (`agy acp`, `kimi acp`, `grok agent stdio`): tool approvals, interrupt, resume |
  | Hermes | `hermes chat -q --format stream-json` (no TypeScript SDK); plain text on CLIs without that flag |

- **Notifications.** The App's main process long-polls the connected backend's conversation list (`src/notifications.ts`) and shows a system notification when a conversation waits for an approval or an answer, finishes, or fails, unless the App window has focus. Clicking one opens that conversation.
- **Terminals.** Login and project shells run inside containers through `script`, so the host needs no native terminal module. The App shows them with xterm.js.

## 领航 (lead agent)

`src/lead.ts`: a main agent in the backend that takes what the conversations it follows stop on — approvals, questions, a job ready to merge — and settles it or hands it to the user as a plain message in one chat (`ui/js/lead.js`), under a list of the followed conversations that run, wait or failed, grouped by project. It thinks with the system model (`SYSTEM_LLM_*`), never with an account of the pool, on pi's agent loop (`src/lead-engine.ts`; the SDK is shipped whole in `dist/vendor/pi`, so the backend still has no runtime dependency): pi brings the streamed answer, the retries and the compaction of a long run, while its own file and shell tools are left out. 领航 only decides: it reads the project through `docker exec` in the conversation's own container and acts through the same functions the App's and the phone's requests call (answer a permission, send a message, accept a job). Rules checked in code come before the model: deleting, pushing, publishing, secrets and machine-helper cards always go to the user. It is off until the user starts it; per conversation the toggle 领航在跟 / 我自己来 decides who is asked. State: `lead/thread.jsonl` and `lead/state.json` in the backend's state directory. Design: `docs/plans/lead-agent-design.md`.

## Develop

Requires Node.js 22.19 or newer and Docker.

~~~sh
npm ci
npm run build     # TypeScript, the vendored Claude Agent SDK and xterm.js
npm test
npm run desktop
~~~

`npm run package` builds the desktop App for the current platform under `out/`. `scripts/installers.sh <label> [mac|windows|linux]` turns what is under `out/` into installers under `release/`: `.dmg` (on macOS), a Windows setup program (needs `makensis`), `.deb` and `.tar.gz`. CI does both on every push to `main`.

To review the interface in a browser with sample data (fake Docker and fake CLIs):

~~~sh
node scripts/preview.mjs 5173
CHROMIUM_PATH=/path/to/chrome node scripts/screenshots.mjs /tmp/shots light
~~~

## Remote Docker hosts (SSH)

In **设置 → 后端连接 → 通过 SSH 添加** (or on the welcome page), enter `user@host` or an alias from `~/.ssh/config`. The App uses the system `ssh` with your keys. It does not store passwords; set up key login first (`ssh-copy-id`). Then the App:

1. probes the machine: Linux x86_64 or arm64, and Docker usable by the login user;
2. uploads the bundled backend (`bundles/coderfleet-backend-<version>-linux-<arch>.tar.gz`). The bundle includes its own Node.js runtime, so the host needs only Docker;
3. runs `install.sh`. It installs to `~/.coderfleet-backend/versions/<version>`, keeping the previous version. On first install it creates `config.json` with a random token (workspace `~/.coderfleet`, port 8877, loopback only). Then it starts the service with the first option that works:
   - systemd system service when logging in as root;
   - systemd user service, with linger enabled;
   - a background process. This mode does not survive a reboot.
4. stores the token in the system keychain and forwards a local port to the service through `ssh -N -L`. The tunnel reconnects automatically. No port is opened on the remote host.

When the App ships a newer backend, the connection shows **升级到 …**. Upgrading reinstalls over SSH and keeps the token, workspace and conversations. Turns running in containers continue while the service restarts.

Build the bundles with `npm run package:backend`. It downloads the official Node.js builds, verifies them against `SHASUMS256.txt` and caches them in `.cache/node`. `npm run package` includes the bundles in the App.

A backend you deploy yourself behind HTTPS can still be added with its address and token: run `coderfleet-backend init`, then `coderfleet-backend serve`.

## Status

This is the MVP: accounts, projects, containers, image, settings, terminals and conversations.

Conversations and turns are stored the Python way, in the workspace: `conversations/<id>.json`, `tasks/<id>.json` and `tasks/<id>.log` (`src/store.ts`). Existing history therefore appears in the App as is. Logs from the Python service's CLI backends are converted from each tool's native format (`src/history.ts`, ported from the Python parsers). Turns started in the App are Task records the Python models load: worker output is mirrored into `tasks/<id>.log` as the Python service does for SDK workers, and the App's own fields live under the Task's `node` key. A later turn resumes the conversation's `native_session_id`. Tasks still queued or running in the Python service are shown read-only. Don't run the two services' schedulers on the same conversation at the same time. Not migrated yet: workflows, boards, schedules, Telegram, MCP bridge and the platform assistant.
