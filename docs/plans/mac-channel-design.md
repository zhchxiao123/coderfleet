# Mac 通道：让容器里的 Claude Code 在 Mac 上跑命令、刷固件、操作屏幕

设计日期：2026-11-25。前置研究：`docs/research/mac-helper-for-container-agents-20261125.md`（下文写「研究 §n」）。原型：`examples/mac-helper-prototype/`。

## 1. 一页说清

- **不另写一个辅助程序。** Mac 上本来就跑着 CoderFleet server（菜单栏 tray 拉起的那个），它已经以你的身份运行、已经能控制 Docker。Mac 通道就是 server 上新增的一个带令牌的 MCP 入口 `/mac-mcp/`，容器走**已有的** relay 转发器到达它。不新开端口，不改容器网络，`docker-compose.yml` 不变。
- **默认谁也用不了。** 按项目开，两档：`command`（清单内的命令，含刷固件）和 `gui`（再加看屏幕、点、输入）。没开的项目，任务的 MCP 配置里根本没有这个服务。
- **命令按清单走**：拒绝 / 要你点允许 / 放行，不在清单里的一律拒绝。「要你点允许」用 CoderFleet 现成的提问卡片（Web、CLI、Telegram 都能答），没人答就是拒绝。
- **屏幕操作交给 Cua Driver**（独立 App，屏幕录制和辅助功能权限记在它头上），server 只做转接和把关。所以 server 自己不需要任何 macOS 隐私授权。
- **刷固件在 Mac 上执行 `esptool`**，不用 OrbStack 串口直通：直通等于把开发板整个交给容器，烧 eFuse 这类救不回来的操作就拦不住了。
- 分三期交付，每期单独可用、单独可关（§12）。

和研究文档相比改了三处，理由都在 §10：辅助程序不单独成进程；授权从三档减为两档；刷固件不再首选 OrbStack 直通。

## 2. 组成和职责

| 部分 | 在哪 | 管什么 | 新增 / 已有 |
|---|---|---|---|
| 任务里的 MCP 配置 | `coderfleet/account_type_registry.py` 的 `claude_mcp_options` | 项目开了通道时，多给任务一个名为 `mac` 的 HTTP MCP 服务 | 改 |
| 令牌下发 | `coderfleet/server/scheduler.py` 组任务环境变量处 | 给任务注入 `CODERFLEET_MAC_TOKEN` | 改 |
| relay 转发器 | `coderfleet/compose.py` 的 `_gost_config_with_bypass`（`bridge_target`） | 容器 → Mac 上 server 端口的唯一通道 | 已有，不改 |
| 入口和鉴权 | 新文件 `coderfleet/server/mac_mcp.py`：`MacMCPAuth`、`build_mac_mcp(scheduler)`；在 `coderfleet/server/main.py` 挂到 `/mac-mcp` | 验令牌、查任务和项目授权、提供工具 | 新 |
| 规则 | 新文件 `coderfleet/server/mac_policy.py`：`decide(argv) -> Verdict` | 拒绝 / 确认 / 放行 / 默认拒绝 | 新 |
| 执行 | 新文件 `coderfleet/server/mac_exec.py` | 不经 shell 起子进程、超时、截断输出、写完整日志、读串口 | 新 |
| 确认 | `Scheduler.wait_for_intervention_answer`（`scheduler.py`） | 在任务上挂一张提问卡片，等人答 | 已有，复用 |
| 审计 | `mac_exec.py` 里的 `audit(record)` | 每次调用追加一行 | 新 |
| 屏幕后端 | Cua Driver（`CuaDriver.app` + `cua-driver mcp`） | 截屏、点击、输入 | 外部，第三期才装 |
| 管理面 | `coderfleet/mac_cmds.py`（CLI）、`main.py` 的 `/api/mac/*`、`static/js/projects.js` 和设置页 | 开关、规则、审计、急停 | 新 |

`mac_mcp.py` 和 `mcp_bridge.py` 一样不能带 `from __future__ import annotations`（FastMCP 反射工具签名时会出错，原因见 `mcp_bridge.py` 文件头）。

## 3. 调用链

