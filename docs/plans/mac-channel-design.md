# 机器辅助程序：让容器里的 Claude Code 操作它所在的那台机器

设计日期：2026-11-25（第三版）。前置研究：`docs/research/mac-helper-for-container-agents-20261125.md`（下文写「研究 §n」）。原型：`examples/mac-helper-prototype/`。

CoderFleet 这边的代码落在桌面 App 分支 `codex/node-electron-migration` 的 `node-app/`（核对时的提交 `61af9ed`）。下文的 `src/…`、`ui/…`、`test/…` 都相对 `node-app/`。没有要写或要改的 Python 文件。

## 1. 一页说清

- **辅助程序是一个单独的程序。** 它装在哪台机器上，连上它的 Claude Code 就能操作哪台机器：装在 Mac 上就是操作 Mac，装在 Linux 上就是操作 Linux。它是一个带令牌的标准 MCP 服务，不依赖 CoderFleet 也能用。
- **容器经 relay 上的一条固定转发连到它。** 和现在容器调宿主上 MCP 服务用的是同一种转发，多加一条。
- **CoderFleet 管四件事**：在界面上安装和启动它；决定哪个项目能用；给任务发令牌；把它的确认请求显示成对话里的审批卡片，并在你点「停止」时让它杀掉进程。
- **默认谁也用不了。** 按项目开，两档：`command`（清单内的命令，含刷固件）和 `gui`（再加看屏幕、点、输入，目前只有 Mac）。
- **命令按清单走**：拒绝 / 要你点允许 / 放行，不在清单里的一律拒绝。清单和操作记录存在辅助程序那台机器上。
- **这一版只做「辅助程序和 Docker 在同一台机器」**。装到第三台机器的做法在 §10 说明，先不做。
- 分三期交付（§12）。

## 2. 两个部分各管什么

### 2.1 辅助程序（新，单独成包）

放在同一个仓库的新目录 `node-app/helper/`（当前不存在），用 Node 写，不依赖 Electron，也不引用 `src/` 里的后端代码；打成一个独立的可执行包 `coderfleet-helper`。

| 管什么 | 说明 |
|---|---|
| MCP 服务 | HTTP，路径 `/mcp`，每个请求验令牌 |
| 工具 | `machine_info`、`run_command`、`list_serial_ports`、`read_serial`，Mac 上再加屏幕工具（§5） |
| 规则 | `~/.coderfleet-helper/policy.json`，判定「拒绝 / 确认 / 放行」 |
| 操作记录 | `~/.coderfleet-helper/audit/<日期>.jsonl`，只追加 |
| 管理口 | 路径 `/control/…`，只认主密钥：查状态、取待确认的请求、交确认结果、作废某个任务、读写规则、读记录 |
| 自己的命令行 | `coderfleet-helper serve\|status\|policy …\|audit …\|token …` |

它不知道什么是项目、对话、账号。它只认令牌，令牌里写着这次能做什么（§4.2）。

### 2.2 CoderFleet（改）

| 部分 | 在哪 | 管什么 | 新增 / 已有 |
|---|---|---|---|
| 辅助程序的安装和看护 | 新文件 `src/helper-host.ts`（照 `src/local-backend.ts` 的 `ensureLocal`、`probeLocal` 写） | 安装、启动、探活、升级时替换旧版本；签发令牌；轮询待确认的请求；通知作废 | 新 |
| relay 转发 | `src/compose.ts` 的 `gostConfig`、`generateCompose` | 多一条固定转发，容器多一个环境变量 | 改 |
| relay 重启 | `src/lifecycle.ts` 的 `Lifecycle` 新增 `restartRelay()` | 升级后那一次让新规则生效 | 改 |
| 项目授权 | `src/conf.ts` 新增 `projectHelperAccess`、`setProjectHelper`（照 `projectMountSpecs`、`setProjectMounts` 写） | 读写 `projects.conf` 的 `HELPER_ACCESS` | 改 |
| 任务启动 | `src/tasks.ts` 的 `TaskRunner.launch`、`finish` | 发令牌；任务结束时通知作废 | 改 |
| 任务的 MCP 配置 | `src/claude-worker.ts` 的 `runClaude` | 给 `sdk.query` 加 `mcpServers.machine` | 改 |
| 确认 | `src/state.ts` 的 `Permission`、`src/server.ts` 的 `turns/<id>/permission` 路由 | 把辅助程序的确认请求挂成卡片，答复转回去 | 已有，路由加一个分支 |
| 接口和界面 | `src/server.ts` 路由表、`ui/js/settings.js`、`ui/js/projects.js`、`src/cli.ts` | 安装、状态、项目开关、规则、记录 | 改 |

