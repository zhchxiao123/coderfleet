# Mac 通道：让容器里的 Claude Code 在 Mac 上跑命令、刷固件、操作屏幕

设计日期：2026-11-25（第二版，改落在 Node 技术栈）。前置研究：`docs/research/mac-helper-for-container-agents-20261125.md`（下文写「研究 §n」）。原型：`examples/mac-helper-prototype/`。

代码落点是桌面 App 分支 `codex/node-electron-migration` 的 `node-app/`（核对时的提交 `61af9ed`）。下文的 `src/…`、`ui/…`、`test/…` 都相对 `node-app/`。本文没有任何要新写或要改的 Python 文件；这个仓库里的 Python server 不参与。

## 1. 一页说清

- **在 Mac 上动手的是桌面 App 自己**，不另写辅助程序，也不放在后端里。后端可能跑在远程服务器上，只有 App 一定在你的 Mac 上；App 也是一个固定身份的程序，macOS 的权限好记。
- **容器不联网到 Mac。** 任务要在 Mac 上做事时，往项目目录里写一个请求文件；后端看到后交给 App；App 判定、执行，结果原路写回。不开端口、不改 `docker-compose.yml`、不改 relay。第一版里那条 HTTP 通道、任务令牌、`/mac-mcp/` 入口都不要了。
- **默认谁也用不了。** 按项目开，两档：`command`（清单内的命令，含刷固件）和 `gui`（再加看屏幕、点、输入）。没开的项目，任务里根本没有这组工具。
- **命令按清单走**：拒绝 / 要你点允许 / 放行，不在清单里的一律拒绝。清单和记录都存在 Mac 上。「要你点允许」用对话里现成的审批卡片，桌面和手机都能点，10 分钟没人点就是拒绝。
- **屏幕操作交给 Cua Driver**，App 只做转接和把关。
- **刷固件在 Mac 上执行 `esptool`**，不用 OrbStack 串口直通（直通后烧 eFuse 这类救不回来的操作就拦不住了）。
- **退出 App，通道就断了。** 另有急停按钮和命令。
- 分三期交付，每期单独可用（§12）。

## 2. 组成和职责

| 部分 | 在哪 | 管什么 | 新增 / 已有 |
|---|---|---|---|
| 工具入口 | 新文件 `src/mac-mcp.ts`：容器里的一个 stdio MCP 小程序，随 worker 一起拷进项目（加进 `src/tasks.ts` 的 `BUNDLE_FILES`） | 把模型的工具调用写成请求文件，等结果文件 | 新 |
| 任务配置 | `src/claude-worker.ts` 的 `runClaude`：`sdk.query` 的 `options` 增加 `mcpServers.mac`；`canUseTool` 对 `mcp__mac__` 开头的工具直接放行 | 项目开了通道才给任务这组工具 | 改 |
| 任务启动 | `src/tasks.ts` 的 `TaskRunner.launch`：spec 里加 `mac_access`，`execDetached` 的环境里加 `CODERFLEET_MAC_KEY` | 下发档位和签名密钥 | 改 |
| 收发 | 新文件 `src/mac-calls.ts`（后端）；`TaskRunner.tick` 每轮调它一次 | 扫请求文件、验签名、查项目授权、排队给 App、把结果写回、落完整日志 | 新 |
| 接口 | `src/server.ts` 的路由表加 `mac/…` 和 `projects/<名>/mac` | App 取请求、交结果、请求确认；项目开关 | 改 |
| 项目授权 | `src/conf.ts` 新增 `projectMacAccess`、`setProjectMac`（照 `projectMountSpecs`、`setProjectMounts` 写） | 读写 `projects.conf` 的 `MAC_ACCESS` | 改 |
| 执行端 | 新文件 `src/mac-executor.ts`（不依赖 Electron，和 `src/remote.ts` 一样可以直接测）；`src/desktop.ts` 在连上后端后启动它 | 取请求 → 判定 → 需要时请求确认 → 执行 → 记审计 → 交结果 | 新 |
| 规则 | 新文件 `src/mac-policy.ts`：`decide(argv)` | 拒绝 / 确认 / 放行 / 默认拒绝 | 新 |
| 确认 | `src/state.ts` 的 `Permission`（带 `questions` 的那种）、`src/server.ts` 的 `turns/<id>/permission` 路由 | 在这一轮对话上挂卡片，等人点 | 已有，路由里加一个分支 |
| 屏幕后端 | Cua Driver（`CuaDriver.app` + `cua-driver mcp`），由执行端启动 | 截屏、点击、输入 | 外部，第三期才装 |
| 管理面 | `ui/js/projects.js`、`ui/js/settings.js`、`src/cli.ts`（`coderfleet-backend mac …`） | 开关、规则、审计、急停 | 改 |

