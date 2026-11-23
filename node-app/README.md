# CoderFleet Node and desktop pilot

The Electron client switches among independent Node.js backends. The renderer uses a transport interface for backend requests and profile management. Electron implements that interface in its preload and keeps Docker and credentials outside the renderer.

## Architecture

The Node service follows the Python scheduler's execution model:

- **Configuration** comes from the CoderFleet workspace: `accounts.conf` and `projects.conf`. This pilot serves projects whose account has `TYPE=antigravity`.
- **Containers** are the persistent project containers that `coderfleet apply` / `coderfleet up` create (`<type>-<project>`, e.g. `antigravity-my-app`), using the shared image with its `sudo`-enabled `byclaw` user. Software installed in a container stays there until the container is recreated; put lasting dependencies in the project image. The service does not create containers.
- **Each turn** starts a worker inside that container with `docker exec -d … setsid -w node …`. The worker (`src/antigravity-worker.ts`) runs `agy acp` and writes stream-json events, matching `coderfleet_antigravity_worker.py`.
- **The host and the worker communicate only through the project's `.coderfleet-tasks` directory**, which is the same layout the Python service uses:

  | File | Purpose |
  | --- | --- |
  | `acp-worker-<hash>.mjs`, `sdk-control-<hash>.mjs` | Worker and control mailbox, copied by content hash |
  | `<task>.sdk.json` | Task specification |
  | `<task>.log` | Event stream |
  | `<task>.sdk-diagnostic.log` | Worker stderr |
  | `<task>.exit` | Exit status: 0 done, 143 interrupted, other values failed |
  | `<task>.sdk-state.json` | Worker PID and process group |
  | `<task>.control/` | Approval and interrupt commands with receipts. The format matches `coderfleet_sdk_control.py`. |

- **Restarts.** The service reads the event log incrementally from a saved offset. After a restart it continues following running turns and accepts approvals for them. A worker that disappears without an exit file fails its turn; the prompt is not replayed.
- **Egress.** Before dispatching, the service checks that the container is running. For `PROXY=relay` accounts it also checks that every network attached to the container is internal.

## Local backend

Install Node.js 22.18 or newer. From this directory:

~~~sh
npm ci
npm run build
~~~

Configure an Antigravity account and project in the CoderFleet workspace, then start its container with the existing tooling (`coderfleet account add … TYPE=antigravity`, `coderfleet project add …`, `coderfleet apply`). The shared image must include `agy` 1.5.15.

Create a service configuration file readable only by your account and keep it outside the source tree:

~~~json
{
  "port": 8877,
  "token": "REPLACE_WITH_A_RANDOM_PRIVATE_TOKEN",
  "workspace": "~/.coderfleet",
  "stateDirectory": "./node-state"
}
~~~

Generate a token with `node -p "require('node:crypto').randomBytes(32).toString('base64url')"`. Relative paths are resolved from the configuration file. Set a top-level absolute `dockerPath` when an app launched from Finder cannot find Docker.

Log into the project's Google account inside its container. Alternatively, use `coderfleet login <account>`.

~~~sh
npm run backend -- login /absolute/path/config.json <project>
~~~

Run `npm run desktop`, open **管理后端 → 打开本机配置**, and select the file. Electron starts the local Node service if needed. To start the service from a terminal instead, run:

~~~sh
npm run backend -- serve /absolute/path/config.json
~~~

The Python service and this service keep separate conversation records. Do not dispatch turns for the same project from both services at the same time.

Run `npm run package` to build the current platform's desktop app under `out/`.

## Remote Docker backend

Run the same Node service on the Linux Docker host, using that host's CoderFleet workspace. The service listens on loopback by default. You can forward it to an available local port with SSH:

~~~sh
ssh -N -L 127.0.0.1:8878:127.0.0.1:8877 user@remote-host
~~~

In **管理后端**, save `http://127.0.0.1:8878` and the remote service token. The desktop client stores remote tokens with the operating system's credential encryption.

## Scope

- This slice supports Antigravity conversations, model selection, streaming replies, native resume, one-time approvals, cancellation and reconnection.
- Remaining migration work:
  - other providers, including the Claude SDK worker in TypeScript
  - Task and Conversation records in the Python formats
  - container lifecycle (compose, build, apply)
  - CLI parity, workflows, schedules, terminal, Telegram and MCP

Run `npm test` from this directory. The tests run the real worker and control mailbox against a fake Docker CLI and a fake `agy`. They cover new and resumed sessions, approval across a service restart, denial, cancellation, a stopped container, a non-internal network, and control-mailbox compatibility with the Python implementation.