新文件 `src/helper-host.ts`、`test/helper.test.mjs` 和目录 `helper/` 当前都不存在（`ls src/helper* helper` 无结果；`test/helpers.mjs` 是现有的测试工具文件，不相干）。

## 3. 调用链和连通

```
容器里的 Claude Code
  │  MCP over HTTP
  │  URL  http://${CODERFLEET_RELAY_IP}:${CODERFLEET_HELPER_BRIDGE_PORT}/mcp
  │  头   Authorization: Bearer <任务令牌>
  ▼
relay 容器的 gost 转发（:8767 → host.docker.internal:8790）            新增一条，固定生成
  ▼
辅助程序（宿主机上，默认端口 8790）
  验令牌 → 档位够不够 → 规则判定 → 需要的话等确认 → 执行 → 记录
  ▼
子进程（xcodebuild / esptool / …）或 Cua Driver

旁路（只在宿主机本地，带主密钥）：
CoderFleet 后端 ──/control/…──▶ 辅助程序     取待确认的请求、交答复、作废任务
```

具体改哪里：

| 环节 | 改法 |
|---|---|
| relay 转发规则 | `gostConfig` 现在生成一条 `service-bridge`（`:8766` → `host.docker.internal:<CODERFLEET_PORT>`）。照它再生成一条 `helper-bridge`：监听 `config.conf` 的 `HELPER_BRIDGE_RELAY_PORT`（缺省 `8767`），转到 `host.docker.internal:` + `HELPER_PORT`（缺省 `8790`）。**不管装没装辅助程序都生成**，没装时这条转发连不上任何东西 |
| 容器环境变量 | `generateCompose` 里现在给容器 `CODERFLEET_MCP_BRIDGE_PORT` 的地方，多给一个 `CODERFLEET_HELPER_BRIDGE_PORT` |
| 让规则生效 | 规则写在 `proxy-relay-config.yaml` 里，relay 启动时读一次；现在界面上的操作只动项目自己的容器，不会重启 relay。所以升级后要重启 relay **一次**：`Lifecycle.restartRelay()`，界面在安装辅助程序时发现 relay 还没有这条规则就提示「需要重启网络中转，正在跑的任务会断网几秒」，你点了才做。之后安装、升级、卸载辅助程序都不用再动 relay |
| 任务的 MCP 配置 | `runClaude` 里，环境变量 `CODERFLEET_HELPER_TOKEN` 存在时，给 `sdk.query` 的 `options` 加 `mcpServers: { machine: { type: 'http', url, headers: { Authorization: 'Bearer ' + 令牌 }, timeout: 2_500_000 } }`。`McpHttpServerConfig` 的 `headers`、`timeout` 在 App 用的 SDK（0.3.330）的 `sdk.d.ts` 里查得到；现在的 `runClaude` 没有传过 `mcpServers`。`canUseTool` 对 `mcp__machine__` 开头的工具直接放行，把关在辅助程序那边做 |
| 令牌下发 | `TaskRunner.launch` 调 `execDetached` 时的环境里现在只有 `CODERFLEET_TASK_ID`，项目开了通道时加 `CODERFLEET_HELPER_TOKEN`。不写进 spec 文件（spec 在项目目录里，别的项目挂了这个目录就读得到） |

转发端口对隔离网段里所有容器都开着，所以「连得上」不代表有权限，权限只看令牌。

Linux 上的一个差别：`host.docker.internal` 在 Mac（OrbStack、Docker Desktop）上能到宿主的本机回环地址，辅助程序只听 `127.0.0.1` 就行；在 Linux 上它指向 Docker 网桥的地址，辅助程序要听那个地址。安装时由 `helper-host.ts` 按系统决定，不听 `0.0.0.0`。

## 4. 身份和授权

### 4.1 项目授权

`projects.conf` 新增一个键 `HELPER_ACCESS=off|command|gui`，缺省 `off`；`gui` 包含 `command`。`projectHelperAccess(project)` 从 `WorkspaceProject.record` 读，非法值按 `off` 处理并在后端日志里告警；`setProjectHelper` 用 `rewriteConf` 写。

这一版只接**容器里的 Claude 任务**（`src/claude-worker.ts`）。其他 worker 以后要接，只是各自加一段 MCP 配置，辅助程序不用改。

### 4.2 令牌

辅助程序安装时生成一个 32 字节的主密钥，存 `~/.coderfleet-helper/secret`（0600）。CoderFleet 后端和它在同一台机器、同一个用户下，直接读这个文件。

任务令牌 = `内容 + HMAC-SHA256(主密钥, 内容)`，内容是：