```
容器里的 Claude Code
  │  MCP over HTTP
  │  URL   http://${CODERFLEET_RELAY_IP}:${CODERFLEET_MCP_BRIDGE_PORT}/mac-mcp/
  │  头    Authorization: Bearer ${CODERFLEET_MAC_TOKEN}
  │        X-CoderFleet-Task-Id: ${CODERFLEET_TASK_ID}
  ▼
relay 容器的 gost 转发器（:8766 → host.docker.internal:<server 端口>）      已有
  ▼
Mac 上的 CoderFleet server
  MacMCPAuth        令牌对不对 → 任务在不在跑 → 任务的项目开没开通道        不过 → 401 / 403
  工具函数          这一档够不够 → 规则判定 → 需要的话等人确认 → 执行 → 审计
  ▼
子进程（xcodebuild / esptool / …）或 Cua Driver
```

容器到 Mac 仍然只有这一条路，仍然只能到 server 这一个端口（研究 §2 实测：经 HTTP 代理到不了 Mac 的任何端口）。

## 4. 身份和授权

### 4.1 项目授权

`projects.conf` 新增一个键 `MAC_ACCESS=off|command|gui`，缺省 `off`；`gui` 包含 `command`。对应 `Project.mac_access`（`coderfleet/server/models.py`，`Project.from_conf_record` 里解析，非法值按 `off` 处理并在 server 日志里告警）。

只对容器里的 Claude 账号任务生效（CLI 和 SDK 两种执行方式都接）。其他情况一律不注入：

- 非 Claude 类型的账号：这一版不接。`coderfleet project set-mac` 时如果项目的主账号或副账号里有非 Claude 类型，打印一行提示说明这些账号的任务用不了。
- `--runtime local` 的账号：任务本来就直接跑在 Mac 上，通道没有意义。
- 临时容器任务（`_run_ephemeral_task`）：第一期不接，保持它现在「不带宿主能力」的状态。

### 4.2 任务令牌

`令牌 = HMAC-SHA256(密钥, 任务号)`。密钥是 server 第一次用到时生成的 32 字节随机数，存工作区 `mac/secret`（权限 0600）。

- 下发：任务启动时算一次，作为环境变量 `CODERFLEET_MAC_TOKEN` 给任务进程。只有 `mac_access != off` 的项目的任务才有。
- 校验（`MacMCPAuth`，每个请求都做）：用请求头里的任务号重算令牌，`hmac.compare_digest` 比对 → `scheduler.get_task` 找得到且状态是 `running` → `scheduler.find_project_by_name(task.project_name)` 的 `mac_access` 不是 `off`。任何一步不过都拒绝，不退回到别的任务或默认授权。
- 失效：任务结束即失效；关掉项目的通道立即失效（每次调用现查）；删掉 `mac/secret` 重启 server，所有令牌作废。
- 不落盘、`Task` 上不加字段：没有要同步的状态，也就没有读改写的竞争。

为什么不沿用 `/mcp/` 只认任务号的做法：`mcp_bridge.py` 自己写明任何容器都能冒用别的任务号。问一个问题可以接受，在 Mac 上跑命令不行。

**边界：** 每个项目有自己的容器（`Project.container_name`，`<账号类型>-<项目名>`），令牌只出现在这个容器里的任务进程环境中。同一个项目的其他任务（包括副账号的任务）能读到它，这和授权本来就按项目给是一致的；别的项目的容器读不到。令牌泄露到项目目录的文件里（比如模型把环境变量写进日志）就会被带出去，所以它随任务结束失效。

### 4.3 两档能做什么

| 档 | 工具 |
|---|---|
| `command` | `mac_info`、`run_command`、`list_serial_ports`、`read_serial` |
| `gui` | 以上全部，加 Cua Driver 的屏幕工具（§5.3） |

截屏放在 `gui` 而不是更低的档：屏幕上有什么就给模型看什么，比清单内的命令暴露得多。

## 5. 工具

MCP 服务名 `mac`，所以模型看到的是 `mcp__mac__run_command` 这样的名字。`claude_mcp_options` 把 `mcp__mac__*` 加进 `allowed_tools`（任务是无人值守的，不预先放行就会被 Claude Code 自己拒掉；把关在 server 这边做）。

### 5.1 `mac_info()`

返回 `{system, version, arch, access, programs, paused}`：系统版本、本任务的档位、清单里放行和需确认的程序名、通道是否被急停。让模型先知道能做什么，少撞墙。

### 5.2 `run_command(argv, cwd=".", timeout_s=120)`