新文件 `src/mac-mcp.ts`、`src/mac-calls.ts`、`src/mac-executor.ts`、`src/mac-policy.ts`、`test/mac.test.mjs` 当前都不存在（`ls src/mac* test/mac*` 无结果）。

## 3. 调用链

```
容器里的 Claude Code
  │  stdio MCP（服务名 mac）
  ▼
src/mac-mcp.ts（容器里，任务的子进程）
  │  写  <项目>/.coderfleet-tasks/<任务号>.mac/calls/<调用号>.json     带签名
  │  等  <项目>/.coderfleet-tasks/<任务号>.mac/results/<调用号>.json
  ▼
后端 src/mac-calls.ts（TaskRunner.tick 每 250 毫秒扫一次）
  验签名 → 这一轮在不在跑 → 项目开没开、档位够不够          不过 → 直接写回拒绝
  ▼  排进队列
桌面 App 的 src/mac-executor.ts（长轮询 GET /v1/mac/calls，用 App 已有的后端凭证）
  急停了没有 → 规则判定 → 需要的话经后端挂确认卡片 → 执行 → 审计
  ▼
子进程（xcodebuild / esptool / …）或 Cua Driver
  ▼
结果 POST 回后端 → 后端写 results/<调用号>.json 和完整日志 → 工具调用返回
```

通道在 Node 后端怎么补，逐项说：

| 研究和第一版里的环节 | 现在怎么办 |
|---|---|
| compose 生成（`src/compose.ts` 的 `generateCompose`、`gostConfig`） | **不改。** 通道不经网络。`gostConfig` 里现成的 `service-bridge` 指向的是 `config.conf` 的 `CODERFLEET_PORT`（Python server 的端口），不是 Node 后端；Node 后端默认只听 `127.0.0.1`。要走网络就得改转发目标并让后端对容器网段开口子，走文件这两件事都省了，研究 §2 里转发器被 reset 的问题也不用再查 |
| 任务的 MCP 配置 | `runClaude` 里，`spec.mac_access` 不是 `off` 时给 `sdk.query` 的 `options` 加 `mcpServers: { mac: { type: 'stdio', command: process.execPath, args: [<mac-mcp.js 的路径>, <请求目录>], timeout: 2_500_000 } }`。`McpStdioServerConfig` 和 `timeout` 字段在 App 用的 SDK（0.3.330）的 `sdk.d.ts` 里查得到；现在的 `runClaude` 没有传过 `mcpServers` |
| 令牌下发 | 没有网络入口，也就没有要出示的令牌。改为签名密钥：`CODERFLEET_MAC_KEY = HMAC-SHA256(后端 config 的 token, "mac:" + 任务号)`，由 `TaskRunner.launch` 放进 `execDetached` 的环境（现在那里只有 `CODERFLEET_TASK_ID`）。`TaskRunner` 的构造函数要多收一个算密钥的函数，在 `src/server.ts` 的 `new TaskRunner(…)` 处传入。密钥不写进 spec 文件，不落盘 |
| 入口鉴权 | 两段。容器 → 后端：每个请求文件带 `HMAC(密钥, 请求内容)`，后端重算比对（`timingSafeEqual`），再查这一轮是活动的、是本服务启动的（`turn.origin === 'node'`）、项目的 `MAC_ACCESS` 不是 `off`。后端 → App：`/v1/mac/…` 和其他 `/v1/` 路由一样要主令牌；**不**加进 `DEVICE_ROUTES`，手机配对的设备令牌取不到请求 |

## 4. 身份和授权

### 4.1 项目授权

`projects.conf` 新增一个键 `MAC_ACCESS=off|command|gui`，缺省 `off`；`gui` 包含 `command`。`projectMacAccess(project)` 从 `WorkspaceProject.record` 读，非法值按 `off` 处理并在后端日志里告警。`setProjectMac` 用 `rewriteConf` 写。这个仓库的 Python server 读 `projects.conf` 时按键取值（`record.get`），多一个键不影响它。

只接**容器里的 Claude 任务**（`src/claude-worker.ts`）。Codex、OpenCode 等其他 worker 这一版不接；`mac-mcp.ts` 是标准的 stdio MCP 程序，以后接它们不用改通道。给项目开通道时，如果它的账号不是 Claude，接口返回里带一句提示，界面和命令行都显示。

### 4.2 一个请求算谁的

- 请求目录在项目目录里，只有这个项目的容器看得到，所以**请求出现在哪个项目的哪一轮目录里，就算那一轮的**。后端按目录名找这一轮，不看请求里自报的任何身份。
- 签名密钥只在任务进程的环境变量里。它防的是这种情况：别的项目把这个项目的目录挂进了自己的容器（`projectMountSpecs`），能往目录里写文件，但拿不到密钥，写出来的请求验不过。
- 同一个项目里的其他任务能读到彼此的环境变量，可以冒充同项目的另一轮。授权本来就是按项目给的，这一点接受。
- 关掉项目的通道立即生效（每个请求现查）；这一轮结束后，它目录里再出现的请求一律不理。
- 签名不过、这一轮不在跑、项目没开，都是明确拒绝并记后端日志，不退回到别的任务或默认授权。