```json
{"task": "<任务号>", "label": "<项目名>", "access": "command", "root": "/Users/…/reminis", "exp": 1795600000}
```

- `root` 是这个任务能用作工作目录的范围（项目在宿主机上的路径）；`exp` 是过期时间，签发后 24 小时。
- 辅助程序验签名、看过期、看任务号在不在作废名单里，三样都过才处理。不用回头问 CoderFleet，所以它能单独存在。
- 任务结束时（做完、失败、被你停止），`TaskRunner` 调 `/control/revoke`，辅助程序把任务号记进作废名单并杀掉这个任务起的所有进程。任务进行中你把项目的开关关掉，后端对这个项目正在跑的任务做同样的事。
- 作废名单在辅助程序内存里；它重启后名单丢失，靠 `exp` 兜底。要立刻全部作废：删掉 `secret` 重启辅助程序。
- 不经 CoderFleet 单独用时：`coderfleet-helper token --root <目录> --access command` 打印一个令牌，贴进 Claude Code 的 MCP 配置。

边界：令牌在任务进程的环境变量里，同一个项目容器里的其他任务读得到；授权本来就是按项目给的，这一点接受。别的项目的容器读不到。

### 4.3 两档能做什么

| 档 | 工具 |
|---|---|
| `command` | `machine_info`、`run_command`、`list_serial_ports`、`read_serial` |
| `gui` | 以上全部，加屏幕工具（§5.3，目前只有 Mac） |

## 5. 工具

MCP 服务名 `machine`，模型看到的是 `mcp__machine__run_command` 这样的名字。

### 5.1 `machine_info()`

返回 `{system, version, arch, hostname, access, programs, gui}`：是 Mac 还是 Linux、本任务的档位、清单里放行和需确认的程序名、屏幕工具可不可用。让模型先知道自己在操作一台什么机器、能做什么。

### 5.2 `run_command(argv, cwd=".", timeout_s=120)`

| 参数 | 说明 |
|---|---|
| `argv: string[]` | 程序名加参数。不经过 shell，没有管道、重定向、通配符 |
| `cwd: string` | 相对令牌里 `root` 的路径。解析后（跟随符号链接）跑出 `root` 的拒绝 |
| `timeout_s: number` | 1–1800。到时杀掉整个进程组 |

返回：

```json
{"ran": true, "verdict": "allow", "rule": "xcodebuild", "exit_code": 0,
 "stdout": "…最后 200 行…", "stderr": "…", "truncated": true,
 "log": ".coderfleet-tasks/helper/<调用号>.log", "seconds": 41.2}
```

- 没执行时 `ran: false`，`verdict` 是 `deny`（规则拒绝或不在清单）或 `deny-unconfirmed`（没人确认或点了拒绝），`rule` 写明命中了哪条。
- 完整输出写到 `root` 下的 `.coderfleet-tasks/helper/`（容器里是 `/workspace/.coderfleet-tasks/helper/`），模型要看全文自己去读。
- 程序名只在规则文件 `path` 列出的目录里找，找不到返回 `rule: "not-installed"`。
- 子进程的环境变量是一份固定的小清单（`PATH`、`HOME`、`LANG`，Mac 上加 `DEVELOPER_DIR`），不继承辅助程序自己的环境。
- 超时：SDK 对每个 MCP 服务的 `timeout` 是每次调用的硬上限，进度通知不延长它（`sdk.d.ts` 的说明）。所以把 `machine` 的 `timeout` 设成 2500 秒，盖住「等确认 10 分钟 + 最长执行 30 分钟」。

### 5.3 串口和屏幕

- `list_serial_ports()`：Mac 列 `/dev/cu.*`，Linux 列 `/dev/ttyUSB*`、`/dev/ttyACM*`。
- `read_serial(port, baud=115200, seconds=10, reset=false)`：读最多 60 秒的串口输出。不加原生依赖：用 `stty` 设好参数后直接读设备文件。`reset=true` 用 `esptool --after hard-reset … flash-id` 代替，所以它要求装了 `esptool`。
- 屏幕工具只在 Mac 上有，不自己定义。辅助程序起一个 `cua-driver mcp` 子进程，把它列出的工具里**在白名单内的**原样转给模型（例如 `get_window_state`、`get_desktop_state`、`zoom`）。白名单在规则文件的 `gui_tools` 里，默认只有这三个只读的；点击和输入的工具名以装好后实际列出的为准，由你逐个加。Cua Driver 用它的 `bounded` 权限模式启动。
- Linux 上 `gui` 档的屏幕工具返回「这台机器不支持屏幕操作」，不退回到别的办法。

## 6. 规则和确认

### 6.1 规则文件