| 参数 | 说明 |
|---|---|
| `argv: list[str]` | 程序名加参数。不经过 shell，没有管道、重定向、通配符 |
| `cwd: str` | 相对项目目录的路径。server 换算成 Mac 上的 `Project.path` 下的真实路径；解析后跑出项目目录的拒绝 |
| `timeout_s: int` | 1–1800。到时杀掉整个进程组 |

返回：

```json
{"ran": true, "verdict": "allow", "rule": "xcodebuild", "exit_code": 0,
 "stdout": "…最后 200 行…", "stderr": "…", "truncated": true,
 "log": ".coderfleet-tasks/mac/<调用号>.log", "seconds": 41.2}
```

- 没执行时 `ran: false`，`verdict` 是 `deny`（规则拒绝或不在清单）、`deny-unconfirmed`（没人确认或点了拒绝）、`paused`（急停中）之一，`rule` 写明命中了哪条，模型不用猜。
- 完整输出写到项目目录的 `.coderfleet-tasks/mac/`（容器里是 `/workspace/.coderfleet-tasks/mac/`，任务日志本来就放在这个目录），模型要看全文自己去读，不占工具返回的篇幅。
- 程序名只在规则文件 `path` 列出的目录里找，找不到返回 `verdict: "deny", rule: "not-installed"`。
- 子进程的环境变量是一份固定的小清单（`PATH`、`HOME`、`LANG`、`DEVELOPER_DIR`），不继承 server 的环境——server 的环境里有 API Key。
- 运行期间每 15 秒发一次 MCP 进度通知。Claude Code 对 HTTP 的 MCP 服务默认每个请求 60 秒超时、5 分钟没动静会中断（研究 §5.1），所以 `mac` 这个服务在配置里把 `timeout` 设为 1900 秒。

### 5.3 串口和屏幕

- `list_serial_ports()`：列 `/dev/cu.*`，返回设备名。
- `read_serial(port, baud=115200, seconds=10, reset=false)`：读最多 60 秒的串口输出，`reset=true` 时先拉一下 RTS 让板子重启。用标准库 `termios`，不加依赖。
- 屏幕工具不自己定义。server 起一个 `cua-driver mcp` 子进程，把它列出的工具里**在白名单内的**原样转给模型（名字不变，例如 `get_window_state`、`get_desktop_state`、`zoom`）。白名单在规则文件的 `gui_tools` 里，默认只有这三个只读的；点击和输入的工具名以装好后 `cua-driver mcp` 实际列出的为准，由你逐个加进去。Cua Driver 用它的 `bounded` 权限模式启动。

## 6. 规则和确认

### 6.1 规则文件

工作区 `mac/policy.json`，只在 Mac 上，容器里看不到。第一次用到时生成默认内容：

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

判定顺序和原型一致：**内置拒绝 → 规则里的 `deny` → `confirm` → `allow` → 都没命中就拒绝**。按「程序名 + 参数里出现的词」匹配，不再对整条命令做正则（原型的做法，研究 §7 已说明只够原型用）。

内置拒绝写死在 `mac_policy.py` 里，规则文件改不了：`sudo`；`espefuse` 的任何烧写和读写保护；参数里有 `--do-not-confirm`；带 `--force` 的写入和擦除；`cwd` 或程序路径指向工作区的 `mac/` 目录。

规则只能由你通过 CLI 或 Web 改（§8），模型没有改规则的工具。

**放行一个构建工具意味着什么：** `xcodebuild`、`flutter` 会执行工程里的脚本。放行它们，等于允许这个项目里的代码以你的身份在 Mac 上运行。清单拦的是「模型随手跑任意命令」，拦不住「被放行的构建工具去跑仓库里的脚本」。只给你信得过的项目开。

### 6.2 确认

命中 `confirm` 时，工具调用 `scheduler.wait_for_intervention_answer(task_id, [问题], tool_call_id=…)`，在任务上挂一张卡片：

> 要在 Mac 上执行：`esptool --port /dev/cu.wchusbserial10 write-flash 0x0 build/merged.bin`
> 〔允许这一次〕〔这个任务里同样的命令都允许〕〔拒绝〕