### 4.3 哪台 Mac 接

App 的每个后端档案（`src/desktop.ts` 的 `Profile`，存在 `backends.json`）加一个开关「让这个后端的任务操作这台 Mac」，默认关。开着并且连着时，执行端才去取请求。

同一个后端同一时间只认一台 Mac：执行端取请求时带上自己的编号和机器名；已经有另一台在取（60 秒内取过）时，后来的那台得到 409 和对方的机器名，界面上显示「另一台 Mac（名字）正在接」。不自动抢。

没有任何 Mac 在接时，请求等 20 秒后返回「桌面 App 没有连接，或者没有打开这台 Mac 的开关」。

### 4.4 两档能做什么

| 档 | 工具 |
|---|---|
| `command` | `mac_info`、`run_command`、`list_serial_ports`、`read_serial` |
| `gui` | 以上全部，加 Cua Driver 的屏幕工具（§5.3） |

截屏放在 `gui` 而不是更低的档：屏幕上有什么就给模型看什么，比清单内的命令暴露得多。

## 5. 工具

MCP 服务名 `mac`，模型看到的是 `mcp__mac__run_command` 这样的名字。`mac-mcp.ts` 自己不判定、不执行，只转交。

### 5.1 `mac_info()`

返回 `{system, version, arch, access, programs, paused, files}`：系统版本、本任务的档位、清单里放行和需确认的程序名、是否急停、Mac 上看不看得到项目文件（§5.4）。让模型先知道能做什么，少撞墙。

### 5.2 `run_command(argv, cwd=".", timeout_s=120)`

| 参数 | 说明 |
|---|---|
| `argv: string[]` | 程序名加参数。不经过 shell，没有管道、重定向、通配符 |
| `cwd: string` | 相对项目目录的路径。解析后（跟随符号链接）跑出项目目录的拒绝 |
| `timeout_s: number` | 1–1800。到时杀掉整个进程组 |

返回：

```json
{"ran": true, "verdict": "allow", "rule": "xcodebuild", "exit_code": 0,
 "stdout": "…最后 200 行…", "stderr": "…", "truncated": true,
 "log": ".coderfleet-tasks/mac/<调用号>.log", "seconds": 41.2}
```

- 没执行时 `ran: false`，`verdict` 是 `deny`（规则拒绝或不在清单）、`deny-unconfirmed`（没人确认或点了拒绝）、`paused`（急停中）、`unavailable`（没有 Mac 在接）之一，`rule` 写明命中了哪条。
- 完整输出由执行端交回后端（上限 5 MB，超出只留末尾），后端写到项目目录的 `.coderfleet-tasks/mac/`，模型要看全文自己去读。
- 程序名只在规则文件 `path` 列出的目录里找，找不到返回 `verdict: "deny", rule: "not-installed"`。
- 子进程的环境变量是一份固定的小清单（`PATH`、`HOME`、`LANG`、`DEVELOPER_DIR`），不继承 App 的环境。
- 超时：SDK 对每个 MCP 服务的 `timeout` 是每次调用的硬上限，进度通知不延长它（`sdk.d.ts` 的说明）。所以不发进度通知，直接把 `mac` 的 `timeout` 设成 2500 秒，盖住「等确认 10 分钟 + 最长执行 30 分钟」。

### 5.3 串口和屏幕

- `list_serial_ports()`：列 `/dev/cu.*`。
- `read_serial(port, baud=115200, seconds=10, reset=false)`：读最多 60 秒的串口输出。不给 App 加原生依赖：用 `stty -f <端口> <波特率> raw` 设好参数后直接读设备文件。`reset=true`（拉一下 RTS 让板子重启）用 `esptool --after hard-reset … flash-id` 代替，所以它要求 Mac 上装了 `esptool`。
- 屏幕工具不自己定义。执行端起一个 `cua-driver mcp` 子进程，把它列出的工具里**在白名单内的**原样转给模型（名字不变，例如 `get_window_state`、`get_desktop_state`、`zoom`）。白名单在规则文件的 `gui_tools` 里，默认只有这三个只读的；点击和输入的工具名以装好后实际列出的为准，由你逐个加。Cua Driver 用它的 `bounded` 权限模式启动。

### 5.4 Mac 上看不看得到项目文件

| 后端在哪 | 项目目录 | `run_command` 的 `cwd` |
|---|---|---|
| 这台 Mac 上（本机后端） | 就在 Mac 上，容器里改的文件 Mac 上立刻看得到 | 项目目录下的真实路径 |
| 远程服务器（SSH 或远程后端） | 在服务器上，Mac 上没有 | 你在 App 里给这个项目指定的一个 Mac 目录；没指定就拒绝执行并说明原因 |