`~/.coderfleet-helper/policy.json`，在辅助程序那台机器上，容器里看不到。第一次启动时生成默认内容（Mac 的默认值；Linux 的 `path` 是 `/usr/bin`、`/bin`、`/usr/local/bin`，没有 `xcodebuild`、`xcrun` 两条）：

```json
{
  "path": ["/usr/bin", "/bin", "/opt/homebrew/bin"],
  "rules": [
    {"program": "xcodebuild", "action": "allow"},
    {"program": "xcrun", "action": "allow"},
    {"program": "esptool", "args_any": ["flash-id", "read-mac", "chip-id", "image-info", "get-security-info"], "action": "allow"},
    {"program": "esptool", "args_any": ["write-flash", "erase-flash", "erase-region"], "action": "confirm"}
  ],
  "gui_tools": ["get_window_state", "get_desktop_state", "zoom"]
}
```

判定顺序：**内置拒绝 → 规则里的 `deny` → `confirm` → `allow` → 都没命中就拒绝**。按「程序名 + 参数里出现的词」匹配。

内置拒绝写死在辅助程序里，规则文件改不了：`sudo`、`su`；`espefuse` 的任何烧写和读写保护；参数里有 `--do-not-confirm`；带 `--force` 的写入和擦除；工作目录或程序路径指向 `~/.coderfleet-helper/`。

模型没有改规则的工具。

**放行一个构建工具意味着什么：** `xcodebuild`、`flutter`、`make` 会执行工程里的脚本。放行它们，等于允许这个项目里的代码以你的身份在这台机器上运行。只给你信得过的项目开。

### 6.2 确认

命中 `confirm` 时，辅助程序把这次调用挂起，放进「待确认」列表，等最多 10 分钟。

- **接了 CoderFleet 时**：后端的 `helper-host.ts` 一直在长轮询 `/control/pending`。拿到后在对应任务的这一轮上挂一张带选项的卡片（`turn.permission`，用现成的 `questions` 形式，编号以 `helper:` 开头）：

  > 要在这台机器上执行：`esptool --port /dev/cu.wchusbserial10 write-flash 0x0 build/merged.bin`
  > 〔允许这一次〕〔这个任务里同样的命令都允许〕〔拒绝〕

  你在桌面 App 或手机上点，走现有的 `POST /v1/turns/<id>/permission`。那条路由里加一个分支：编号以 `helper:` 开头的答复交给 `helper-host.ts` 转给辅助程序（`/control/decide`），不发给容器里的 worker。容器里没有任何东西能替你点允许。App 现有的系统通知对「对话在等你」已经会提醒。
- **没接 CoderFleet 时**（单独用）：没有人来取「待确认」，到时间按拒绝处理。
- 10 分钟没人点，返回 `deny-unconfirmed`。
- 一轮对话同一时间只有一张卡片。worker 自己的审批卡片占着时，辅助程序的确认排在后面等。
- 选「这个任务里同样的命令都允许」后，同一任务、**完全相同的 argv** 不再问。这份记录在辅助程序内存里，随任务作废清掉。

## 7. 停止

不做单独的全局急停。它们就是任务里的工具：

| 你做什么 | 发生什么 |
|---|---|
| 点对话上的「停止」 | 现有的 `TaskRunner.cancel` 结束容器里的任务；任务一结束，`TaskRunner.finish` 调 `/control/revoke`，辅助程序杀掉这个任务起的所有进程（整个进程组），屏幕操作同时停 |
| 任务自己做完或失败 | 同上，走的是同一处 `finish` |
| 关掉项目的开关 | 这个项目正在跑的任务被作废，进程被杀；之后的任务不再拿到令牌 |
| 停掉辅助程序 | 设置页的「停止」；它退出前杀掉自己起的所有进程，所有项目都用不了 |

要专门做的只有一件：命令是辅助程序起的，不在容器里，所以容器里的任务结束不会自动带走它。`finish` 里的那次通知就是为这个。后端通知不到辅助程序时（它正好挂了），进程已经随它一起没了；通知失败记后端日志。

## 8. 数据存在哪

| 数据 | 位置 | 写法 |
|---|---|---|
| 项目授权 | 后端工作区 `projects.conf` 的 `HELPER_ACCESS` | `rewriteConf`，和挂载目录同一条路 |
| 转发端口、辅助程序端口 | 后端工作区 `config.conf` 的 `HELPER_BRIDGE_RELAY_PORT`、`HELPER_PORT` | 有缺省值，一般不用写 |
| 主密钥 | 辅助程序机器 `~/.coderfleet-helper/secret`，0600 | 只在不存在时创建一次 |
| 规则 | `~/.coderfleet-helper/policy.json` | 一个同步函数里「读 → 改 → 原子写」，中间没有 `await` |
| 操作记录 | `~/.coderfleet-helper/audit/<日期>.jsonl` | 只追加 |
| 命令完整输出 | 项目目录 `.coderfleet-tasks/helper/<调用号>.log` | 每次调用一个新文件 |
| 待确认、作废名单、「本任务内都允许」 | 辅助程序内存 | 不落盘 |