- 你在 Web、`coderfleet task` 命令行或 Telegram 里答，走的都是现有的作答路径（`answer_intervention`）。
- 10 分钟没人答（`DEFAULT_INTERVENTION_TIMEOUT_SECONDS`）按拒绝处理，返回 `deny-unconfirmed`。
- 选「这个任务里同样的命令都允许」后，同一任务、**完全相同的 argv** 不再问。这份记录只在 server 内存里，server 重启就重新问。
- 等待期间同样发进度通知。

## 7. 数据存在哪

| 数据 | 位置 | 写法 |
|---|---|---|
| 项目授权 | `projects.conf` 的 `MAC_ACCESS` | `coderfleet/config.py` 的 `update_conf_field`，和 `DOCKER_SOCKET` 同一条路 |
| 令牌密钥 | 工作区 `mac/secret`，0600 | 只在不存在时创建一次 |
| 规则和急停标记 | 工作区 `mac/policy.json` | 一个函数内同步完成「读 → 改 → 原子写」，中间没有 `await` |
| 审计 | 工作区 `mac/audit/<日期>.jsonl` | 只追加：每条记录一次 `write`，文件以追加方式打开 |
| 命令完整输出 | 项目目录 `.coderfleet-tasks/mac/<调用号>.log` | 每次调用一个新文件 |
| 「本任务内都允许」 | server 内存 | 不落盘 |

审计每行：时间、任务号、项目、工具、参数（argv 原样；屏幕工具只记工具名和目标 App，不记截图和输入的文字）、判定、命中的规则、谁确认的、退出码、耗时。

## 8. 管理面：CLI 和 Web 一样多

| 做什么 | CLI | Web | 接口 |
|---|---|---|---|
| 给项目开关通道 | `coderfleet project set-mac <项目> off\|command\|gui` | 项目表单里的「Mac 通道」下拉 | 现有的项目创建 / 更新接口加 `mac_access` |
| 看状态 | `coderfleet mac status` | 设置页「Mac 通道」 | `GET /api/mac/status` |
| 看 / 改规则 | `coderfleet mac policy show`、`policy set <程序> allow\|confirm\|deny [--args …]`、`policy remove <序号>` | 同一页的规则表 | `GET` / `PUT /api/mac/policy` |
| 看审计 | `coderfleet mac audit [--project P] [-n 50]` | 同一页的记录表 | `GET /api/mac/audit` |
| 急停 / 恢复 | `coderfleet mac stop`、`coderfleet mac resume` | 同一页的按钮 | `POST /api/mac/stop`、`/resume` |

急停做三件事：把 `paused` 置为真、杀掉通道起的所有子进程、关掉 Cua Driver 子进程。之后所有调用返回 `paused`，直到你恢复。

`/api/mac/*` 走全站现有的 API Key 认证；只有 `/mac-mcp/` 加进 `coderfleet/server/auth.py` 的 `_EXEMPT_PREFIXES`（它有自己的令牌认证，和 `/platform-mcp/` 同理）。

## 9. 出错时怎么表现

| 情况 | 表现 |
|---|---|
| server 没在跑 | 任务启动时 `mac` 服务连不上，工具不出现，任务照常做别的。任务日志里有 MCP 连接失败的记录 |
| 令牌不对 / 任务已结束 | 401，`{"detail": "Mac 通道凭证无效或任务已结束"}` |
| 任务跑到一半你关了通道 | 403，说明项目没有开通 |
| 档位不够（`command` 档调屏幕工具） | 工具返回错误，写明需要 `gui` |
| 规则拒绝 / 不在清单 / 程序没装 | `ran: false` 加原因，见 §5.2 |
| 没人确认 | `deny-unconfirmed` |
| 命令超时 | 杀进程组，返回 `exit_code: null, timed_out: true` 和已有的输出 |
| server 在命令执行中被重启 | 正常退出时先杀掉子进程；被强杀时子进程可能继续跑完。刷机被打断可以重刷（研究 §5.3） |
| Cua Driver 没装或没授权 | 屏幕工具返回错误，写明缺哪一项、去系统设置的哪里开。**不退回**到自己截屏 |
| 另一个任务正在操作屏幕 | 返回「屏幕正被任务 X 使用」。同一时间只有一个任务能用屏幕工具，占用到该任务结束或 5 分钟没有屏幕调用 |
| 审计写不进去 | 这次调用不执行，返回错误。没有记录就不做事 |

## 10. 研究里留的五件事，这里怎么取

