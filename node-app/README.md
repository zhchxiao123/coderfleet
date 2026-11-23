# CoderFleet Node and desktop pilot

The Electron client switches among independent Node.js backends. Every backend connects to Docker on its own host and owns its projects, conversation history, login state and running turns. The renderer uses a transport interface for backend requests and profile management. Electron implements that interface in its preload and keeps Docker and credentials outside the renderer.

The pilot and the Python service can run together on separate ports, with separate state, project directories and account directories. Native Antigravity sessions created during this pilot belong to the selected Node backend. Replacing the Python service and importing existing history are later migration steps.

## Local backend

Install Node.js 22.18 or newer and Docker. From this directory, build the application and the Antigravity worker image.

~~~sh
npm ci
npm run build
docker build -f Dockerfile.antigravity -t coderfleet-antigravity-node:1.5.15 .
~~~

Create a test project directory and a configuration file readable only by your account. The paths below are relative to the configuration file. Keep the file and its state outside the source tree.

~~~json
{
  "port": 8877,
  "token": "REPLACE_WITH_A_RANDOM_PRIVATE_TOKEN",
  "stateDirectory": "./node-state",
  "projects": [
    {
      "id": "antigravity-pilot",
      "name": "Antigravity pilot",
      "image": "coderfleet-antigravity-node:1.5.15",
      "workspace": "./project",
      "accountDirectory": "./google-login",
      "network": "bridge"
    }
  ]
}
~~~

Generate a token with `node -p "require('node:crypto').randomBytes(32).toString('base64url')"`. The sample explicitly uses Docker bridge egress. To use an existing relay, set the appropriate Docker network, optional relay DNS servers in the project's dns array, and proxy variables under the project's `environment` object. Set a top-level absolute `dockerPath` when an app launched from Finder cannot find Docker. On Linux the turn container uses the backend user's UID and GID by default when the service is run as a non-root user. Set the project's `containerUser` if the bind mounts require a different user.

Log into the pilot account and complete the browser prompt.

~~~sh
npm run backend -- login /absolute/path/config.json antigravity-pilot
~~~

Run `npm run desktop`, open **管理后端 → 打开本机配置**, and select the file. Electron starts the local Node service if needed. To start the same service directly from a terminal, run:

~~~sh
npm run backend -- serve /absolute/path/config.json
~~~

Run `npm run package` to build the current platform's desktop app under `out/`. Use the platform's signing and publishing workflow for distribution.

## Remote Docker backend

Build and run the same Node service on the Linux Docker host, using workspace and account paths on that host. Each service instance owns a separate state directory. The service listens on loopback by default. You can forward it to an available local port with SSH.

~~~sh
ssh -N -L 127.0.0.1:8878:127.0.0.1:8877 user@remote-host
~~~

In **管理后端**, save `http://127.0.0.1:8878` and the remote service token. For a directly accessible server, put the API behind an HTTPS endpoint and use that address. The desktop client stores remote tokens using the operating system's credential encryption. Backend switching selects a separate project namespace. Workspace files, accounts and conversations stay on their owning backend.

## Platform and migration scope

- Electron is the desktop shell for macOS and Windows. The responsive renderer consumes a small platform transport interface. A Capacitor shell can implement that interface for iOS and Android using native credential storage and authenticated HTTP. Mobile clients connect to an existing backend. Native mobile packages and Windows runtime validation are pending.
- This slice supports Antigravity conversations, model selection, partial responses, native resume, one-time approvals, cancellation and reconnection. A background Node process owns each turn so the API can reconnect during an active turn. If a worker disappears, the service checks for and cleans up its labeled container before releasing the slot. A conversation accepts one active turn.
- Remaining migration work covers the other providers, Claude SDK worker, CLI parity, workflows, schedules, terminal, Telegram, MCP and a validated legacy data upgrade. Keep Python serving the current workspace until that acceptance is complete.

Run `npm test` from this directory. The integration test uses two loopback backends and a deterministic Docker/ACP fixture to check isolation, model selection, approval across an API restart, resume and cancellation.