操作记录每行：时间、任务号、令牌里的 `label`、工具、参数（argv 原样；屏幕工具只记工具名和目标 App，不记截图和输入的文字）、判定、命中的规则、确认结果、退出码、耗时。

后端的 `Turn` 不加字段，令牌不落盘。

## 9. 安装和管理

### 9.1 通过界面安装

设置页新增「机器辅助程序」一块（`ui/js/settings.js`）：

| 状态 | 界面显示 | 按钮 |
|---|---|---|
| 没装 | 「没有安装。装了以后，开了开关的项目可以在这台机器上跑清单里的命令。」 | 安装 |
| 装了没跑 | 版本 | 启动 |
| 在跑 | 版本、机器名、有几个任务在用 | 停止、查看规则、查看记录 |
| 版本比 App 带的旧 | 提示可以升级 | 升级 |
| relay 还没有转发规则 | 「需要重启网络中转，正在跑的任务会断网几秒」 | 重启网络中转 |

「安装」做的事：辅助程序的包随后端一起带着（桌面 App 的资源里，以及 `scripts/package-backend.mjs` 打的 Linux 后端包里各放一份），后端把它拷到 `~/.coderfleet-helper/bin/`，生成主密钥和默认规则，然后启动。

启动和看护照后端自己被 App 拉起的办法（`ensureLocal`）：后端启动时探一下，装了但没在跑就把它作为独立进程拉起来；版本不对就换掉。它不是后端的子进程，后端重启不影响正在跑的命令。

这里说的「这台机器」是**后端所在的机器**：本机后端时是你的 Mac；后端装在远程 Linux 服务器上时是那台服务器，界面上会写明机器名，免得弄错。

### 9.2 界面和命令行

| 做什么 | 桌面 App | 命令行 | 接口 |
|---|---|---|---|
| 安装 / 启动 / 停止 / 升级 | 设置页 | `coderfleet-backend helper install\|start\|stop\|upgrade` | `POST /v1/helper/<动作>` |
| 看状态 | 设置页 | `coderfleet-backend helper status` | `GET /v1/helper` |
| 重启 relay | 设置页的提示 | `coderfleet-backend helper restart-relay` | `POST /v1/helper/restart-relay` |
| 给项目开关 | 项目菜单「机器操作…」（`ui/js/projects.js`，挨着「挂载目录…」） | `coderfleet-backend helper access <项目> off\|command\|gui` | `PUT /v1/projects/<名>/helper`；`GET /v1/projects` 每项带 `helper` |
| 看 / 改规则 | 设置页的规则表 | `coderfleet-helper policy show\|set\|remove` | 后端转 `/control/policy` |
| 看操作记录 | 设置页的记录表 | `coderfleet-helper audit [-n 50]` | 后端转 `/control/audit` |

**两边是不是同等能力，如实说：** 这个功能的每一项两边都有。规则和记录的命令在辅助程序自己的命令行里（数据是它的），要在它那台机器上跑。另外，Node 这边的 `coderfleet-backend` 今天只有 `serve`、`init`、`status`、`job`、`schedule`，项目和账号管理都只在 App 里；这份设计不补那些，只保证这个功能自己不再多欠一笔。

`/v1/helper/…` 走主令牌，不加进 `DEVICE_ROUTES`：手机能点确认卡片，但不能安装、改规则。

### 9.3 版本对不上

辅助程序的 `/control/status` 返回自己的版本和约定版本号（从 1 开始）。后端只和约定版本号相同的辅助程序配合；不同就不给任务发令牌，界面提示升级。不做新旧兼容。

## 10. 装在哪些机器上

| 情况 | 这一版 | 说明 |
|---|---|---|
| 后端和 Docker 在你的 Mac 上，辅助程序也在 Mac 上 | 做 | 命令、刷固件、屏幕操作 |
| 后端和 Docker 在一台 Linux 服务器上，辅助程序也在那台服务器上 | 做 | 命令和串口；没有屏幕操作 |
| 辅助程序在第三台机器上（比如后端在服务器，想操作你的 Mac） | **不做** | 见下 |