| # | 问题 | 取法 | 理由 |
|---|---|---|---|
| 1 | 辅助程序住在哪 | 不单独成程序：命令在 server 进程里执行，屏幕交给 Cua Driver | 当时担心的是屏幕权限记在 Python 解释器头上、升级就丢。现在 server 不碰屏幕，不需要任何隐私授权；Cua Driver 的文档写明权限记在 `CuaDriver.app` 上，`cua-driver mcp` 可以经它的常驻进程代理。桌面 App 那边的 Node 后端目前没有容器到宿主的 MCP 通道，放那边要先补通道 |
| 2 | 屏幕操作对不对真桌面开 | 对真桌面做，放第三期，每个项目默认关，点击和输入的工具默认不在白名单里 | 你要的是操作自己的 Mac；虚拟机里没有你的登录状态和 App。虚拟机目标现在没有人用，不做 |
| 3 | OrbStack 直通时开发板对谁可见 | 不走直通，这个问题不存在 | 直通后容器拿到的是整个串口，`espefuse` 烧写这类救不回来的操作就不经过规则了；还要在生成的 compose 里加设备，动到隔离。在 Mac 上执行 `esptool` 只多装一个程序 |
| 4 | 确认的粒度 | 默认每次都问；卡片上可以选「这个任务里同样的命令都允许」 | 改固件要反复刷，每次都点太烦；限定到同一任务、同一条命令，范围足够窄 |
| 5 | 现在要不要考虑 Mac 不是宿主 | 不做 | 没有这个用法。到时只需要换掉 `mac_exec.py` 这一处（改成转给 Mac 上的执行端），工具、令牌、规则都不变 |

**只能你定的只有一件：** 先在这个 Python server 上做（本设计），还是等桌面 App 的 Node 后端。我按前者写，因为容器到宿主的 MCP 通道只有 Python 这边有。如果你打算很快停用 Python server，告诉我，§2 的落点要换，其余不变。

## 11. 三个场景，从头到尾

### 11.1 连接 Mac：在容器里改代码，在 Mac 上编译

前提：`coderfleet project set-mac reminis command`；规则里 `xcodebuild` 是 `allow`。

1. 你给 reminis 项目发任务。`scheduler` 看到 `mac_access=command`，给任务环境加 `CODERFLEET_MAC_TOKEN`；`claude_mcp_options(allow_ask_user=…, mac_access="command")` 在 MCP 配置里加上 `mac` 服务。
2. Claude Code 启动，连 `…/mac-mcp/`，带令牌和任务号。`MacMCPAuth` 通过，列出四个工具。
3. 模型改完代码，调 `run_command(argv=["xcodebuild","-scheme","Runner","build"], cwd="ios", timeout_s=900)`。
4. server：`cwd` 换算成 `<Project.path>/ios` → `decide` 命中 `xcodebuild allow` → 起子进程，每 15 秒发进度 → 结束后写完整日志和一行审计。
5. 返回 `{"ran": true, "exit_code": 65, "stderr": "…最后 200 行…", "log": ".coderfleet-tasks/mac/….log"}`。模型读报错，改代码，再来一轮。

### 11.2 刷固件：改 → 编译 → 刷 → 看日志

前提：项目开到 `command`；Mac 上装了 `esptool`；E1001 插在 Mac 上。

1. 模型在容器里编译并合并出 `build/merged.bin`（项目目录两边都看得到，不需要传文件）。
2. `list_serial_ports()` → `["/dev/cu.wchusbserial10", …]`。
3. `run_command(["esptool","--port","/dev/cu.wchusbserial10","flash-id"])` → 命中 `allow`，直接执行，确认板子在线。
4. `run_command(["esptool","--port","/dev/cu.wchusbserial10","write-flash","0x0","build/merged.bin"], timeout_s=300)` → 命中 `confirm` → 你的 Web / Telegram 上出现卡片 → 你点「这个任务里同样的命令都允许」→ 执行 → 返回退出码和输出。
5. `read_serial(port, seconds=15, reset=true)` → 返回启动日志。模型据此判断固件是否正常，不正常就回到第 1 步；第 4 步不会再问你。
6. 如果模型去调 `espefuse burn-efuse …`：内置拒绝，`ran: false, verdict: "deny"`，审计里留一行。

### 11.3 屏幕操作：让任务自己点开 App 验收

前提：项目开到 `gui`；装了 Cua Driver 并给它开了屏幕录制和辅助功能；你把需要的点击 / 输入工具加进了 `gui_tools`。