远程后端时，这一版**不在服务器和 Mac 之间传文件**：屏幕操作和不依赖项目文件的命令可以用；「容器里编译、Mac 上刷」这种要先把固件拿到 Mac，需要你自己同步（比如那个 Mac 目录是同一个 git 仓库）。传文件的工具等有人真的这么用了再加。

## 6. 规则和确认

### 6.1 规则文件

在 Mac 上：`~/.coderfleet-mac/policy.json`（可用环境变量 `CODERFLEET_MAC_HOME` 换目录）。容器和远程后端都碰不到它。第一次用到时生成默认内容：

```json
{
  "paused": false,
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

内置拒绝写死在 `src/mac-policy.ts` 里，规则文件改不了：`sudo`；`espefuse` 的任何烧写和读写保护；参数里有 `--do-not-confirm`；带 `--force` 的写入和擦除；`cwd` 或程序路径指向 `~/.coderfleet-mac/`。

规则只能由你在 Mac 上改（§8），模型没有改规则的工具。

**放行一个构建工具意味着什么：** `xcodebuild`、`flutter` 会执行工程里的脚本。放行它们，等于允许这个项目里的代码以你的身份在 Mac 上运行。只给你信得过的项目开。

### 6.2 确认

命中 `confirm` 时，执行端 `POST /v1/mac/calls/<调用号>`（`state: "confirm"`，带标题和命令原文）。后端在这一轮上挂一张带选项的卡片（`turn.permission`，用现成的 `questions` 形式，编号以 `mac:` 开头）：

> 要在 Mac 上执行：`esptool --port /dev/cu.wchusbserial10 write-flash 0x0 build/merged.bin`
> 〔允许这一次〕〔这个任务里同样的命令都允许〕〔拒绝〕

- 你在桌面 App 或手机上点，走现有的 `POST /v1/turns/<id>/permission`。那条路由里加一个分支：编号以 `mac:` 开头的答复交给 `mac-calls.ts`，不发给容器里的 worker（现在所有答复都经 `TaskRunner.decide` 发给 worker）。这样容器里没有任何东西能替你点允许。
- App 现有的系统通知（`src/notifications.ts`）对「对话在等你」已经会提醒，不用另做。
- 10 分钟没人点（`PERMISSION_TIMEOUT_SECONDS`）按拒绝处理，返回 `deny-unconfirmed`。
- 一轮对话同一时间只有一张卡片。worker 自己的审批卡片占着时，Mac 的确认排在后面等，计时从挂出来那一刻算。
- 选「这个任务里同样的命令都允许」后，同一任务、**完全相同的 argv** 不再问。这份记录只在执行端内存里，App 重启就重新问。
- 答复由后端转给执行端。后端在远程服务器上时，这等于信任那台服务器如实转达；内置拒绝和规则仍然在 Mac 上判，服务器改不了。

## 7. 数据存在哪

| 数据 | 位置 | 写法 |
|---|---|---|
| 项目授权 | 后端工作区 `projects.conf` 的 `MAC_ACCESS` | `rewriteConf`，和挂载目录同一条路 |
| 这台 Mac 接不接、远程项目对应的 Mac 目录 | Mac 上 App 的 `backends.json`（`Profile` 的新字段） | `atomicJSON`，和现在存档案一样 |
| 规则和急停标记 | Mac 上 `~/.coderfleet-mac/policy.json` | 一个同步函数里「读 → 改 → 原子写」，中间没有 `await` |
| 审计 | Mac 上 `~/.coderfleet-mac/audit/<日期>.jsonl` | 只追加，每条一次 `appendFileSync` |
| 请求和结果 | 项目目录 `.coderfleet-tasks/<任务号>.mac/` | 每个调用各一个文件，先写临时文件再改名；这一轮结束时删掉 |
| 命令完整输出 | 项目目录 `.coderfleet-tasks/mac/<调用号>.log` | 每次调用一个新文件 |
| 排队中的请求、「本任务内都允许」 | 后端内存 / 执行端内存 | 不落盘；后端重启时未完成的请求按失败写回 |

审计每行：时间、后端、任务号、项目、工具、参数（argv 原样；屏幕工具只记工具名和目标 App，不记截图和输入的文字）、判定、命中的规则、确认结果、退出码、耗时。

`Turn` 不加字段，签名密钥不落盘：没有要同步的状态。

## 8. 管理面：桌面 App 和命令行

| 做什么 | 桌面 App | 命令行 | 落在哪 |
|---|---|---|---|
| 给项目开关通道 | 项目菜单「Mac 通道…」（`ui/js/projects.js`，挨着「挂载目录…」） | `coderfleet-backend mac access <项目> off\|command\|gui` | `PUT /v1/projects/<名>/mac`；`GET /v1/projects` 每项带 `mac` |
| 这台 Mac 接不接 | 设置页「Mac 通道」的开关（`ui/js/settings.js`） | 没有 | App 的 `backends.json` |
| 看状态 | 同一页 | `coderfleet-backend mac status` | 后端 `GET /v1/mac/status`（哪台在接）+ Mac 上的规则文件 |
| 看 / 改规则 | 同一页的规则表 | `coderfleet-backend mac policy show`、`policy set <程序> allow\|confirm\|deny [--args …]`、`policy remove <序号>` | Mac 上的规则文件，两边调 `src/mac-policy.ts` 的同一组函数 |
| 看审计 | 同一页的记录表 | `coderfleet-backend mac audit [--project P] [-n 50]` | Mac 上的审计文件 |
| 急停 / 恢复 | 同一页的按钮 | `coderfleet-backend mac stop`、`mac resume` | 规则文件的 `paused` |

急停：把 `paused` 置为真；执行端每秒看一次这个标记，发现后杀掉通道起的所有子进程和 Cua Driver 子进程。之后所有调用返回 `paused`，直到你恢复。退出 App 的效果相同（执行端退出时先杀子进程）。

**两边是不是同等能力，如实说：**

- 这个功能本身：除了「这台 Mac 接不接」只在 App 里（它是 App 自己的设置，命令行不替 App 改档案），其余每一项两边都有。
- 规则、审计、急停的命令要在 Mac 上跑（文件在 Mac 上）。后端在远程服务器时，服务器上的 `coderfleet-backend mac policy …` 改的是服务器本地的文件，没有用；命令会在没有 App 接入记录时提示这一点。
- Node 这边的命令行今天只有 `serve`、`init`、`status`、`job`、`schedule`，项目和账号管理都只在 App 里。所以整体上命令行本来就比 App 少，这份设计不补那些，只保证 Mac 通道自己不再多欠一笔。

## 9. 出错时怎么表现

| 情况 | 表现 |
|---|---|
| App 没开 / 没连这个后端 / 开关没开 | 等 20 秒后 `ran: false, verdict: "unavailable"`，写明原因 |
| 另一台 Mac 已经在接 | 后来的 App 得到 409，界面显示对方机器名；任务不受影响 |
| 签名不对 / 这一轮已结束 | 后端写回拒绝并记日志；已结束的不理 |
| 任务跑到一半你关了通道 | 下一次调用被拒，说明项目没有开通 |
| 档位不够（`command` 档调屏幕工具） | 工具返回错误，写明需要 `gui` |
| 规则拒绝 / 不在清单 / 程序没装 | `ran: false` 加原因，见 §5.2 |
| 没人确认 | `deny-unconfirmed` |
| 命令超时 | 杀进程组，返回 `exit_code: null, timed_out: true` 和已有的输出 |
| 命令执行中 App 退出或断线 | 执行端退出前杀子进程；后端 60 秒没再见到这台 Mac，把它名下未完成的调用按失败写回。刷机被打断可以重刷（研究 §5.3） |
| 命令执行中后端重启 | 排队中的调用丢失，后端启动时把各轮目录里没有结果的请求按失败写回；执行端交结果时得到 404，丢弃 |
| 这一轮被取消 | 后端通知执行端（长轮询的返回里带「取消」），执行端杀掉这一轮的子进程 |
| 远程后端、项目没指定 Mac 目录 | `run_command` 拒绝并说明去哪里指定 |
| Cua Driver 没装或没授权 | 屏幕工具返回错误，写明缺哪一项、去系统设置的哪里开。**不退回**到自己截屏 |
| 另一个任务正在操作屏幕 | 返回「屏幕正被任务 X 使用」。同一时间只有一个任务能用屏幕工具，占用到该任务结束或 5 分钟没有屏幕调用 |
| 审计写不进去 | 这次调用不执行，返回错误。没有记录就不做事 |

## 10. 研究里留的五件事，这里怎么取

| # | 问题 | 取法 | 理由 |
|---|---|---|---|
| 1 | 辅助程序住在哪 | 桌面 App 的主进程里（`src/mac-executor.ts`），屏幕交给 Cua Driver | App 是签名的、身份固定的程序；本机后端是 App 拉起后独立存活的后台进程，远程后端根本不在 Mac 上，只有 App 在两种情况下都在 Mac 上、都在你登录的会话里 |
| 2 | 屏幕操作对不对真桌面开 | 对真桌面做，放第三期，每个项目默认关，点击和输入的工具默认不在白名单里 | 你要的是操作自己的 Mac；虚拟机里没有你的登录状态和 App |
| 3 | OrbStack 直通时开发板对谁可见 | 不走直通，这个问题不存在 | 直通后容器拿到的是整个串口，`espefuse` 烧写就不经过规则了；还要在生成的 compose 里加设备，动到隔离 |
| 4 | 确认的粒度 | 默认每次都问；卡片上可以选「这个任务里同样的命令都允许」 | 改固件要反复刷，每次都点太烦；限定到同一任务、同一条命令，范围足够窄 |
| 5 | 现在要不要考虑 Mac 不是宿主 | 要，而且已经包含在内 | App 分支已经支持远程后端（`src/remote.ts`），执行端放在 App 里就同时覆盖了两种情况；代价是远程时不传文件（§5.4） |

和第一版相比变了什么：执行从 Python server 搬到桌面 App；通道从 HTTP 换成项目目录里的文件；令牌换成签名密钥；规则和审计从后端工作区搬到 Mac 上；第 5 件事从「不做」变成「已覆盖」。工具、两档授权、规则的判定顺序、三期划分没变。

屏幕权限记在谁头上，这一版取 Cua Driver 的独立模式（权限给 `CuaDriver.app`，App 启动 `cua-driver mcp`）。它的文档还有一种嵌入模式，由持有权限的 App 自己带起驱动（npm 包 `@trycua/cua-driver`），权限就记在 CoderFleet App 头上。先不用：要给 App 加依赖，而且开发版和正式版 App 身份不同，权限会各记一份。第三期在 Mac 上实测独立模式不行再换。

## 11. 三个场景，从头到尾

### 11.1 连接 Mac：在容器里改代码，在 Mac 上编译

前提：本机后端；项目 reminis 的 Mac 通道开到 `command`；App 里这台 Mac 的开关开着；规则里 `xcodebuild` 是 `allow`。

1. 你在 reminis 项目里发消息。`TaskRunner.launch` 读到 `MAC_ACCESS=command`，spec 里写 `mac_access`，环境里放 `CODERFLEET_MAC_KEY`；`runClaude` 给这一轮加上 `mac` 服务。
2. Claude Code 启动 `mac-mcp.js`，列出四个工具。
3. 模型改完代码，调 `run_command(argv=["xcodebuild","-scheme","Runner","build"], cwd="ios", timeout_s=900)`。
4. `mac-mcp.js` 写请求文件 → 后端验过、排队 → 执行端取到，`cwd` 换算成 Mac 上 `<项目路径>/ios`，`decide` 命中 `xcodebuild allow` → 起子进程 → 结束后记一行审计，把结果交回 → 后端写完整日志和结果文件。
5. 模型拿到 `{"ran": true, "exit_code": 65, "stderr": "…最后 200 行…", "log": ".coderfleet-tasks/mac/….log"}`，读报错，改代码，再来一轮。

### 11.2 刷固件：改 → 编译 → 刷 → 看日志

前提：本机后端；项目开到 `command`；Mac 上装了 `esptool`；E1001 插在 Mac 上。

1. 模型在容器里编译并合并出 `build/merged.bin`（本机后端时项目目录两边都看得到，不需要传文件）。
2. `list_serial_ports()` → `["/dev/cu.wchusbserial10", …]`。
3. `run_command(["esptool","--port","/dev/cu.wchusbserial10","flash-id"])` → 命中 `allow`，直接执行，确认板子在线。
4. `run_command(["esptool","--port","/dev/cu.wchusbserial10","write-flash","0x0","build/merged.bin"], timeout_s=300)` → 命中 `confirm` → 对话里出现卡片，桌面和手机都有通知 → 你点「这个任务里同样的命令都允许」→ 执行 → 返回退出码和输出。
5. `read_serial(port, seconds=15, reset=true)` → 返回启动日志。模型据此判断固件是否正常，不正常就回到第 1 步；第 4 步不会再问你。
6. 如果模型去调 `espefuse burn-efuse …`：内置拒绝，`ran: false, verdict: "deny"`，审计里留一行。

### 11.3 屏幕操作：让任务自己点开 App 验收

前提：项目开到 `gui`；装了 Cua Driver 并给它开了屏幕录制和辅助功能；你把需要的点击 / 输入工具加进了 `gui_tools`。后端在本机或远程都可以。

1. 任务启动同 11.1。`mac-mcp.js` 启动时向执行端问一次工具清单，工具列表里多出白名单内的屏幕工具。
2. 模型调 `get_window_state(…)`。执行端：档位够 → 屏幕没被别的任务占用，记为本任务占用 → 该 App 在本任务里第一次被碰，挂确认卡片（「允许任务操作 Littlewhen？」）→ 你允许 → 转给 `cua-driver mcp` → 把返回的窗口结构和截图原样交回，截图以图片形式到模型。
3. 模型调点击工具 → 执行端记审计（工具名、目标 App）→ 转给 Cua Driver → 返回结果。
4. 你随时可以点设置页的急停、跑 `coderfleet-backend mac stop`，或者直接退出 App。
5. 任务结束，占用释放。

## 12. 分期和验收

「容器里可验」用 `node --test test/mac.test.mjs` 自动跑（执行端、规则、收发都不依赖 Electron，和 `test/remote.test.mjs` 同一种测法）；「Mac 上才能验」要在你的 Mac 上手工走一遍，我这边做不了。

### 第一期：命令

交付：`src/mac-mcp.ts`、`src/mac-calls.ts`、`src/mac-executor.ts`、`src/mac-policy.ts`；`MAC_ACCESS` 读、写、App、命令行全接；`runClaude` 和 `TaskRunner.launch` 的改动；`/v1/mac/…` 和 `projects/<名>/mac` 路由；`turns/<id>/permission` 的 `mac:` 分支；设置页「Mac 通道」；`coderfleet-backend mac …`；使用说明。

容器里可验：

- [ ] 请求没签名、签名错、用别的任务的密钥签 → 拒绝；这一轮结束后的请求不被处理
- [ ] 项目是 `off` → spec 里没有 `mac_access`，环境里没有 `CODERFLEET_MAC_KEY`，任务的 `mcpServers` 里没有 `mac`
- [ ] 任务进行中把项目改成 `off` → 下一次调用被拒
- [ ] 手机的设备令牌请求 `/v1/mac/calls` → 403
- [ ] 第二个执行端来取 → 409；第一个 60 秒不取后，第二个取得到
- [ ] 没有执行端 → 20 秒后 `unavailable`
- [ ] 放行的命令执行并返回输出；清单外的拒绝；内置拒绝项即使规则文件写了 `allow` 也拒绝
- [ ] `cwd` 用 `..` 或符号链接跑出项目目录 → 拒绝
- [ ] 子进程环境里没有执行端进程的环境变量
- [ ] 超时杀掉整个进程组（子进程再起的孙进程也没了）
- [ ] 需确认的命令：答允许 → 执行；答拒绝或超时 → `deny-unconfirmed`；「本任务都允许」后同 argv 不再问、换一个参数仍然问
- [ ] `mac:` 开头的答复不进 worker 的信箱；worker 的卡片占着时 Mac 的确认排队
- [ ] 每次调用恰好一行审计；审计目录不可写时调用不执行
- [ ] 急停后所有调用返回 `paused`，正在跑的子进程被杀
- [ ] 界面和命令行改项目开关，读写的是 `projects.conf` 里同一个值
- [ ] `mac-mcp.js` 用真实的 MCP stdio 协议走通「列工具 → 调用 → 拿结果」
- [ ] `npm run build` 和 `node --test test/*.test.mjs` 全过

Mac 上才能验：

- [ ] 真实的 Claude 任务里出现 `mcp__mac__*` 工具并能调通（SDK 起 stdio MCP 子进程时，环境里有没有 `CODERFLEET_MAC_KEY`；没有就改成由 `mcpServers.mac.env` 显式传）
- [ ] 一次真实的 `xcodebuild` 超过 5 分钟不被中断
- [ ] 由 App 起的 `xcodebuild` 和真机安装能用到钥匙串里的签名证书
- [ ] 关掉窗口但 App 还在时通道仍可用；退出 App 后调用得到 `unavailable`

### 第二期：刷固件

交付：`list_serial_ports`、`read_serial`；默认规则里的 `esptool` 条目；使用说明里的刷机一节。

容器里可验：

- [ ] `read_serial` 对着伪终端读到写入的内容，`seconds` 到点返回
- [ ] `esptool write-flash` 走确认，`espefuse burn-*`、`--do-not-confirm`、`--force` 写入被内置拒绝

Mac 上才能验：

- [ ] E1001 出现在 `list_serial_ports` 里；`flash-id` 成功
- [ ] `stty -f` 加直接读设备文件在 macOS 上读得到 115200 的日志
- [ ] 走完 §11.2 全程；`reset=true` 确实让板子重启（E1001 有没有接自动复位线，研究里没查到）

### 第三期：屏幕

交付：Cua Driver 转接、`gui_tools` 白名单、屏幕占用、按 App 确认；使用说明里的安装和授权一节。

容器里可验（用一个假的 stdio MCP 程序顶替 `cua-driver`）：

- [ ] `command` 档看不到也调不了屏幕工具
- [ ] 不在 `gui_tools` 里的工具不出现、直接调用被拒
- [ ] 第二个任务调用时返回「屏幕正被任务 X 使用」；第一个任务结束后可用
- [ ] 图片结果原样到达 MCP 客户端
- [ ] 找不到 `cua-driver` 时返回写明原因的错误

Mac 上才能验：

- [ ] 由 App 起的 `cua-driver mcp`，权限确实记在 `CuaDriver.app` 上（文档这么写，没实测）
- [ ] 走完 §11.3 全程，本机后端和远程后端各一次；急停后点击立刻停止
- [ ] 锁屏、息屏时的表现（研究里没找到苹果的说法）

## 13. Mac 上要装什么、开什么权限

| 期 | 要做的 |
|---|---|
| 一 | 升级桌面 App（本机后端会跟着换成新版）；在设置页打开「让这个后端的任务操作这台 Mac」；给项目开通道。不用重建容器，不需要任何系统授权 |
| 二 | 装 `esptool`（例如 `brew install esptool`），确认它所在目录在规则文件的 `path` 里 |
| 三 | 装 `CuaDriver.app`；在「系统设置 → 隐私与安全性」里给它开**屏幕录制**和**辅助功能**（只能手工点，研究 §5.2）；用屏幕操作时保持登录不锁屏 |

## 14. 对照项目规矩

| 规矩（`CLAUDE.md`） | 怎么满足 |
|---|---|
| 账号 / 容器 / 代理隔离不能破 | 不加网络通路、不改 compose、不给容器挂任何设备或目录；通道不接触任何账号的登录数据；请求只认项目自己目录里、签名对的 |
| 两个入口同等能力 | §8，同一期交付；差的那一项和原因写明了 |
| 字段读、写、界面一次接全 | `MAC_ACCESS` 在第一期同时接上读、写、界面、命令行和使用处。`Turn` 不加字段，密钥不落盘 |
| 状态文件一次同步读改写 | 规则文件的所有修改走同一个同步函数；审计只追加；`backends.json` 沿用现有写法 |
| 引用失效时明确拒绝，不悄悄退回 | 签名、任务、项目授权任何一项不成立都拒绝并记日志；第二台 Mac 不自动抢；Cua Driver 不可用时报错而不是改用别的截屏办法；程序找不到时报 `not-installed` |
| 跨入口的逻辑只写一份 | 判定只在 `src/mac-policy.ts`；界面和命令行改规则调同一组函数；确认复用现有的审批卡片和路由 |
| 项目问答是默认入口 | 通道只是任务里多出的一组工具，对话、会话归属都不变 |

## 15. 这份设计里没有验证的

- §12 里所有「Mac 上才能验」的条目。
- 我只读了 `node-app/` 的代码，没有改它，也**没有跑它的测试**（装依赖和构建会往那个目录里写文件，超出这次允许改动的范围）。文中点到的文件名和函数名是用 `grep` 在 `61af9ed` 上核对的。
- SDK 起 stdio MCP 子进程时是否继承 worker 的环境变量，没有实测（§12 第一期 Mac 清单第一条给了退路）。
- `mcp__mac__*` 在非「自动」模式下靠 `canUseTool` 放行、在「自动」模式下靠 `bypassPermissions`，两种模式下工具都不再被 Claude Code 自己拦住——按 SDK 类型定义推断，没有跑过。
- 后端每 250 毫秒扫一次请求目录，对几十个并发任务的开销没有量过；只扫开了通道的项目里正在跑的那几轮。
- Cua Driver 的点击、输入工具叫什么名字。README 只确认了 `get_window_state`、`get_desktop_state`、`zoom` 三个。
- 这个仓库的 Python server 和 Node 后端同时管同一个工作区时，Python 那边启动的任务（`turn.origin !== 'node'`）用不了通道，这是有意的；Python 的项目编辑界面保存时会不会丢掉 `MAC_ACCESS` 这个键，没有查。

## 16. 来源

- 研究文档及其来源清单：`docs/research/mac-helper-for-container-agents-20261125.md` §11。
- Cua Driver README「macOS process identity and permissions」「Permission modes」「Claude Code registration」三节（2026-11-25 取回）：https://github.com/trycua/cua/blob/main/libs/cua-driver/README.md
- `node-app/`（分支 `codex/node-electron-migration`，提交 `61af9ed`）：`src/tasks.ts`（`TaskRunner`、`launch`、`tick`、`decide`、`BUNDLE_FILES`、`PERMISSION_TIMEOUT_SECONDS`、`hostTaskDirectory`）、`src/claude-worker.ts`（`runClaude`、`canUseTool`）、`src/docker.ts`（`execDetached`）、`src/server.ts`（`serve`、`DEVICE_ROUTES`、`turns/<id>/permission` 路由、`new TaskRunner`）、`src/state.ts`（`Config`、`Permission`、`atomicJSON`）、`src/conf.ts`（`rewriteConf`、`projectMountSpecs`、`setProjectMounts`、`WorkspaceProject`）、`src/compose.ts`（`generateCompose`、`gostConfig`）、`src/desktop.ts`（`Profile`、`api`、`credentials`）、`src/notifications.ts`（`watchConversations`）、`src/remote.ts`、`src/local-backend.ts`（`ensureLocal`）、`src/cli.ts`、`ui/js/projects.js`、`ui/js/settings.js`、`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（`McpStdioServerConfig`）。