第三台机器为什么先不做：容器到它要多一段路（宿主机到那台机器），项目文件也不在那台机器上（`run_command` 没有可用的工作目录，固件要先传过去）。这两件事都能解决——App 分支里现成有 SSH 安装和端口转发（`src/remote.ts` 的 `install`、`Tunnel`），relay 上给每台机器加一条转发——但现在没有人这么用。辅助程序本身已经是「装在哪就操作哪」，到时只加 CoderFleet 这边的接入，辅助程序和令牌都不用改。

研究里留的五件事，现在的取法：

| # | 问题 | 取法 |
|---|---|---|
| 1 | 辅助程序住在哪 | 单独的程序，由 CoderFleet 后端安装和拉起 |
| 2 | 屏幕操作对不对真桌面开 | 对真桌面做，第三期，默认关，点击和输入默认不在白名单 |
| 3 | OrbStack 直通时开发板对谁可见 | 不走直通：直通后 `espefuse` 烧写不经过规则，还要动 compose 里的设备 |
| 4 | 确认的粒度 | 默认每次都问；可选「这个任务里同样的命令都允许」 |
| 5 | Mac 不是宿主的情况 | 辅助程序的形态已经支持，CoderFleet 的接入这一版不做 |

## 11. 三个场景，从头到尾

### 11.1 在容器里改代码，在 Mac 上编译

前提：本机后端；设置页装好并启动了辅助程序；项目 reminis 开到 `command`；规则里 `xcodebuild` 是 `allow`。

1. 你在 reminis 项目里发消息。`TaskRunner.launch` 读到 `HELPER_ACCESS=command`，向 `helper-host.ts` 要一个令牌（`root` 是项目路径），放进任务环境。
2. `runClaude` 给这一轮加上 `machine` 服务。Claude Code 经 relay 转发连上辅助程序，令牌通过，列出四个工具。
3. 模型改完代码，调 `run_command(argv=["xcodebuild","-scheme","Runner","build"], cwd="ios", timeout_s=900)`。
4. 辅助程序：`cwd` 换算成 `<项目路径>/ios` → 命中 `xcodebuild allow` → 起子进程 → 结束后写完整日志和一行记录。
5. 模型拿到 `{"ran": true, "exit_code": 65, "stderr": "…最后 200 行…", "log": "…"}`，读报错，改代码，再来一轮。
6. 中途你点「停止」：任务结束 → 后端通知作废 → `xcodebuild` 被杀。

### 11.2 刷固件：改 → 编译 → 刷 → 看日志

前提：同上；这台机器装了 `esptool`；开发板插在这台机器上。Mac 和 Linux 都一样。

1. 模型在容器里编译并合并出 `build/merged.bin`（项目目录两边都看得到，不需要传文件）。
2. `list_serial_ports()` → `["/dev/cu.wchusbserial10", …]`。
3. `run_command(["esptool","--port","/dev/cu.wchusbserial10","flash-id"])` → 命中 `allow`，直接执行，确认板子在线。
4. `run_command(["esptool",…,"write-flash","0x0","build/merged.bin"], timeout_s=300)` → 命中 `confirm` → 对话里出现卡片，桌面和手机都有通知 → 你点「这个任务里同样的命令都允许」→ 执行 → 返回退出码和输出。
5. `read_serial(port, seconds=15, reset=true)` → 返回启动日志。不正常就回到第 1 步；第 4 步不会再问你。
6. 模型去调 `espefuse burn-efuse …`：内置拒绝，记录里留一行。

### 11.3 屏幕操作（只有 Mac）

前提：项目开到 `gui`；装了 Cua Driver 并给它开了屏幕录制和辅助功能；你把需要的点击 / 输入工具加进了 `gui_tools`。

1. 任务启动同 11.1，工具列表里多出白名单内的屏幕工具。
2. 模型调 `get_window_state(…)`。辅助程序：档位够 → 屏幕没被别的任务占用，记为本任务占用 → 该 App 在本任务里第一次被碰，挂确认（「允许任务操作 Littlewhen？」）→ 你允许 → 转给 `cua-driver mcp` → 把返回的窗口结构和截图原样交回。
3. 模型调点击工具 → 记录（工具名、目标 App）→ 转给 Cua Driver → 返回结果。
4. 你点「停止」，点击立刻停。任务结束，占用释放。

## 12. 分期和验收

辅助程序自己的测试放在 `helper/test/`，CoderFleet 这边的放 `test/helper.test.mjs`，都用 `node --test`，不依赖 Electron。「Mac 上才能验」要在你的 Mac 上手工走一遍，我这边做不了。

### 第一期：命令