1. 任务启动同 11.1，工具列表里多出白名单内的屏幕工具。
2. 模型调 `get_window_state(…)`。server：档位够 → 屏幕没被别的任务占用，记为本任务占用 → 该 App 在本任务里第一次被碰，挂确认卡片（「允许任务操作 Littlewhen？」）→ 你允许 → 转给 `cua-driver mcp` → 把返回的窗口结构和截图原样交回。截图以图片形式到模型（原型已验证图片能到、模型能读）。
3. 模型调点击工具 → server 记审计（工具名、目标 App）→ 转给 Cua Driver → 返回结果。
4. 你随时可以 `coderfleet mac stop` 或点 Web 上的急停。
5. 任务结束，占用释放。

## 12. 分期和验收

每期的「容器里可验」用 pytest 自动跑；「Mac 上才能验」要在你的 Mac 上手工走一遍，我这边做不了。

### 第一期：命令

交付：`mac_mcp.py`、`mac_policy.py`、`mac_exec.py`、`mac_cmds.py`；`Project.mac_access` 读、写、CLI、Web 全接；`claude_mcp_options` 和 `_claude_mcp_bridge_arg` 增加 `mac_access` 参数；scheduler 下发令牌；`/api/mac/*`；`docs/agents/key-files.md` 补这几个文件的条目，新增 `docs/mac-channel.md` 使用说明。

容器里可验（新增 `tests/test_mac_mcp.py`、`tests/test_mac_policy.py`、`tests/test_mac_cli.py`，照 `tests/test_platform_mcp.py` 走真实的 MCP HTTP 协议）：

- [ ] 令牌缺失、错误、拿别的任务号配自己的令牌、任务已结束 → 都是 401
- [ ] 项目是 `off` → 任务的 MCP 配置里没有 `mac`，环境里没有 `CODERFLEET_MAC_TOKEN`；直接请求 → 403
- [ ] 任务进行中把项目改成 `off` → 下一次调用 403
- [ ] 放行的命令执行并返回输出；清单外的拒绝；内置拒绝项即使规则文件写了 `allow` 也拒绝
- [ ] `cwd` 用 `..` 或符号链接跑出项目目录 → 拒绝
- [ ] 子进程环境里没有 server 的环境变量
- [ ] 超时杀掉整个进程组（子进程再起的孙进程也没了）
- [ ] 需确认的命令：答允许 → 执行；答拒绝或超时 → `deny-unconfirmed`；「本任务都允许」后同 argv 不再问、换一个参数仍然问
- [ ] 每次调用恰好一行审计；审计目录不可写时调用不执行
- [ ] 急停后所有调用返回 `paused`，正在跑的子进程被杀
- [ ] `claude_mcp_options` 仍是纯函数；`coderfleet project set-mac`、`coderfleet mac …` 和 Web 表单读写的是同一个值
- [ ] 全量 `uv run --with pytest pytest -q` 和 `bash scripts/verify.sh` 通过

Mac 上才能验：

- [ ] 真实任务经 relay 转发器到达 `/mac-mcp/`（研究 §2 里这个转发器当时被对端 reset，原因没查，这里要先弄清）
- [ ] 一次真实的 `xcodebuild` 超过 5 分钟不被 Claude Code 中断
- [ ] server 由 tray 拉起时，`xcodebuild` 和真机安装能用到钥匙串里的签名证书

### 第二期：刷固件

交付：`list_serial_ports`、`read_serial`；默认规则里的 `esptool` 条目；使用说明里的刷机一节。

容器里可验：

- [ ] `read_serial` 对着伪终端（pty）读到写入的内容，`seconds` 到点返回
- [ ] `esptool write-flash` 走确认，`espefuse burn-*`、`--do-not-confirm`、`--force` 写入被内置拒绝

Mac 上才能验：

- [ ] E1001 出现在 `list_serial_ports` 里；`flash-id` 成功
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

- [ ] 由 server 起的 `cua-driver mcp`，权限确实记在 `CuaDriver.app` 上（文档这么写，没实测）
- [ ] 走完 §11.3 全程；急停后点击立刻停止
- [ ] 锁屏、息屏时的表现（研究里没找到苹果的说法）

## 13. Mac 上要装什么、开什么权限