交付：`helper/`（MCP 服务、令牌、规则、执行、记录、管理口、命令行）；`src/helper-host.ts`；`gostConfig` / `generateCompose` 的转发和环境变量；`Lifecycle.restartRelay`；`HELPER_ACCESS` 读、写、界面、命令行全接；`TaskRunner.launch` / `finish` 和 `runClaude` 的改动；`turns/<id>/permission` 的 `helper:` 分支；设置页和项目菜单；`coderfleet-backend helper …`；使用说明。

容器里可验：

- [ ] 令牌缺失、签名错、过期、任务已作废 → 401；用 `command` 档的令牌调屏幕工具 → 被拒
- [ ] 管理口不带主密钥 → 401；带任务令牌也 → 401
- [ ] 项目是 `off` → 任务环境里没有 `CODERFLEET_HELPER_TOKEN`，`mcpServers` 里没有 `machine`
- [ ] 任务进行中把项目改成 `off` → 令牌被作废，下一次调用 401
- [ ] 放行的命令执行并返回输出；清单外的拒绝；内置拒绝项即使规则文件写了 `allow` 也拒绝
- [ ] `cwd` 用 `..` 或符号链接跑出 `root` → 拒绝
- [ ] 子进程环境里没有辅助程序进程的环境变量
- [ ] 超时杀掉整个进程组（子进程再起的孙进程也没了）
- [ ] 任务结束（做完、失败、取消各一次）→ 这个任务起的进程被杀，别的任务的不受影响
- [ ] 需确认的命令：答允许 → 执行；答拒绝或超时 → `deny-unconfirmed`；「本任务都允许」后同 argv 不再问、换一个参数仍然问；没有人取待确认时到点拒绝
- [ ] `helper:` 开头的答复不进 worker 的信箱；worker 的卡片占着时排队
- [ ] 每次调用恰好一行记录；记录目录不可写时调用不执行
- [ ] 生成的 relay 配置里有 `helper-bridge`，容器环境里有 `CODERFLEET_HELPER_BRIDGE_PORT`（加进 `test/compose.test.mjs`）
- [ ] 手机的设备令牌请求 `/v1/helper` → 403
- [ ] 约定版本号不同 → 不发令牌，状态里写明要升级
- [ ] 界面和命令行改项目开关，读写的是 `projects.conf` 里同一个值
- [ ] 辅助程序在 Linux 上跑通上面全部（这个容器就是 Linux）
- [ ] `npm run build` 和 `node --test test/*.test.mjs` 全过

Mac 上才能验：

- [ ] 重启 relay 后，真实任务经 `:8767` 到达辅助程序并调通工具（研究 §2 里现有的 `:8766` 转发当时连上后被对端断开，原因没查；这次要先弄清）
- [ ] 真实的 Claude 任务里 `mcp__machine__*` 在普通模式和自动模式下都不被 Claude Code 自己拦住
- [ ] 一次真实的 `xcodebuild` 超过 5 分钟不被中断
- [ ] 由后端拉起的辅助程序，`xcodebuild` 和真机安装能用到钥匙串里的签名证书
- [ ] 退出桌面 App 后辅助程序还在、任务还能用；重启 Mac 后打开 App，辅助程序被重新拉起

### 第二期：刷固件

交付：`list_serial_ports`、`read_serial`；默认规则里的 `esptool` 条目；使用说明里的刷机一节。

容器里可验：

- [ ] `read_serial` 对着伪终端读到写入的内容，`seconds` 到点返回
- [ ] `esptool write-flash` 走确认，`espefuse burn-*`、`--do-not-confirm`、`--force` 写入被内置拒绝

Mac 上才能验：

- [ ] 开发板出现在 `list_serial_ports` 里；`flash-id` 成功
- [ ] `stty` 加直接读设备文件在 macOS 上读得到 115200 的日志
- [ ] 走完 §11.2 全程；`reset=true` 确实让板子重启（E1001 有没有接自动复位线，研究里没查到）

### 第三期：屏幕（Mac）

交付：Cua Driver 转接、`gui_tools` 白名单、屏幕占用、按 App 确认；使用说明里的安装和授权一节。

容器里可验（用一个假的 stdio MCP 程序顶替 `cua-driver`）：

- [ ] `command` 档看不到也调不了屏幕工具；Linux 上 `gui` 档得到「不支持」
- [ ] 不在 `gui_tools` 里的工具不出现、直接调用被拒
- [ ] 第二个任务调用时返回「屏幕正被任务 X 使用」；第一个任务结束后可用
- [ ] 图片结果原样到达 MCP 客户端
- [ ] 找不到 `cua-driver` 时返回写明原因的错误

Mac 上才能验：

- [ ] 由辅助程序起的 `cua-driver mcp`，权限确实记在 `CuaDriver.app` 上（文档这么写，没实测）
- [ ] 走完 §11.3 全程；点「停止」后点击立刻停止
- [ ] 锁屏、息屏时的表现（研究里没找到苹果的说法）

## 13. 你要做的

| 期 | 要做的 |
|---|---|
| 一 | 升级桌面 App；设置页点「安装」；按提示重启一次网络中转；给项目开开关。不需要任何系统授权 |
| 二 | 装 `esptool`（Mac 上例如 `brew install esptool`），确认它所在目录在规则的 `path` 里 |
| 三 | 装 `CuaDriver.app`；在「系统设置 → 隐私与安全性」里给它开**屏幕录制**和**辅助功能**（只能手工点）；用屏幕操作时保持登录不锁屏 |

## 14. 对照项目规矩

| 规矩（`CLAUDE.md`） | 怎么满足 |
|---|---|
| 账号 / 容器 / 代理隔离不能破 | 新增的是 relay 上一条指向宿主固定端口的转发，和现有 `service-bridge` 同一种；不给容器挂设备或目录；不接触任何账号的登录数据。这条转发所有容器都连得上，权限只靠按任务签发的令牌 |
| 两个入口同等能力 | §9.2，同一期交付 |
| 字段读、写、界面一次接全 | `HELPER_ACCESS` 在第一期同时接上读、写、界面、命令行和使用处；`Turn` 不加字段 |
| 状态文件一次同步读改写 | 规则文件的修改走同一个同步函数；记录只追加；令牌无状态 |
| 引用失效时明确拒绝，不悄悄退回 | 令牌任何一项不成立都 401；版本对不上不发令牌；Cua Driver 不可用时报错而不是改用别的截屏办法；Linux 上屏幕工具明确说不支持 |
| 跨入口的逻辑只写一份 | 判定只在辅助程序里；界面和命令行改规则走同一个管理口；确认复用现有的审批卡片和路由 |
| 项目问答是默认入口 | 只是任务里多出一组工具，对话和会话归属都不变 |

## 15. 这份设计里没有验证的

- §12 里所有「Mac 上才能验」的条目。
- 我只读了 `node-app/` 的代码，没有改它，也**没有跑它的测试**（装依赖和构建会往那个目录里写文件，超出这次允许改动的范围）。文中点到的文件名和函数名是用 `grep` 在 `61af9ed` 上核对的。
- gost 改了配置文件后是否必须重启才生效，我是按「启动时读一次」写的，没有查它有没有热加载。有的话「重启网络中转」这一步可以换成更轻的做法。
- 重启 relay 对正在跑的任务的实际影响（断网几秒后能不能自己恢复）没有测。
- `host.docker.internal` 在 Linux 上指向网桥地址、在 Mac 上能到本机回环，这是 Docker 的通常行为，这次没有逐个实测。
- Cua Driver 的点击、输入工具叫什么名字。README 只确认了 `get_window_state`、`get_desktop_state`、`zoom` 三个。
- 辅助程序的 MCP 服务是自己按协议写还是引用官方的 MCP 包，留到实现时定；原型是自己写的，够用。

## 16. 来源

- 研究文档及其来源清单：`docs/research/mac-helper-for-container-agents-20261125.md` §11。
- Cua Driver README「macOS process identity and permissions」「Permission modes」「Claude Code registration」三节（2026-11-25 取回）：https://github.com/trycua/cua/blob/main/libs/cua-driver/README.md
- `node-app/`（分支 `codex/node-electron-migration`，提交 `61af9ed`）：`src/compose.ts`（`gostConfig`、`generateCompose`、`service-bridge`、`CODERFLEET_MCP_BRIDGE_PORT`、`proxy-relay-config.yaml`）、`src/lifecycle.ts`（`Lifecycle`、`startProject`、`restartProject`）、`src/tasks.ts`（`TaskRunner`、`launch`、`finish`、`cancel`、`decide`、`PERMISSION_TIMEOUT_SECONDS`）、`src/claude-worker.ts`（`runClaude`、`canUseTool`）、`src/docker.ts`（`execDetached`）、`src/server.ts`（`DEVICE_ROUTES`、`turns/<id>/permission` 路由）、`src/state.ts`（`Permission`）、`src/conf.ts`（`rewriteConf`、`projectMountSpecs`、`setProjectMounts`、`WorkspaceProject`）、`src/local-backend.ts`（`ensureLocal`、`probeLocal`）、`src/remote.ts`（`install`、`Tunnel`）、`src/cli.ts`、`scripts/package-backend.mjs`、`ui/js/projects.js`、`ui/js/settings.js`、`test/compose.test.mjs`、`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（`McpHttpServerConfig`）。