| 期 | 要做的 |
|---|---|
| 一 | 升级 CoderFleet，重启 server。不需要 `coderfleet apply`，不需要任何系统授权。前提是 server 跑在你登录的会话里（tray 的 LaunchAgent 就是） |
| 二 | 装 `esptool`（例如 `brew install esptool`），确认它所在目录在规则文件的 `path` 里 |
| 三 | 装 `CuaDriver.app`；在「系统设置 → 隐私与安全性」里给它开**屏幕录制**和**辅助功能**（只能手工点，研究 §5.2）；用屏幕操作时保持登录不锁屏 |

## 14. 对照项目规矩

| 规矩（`CLAUDE.md`） | 怎么满足 |
|---|---|
| 账号 / 容器 / 代理隔离不能破 | 不加网络通路、不改 compose、不给容器挂任何设备或目录；通道不接触任何账号的登录数据；令牌按任务发。令牌的可见范围就是项目自己的容器（§4.2） |
| CLI 和 Web 同等能力 | §8 的表，同一期交付，验收里有一条专门核对 |
| 字段读、写、界面一次接全 | `mac_access` 在第一期同时接上：`from_conf_record` 读、`set-mac` 和项目接口写、项目表单显示、`claude_mcp_options` 和 `MacMCPAuth` 使用。不加任何暂时用不到的字段（令牌不落盘，`Task` 不加字段） |
| 状态文件一次同步读改写 | `mac/policy.json` 的所有修改走同一个函数，读改写之间没有 `await`；审计只追加；令牌无状态 |
| 引用失效时明确拒绝，不悄悄退回 | 令牌、任务、项目授权任何一项不成立都返回 401 / 403 并记日志；Cua Driver 不可用时报错而不是改用别的截屏办法；程序找不到时报 `not-installed` 而不是去别的目录找 |
| 跨入口的逻辑只写一份 | 判定只在 `mac_policy.decide`；CLI 和 Web 都调 `/api/mac/*`；确认复用 `wait_for_intervention_answer`，不另做一套弹窗 |
| 构建函数保持纯 | `claude_mcp_options` 只多一个入参，令牌用 `${CODERFLEET_MAC_TOKEN}` 占位，真实值由 scheduler 放进环境 |
| 改了关键文件要更新 `key-files.md` | 列在第一期交付里 |

## 15. 这份设计里没有验证的

- §12 里所有「Mac 上才能验」的条目。
- Claude Code 的 MCP 配置里按服务设置 `timeout` 的写法，是按研究时读到的文档写的，第一期要用真实任务确认一次。
- 现有 `ask_user_question` 能等 10 分钟不被 Claude Code 的请求超时打断——我没有查它为什么可以，确认卡片依赖同一机制，第一期验收时一并确认。
- Cua Driver 的点击、输入工具叫什么名字。README 只确认了 `get_window_state`、`get_desktop_state`、`zoom` 三个。
- 桌面 App 分支（`codex/node-electron-migration`）的代码不在这个工作目录里，我只读了它的说明和源码目录来判断「Node 后端没有容器到宿主的 MCP 通道」，没有改动它。

## 16. 来源

- 研究文档及其来源清单：`docs/research/mac-helper-for-container-agents-20261125.md` §11。
- Cua Driver README「macOS process identity and permissions」「Permission modes」「Claude Code registration」三节（2026-11-25 取回）：https://github.com/trycua/cua/blob/main/libs/cua-driver/README.md
- 本仓库：`coderfleet/account_type_registry.py`（`claude_mcp_options`、`_claude_mcp_bridge_arg`）、`coderfleet/server/main.py`（`/mcp`、`/platform-mcp` 的挂载）、`coderfleet/server/platform_mcp.py`（`PlatformMCPAuth`、`authorize`）、`coderfleet/server/mcp_bridge.py`、`coderfleet/server/scheduler.py`（`wait_for_intervention_answer`、`answer_intervention`、`find_project_by_name`、`get_task`、`_run_ephemeral_task`、`_prepare_sdk_launch`）、`coderfleet/server/models.py`（`Project`、`TaskStatus`）、`coderfleet/server/auth.py`（`_EXEMPT_PREFIXES`）、`coderfleet/compose.py`（`_gost_config_with_bypass`）、`coderfleet/config.py`（`update_conf_field`）、`coderfleet/config_cmds.py`（`cmd_project_set_docker_socket`，`set-mac` 照它写）。
