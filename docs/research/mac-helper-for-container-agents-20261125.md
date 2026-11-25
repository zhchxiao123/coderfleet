# 做一个辅助程序，让容器里的 Claude Code 操作我的 Mac：能不能做、该怎么做

研究日期：2026-11-25。来源只用一手资料（Anthropic / Apple / OrbStack / Docker / Espressif 官方文档、项目自己的仓库和 man page）、本仓库代码，以及在本次任务的容器里实际跑出来的结果。没能从一手来源确认的，一律标「未验证」，集中列在第 10 节。资料由三个子任务分头查，其中 [C1]、[C3] 的图片一句、[C5]、[M3]、[M5]、[F1]、[F4]、[F7] 的引文我又用 curl 对着原页面逐句核对过，其余引文是子任务取回的。

## 1. 结论

**能做，而且值得做。** 官方现成的东西都接不上（Claude Code 自带的 computer use 明确不支持 `-p`，也不支持 Linux），但「在 Mac 上跑一个带令牌的 MCP 服务，容器里的 Claude Code 把它当工具用」这条路每一环都有官方支持，本次已用原型在容器里跑通（第 7 节）。

辅助程序本身应该很薄：只管**连接、身份、规则、确认、审计**五件事。真正干活的部分尽量用现成的：

| 你想做的事 | 推荐做法 | 辅助程序要不要参与 |
|---|---|---|
| 连接 Mac（跑命令、编译 Xcode 工程、取文件） | 辅助程序自己的 `run_command`，按清单放行 | 要，这是它的本职 |
| Mac 上 computer use（看屏幕、点、输入） | 辅助程序转接现成的 Cua Driver（MIT，MCP 接口，不抢焦点）；不要自己写点击和截屏 | 要，做转接和把关 |
| 刷固件（你的 reTerminal E1001，ESP32-S3） | 首选：OrbStack 2.2 起自带串口转发，容器里直接 `esptool`，**不需要辅助程序**；备选：在 Mac 上跑 `esptool`，由辅助程序把关 | 首选不要；备选要 |

三件事的风险差别很大，所以建议分三步落地、每一步单独开关（第 8 节），而不是一次给出「整台 Mac」。

## 2. 现状：容器怎么够到 Mac（本容器实测）

本次任务跑在 CoderFleet 的 relay 账号容器里（`172.21.0.4`，内核 `7.0.11-orbstack`，即宿主就是装了 OrbStack 的 Mac）。

| 跑了什么 | 结果 | 说明 |
|---|---|---|
| `cat /proc/net/route` | 只有 `172.21.0.0/16` 一条，没有默认路由 | `internal: true` 网络，直连不出去 [D1] |
| `getent hosts host.docker.internal` / `host.orb.internal` | 都解析不到 | 这两个名字只有 relay 容器里有（`compose.py` 给 relay 加了 `extra_hosts`） |
| 直连 `172.21.0.1:22`、`:8765` | Connection refused | 网关是 Linux 虚拟机的网桥，不是 macOS |
| 经 HTTP 代理 `CONNECT host.docker.internal:22/8765/5900` | 全部 503 | 代理把请求交给上游（宿主的 Clash），到不了 Mac 自己的端口 |
| 直连 `172.21.0.2:8766`（relay 上的 MCP 桥） | TCP 能连上；发 MCP `initialize` 被对端 reset | 转发器在，但这一刻它指向的宿主 `:8765` 没有服务在应答 |
| `ls /dev \| grep -E 'tty(USB\|ACM)'` | 没有 | 当前没有串口设备转发进来 |

结论：

- 容器到 Mac **现在只有一条预留的通道**：relay 上的 gost 转发器（`compose.py` 里的 `bridge_target=host.docker.internal:<server 端口>`），它本来就是给「容器里的 Claude 调宿主上的 MCP 服务」用的（`coderfleet/server/mcp_bridge.py` 的 `ask_user_question`、`/platform-mcp/`）。辅助程序应该走这条路，不要另开一条。
- HTTP 代理这条路到不了 Mac，这是好事：容器里的代码不能靠代理去扫 Mac 上的端口。
- 「转发器指向的服务此刻不应答」的原因没有查：跑这次任务的调度器是哪个进程、听哪个端口，我在容器里看不到（未验证）。

## 3. 路线比较

| 路线 | 能做什么 | 取舍 | 结论 |
|---|---|---|---|
| A. 官方现成功能：Claude Code 自带 computer use、Remote Control、Dispatch | Mac 上的图形操作 | 自带 computer use「requires an interactive session, so it is not available in non-interactive mode with the `-p` flag」，且「not available on Linux or Windows」；Remote Control 是人遥控本机会话，不是给另一个 agent 调用的接口；Dispatch 不对新用户开放 [C1][C4] | 接不上，不选 |
| B. SSH 到 Mac（打开「远程登录」，relay 再加一条到 22 端口的转发） | 命令、文件 | 做不了图形操作：SSH 会话不在图形会话里，苹果自己的 `screencapture` 手册就写了要 `launchctl bsexec` 才能截屏 [M3][M4]；给的是整个用户的 shell，没法按命令把关；访问桌面/文稿等目录还要另开「允许远程用户完全访问磁盘」[M7] | 只适合当临时手段，不选 |
| C. 把现成的 Mac 操控工具（Cua Driver / Peekaboo）直接暴露给容器 | 图形操作 | 它们的 MCP 是 stdio 接口，要包一层才能跨网络；没有「哪个任务能用」的概念，也不管命令和刷机 | 当后端用，不单独用 |
| **D. 自己的薄辅助程序（MCP 网关）+ 现成后端** | 三件事都行 | 要自己维护一个小程序和一份规则；好处是身份、规则、确认、审计都在一处，后端可换 | **推荐** |
| E. 不碰真桌面，给 agent 一台 macOS 虚拟机（Lume，MIT） | 图形操作、编译 | 最安全，官方对 computer use 的建议就是「dedicated virtual machine」[C2]；但虚拟机里没有你的登录状态和 App，USB 直通要到 macOS 27 才有 [M9]，许可只允许两台 [M8] | 作为 D 的可选「目标」，适合跑 UI 自动验收 |
| F. OrbStack 串口/USB 直通 | 刷固件、看串口日志 | OrbStack 2.2.0 起支持，串口「stay usable on macOS at the same time」[F1]；不需要任何辅助程序；但 CH340 不在已测清单里、CoderFleet 容器怎么拿到设备节点都没验证 | 刷固件首选，先实测 |

## 4. 推荐设计

```
容器里的 Claude Code ──MCP(HTTP)──▶ relay 转发器 ──▶ Mac 上的 CoderFleet server ──▶ 辅助程序（登录会话里）
     只看到被授权的工具             已有的通道          查「这个任务能不能用」            规则 / 确认 / 审计
                                                                                    ├─ 命令：自己执行
                                                                                    ├─ 图形：转给 Cua Driver
                                                                                    └─ 刷机：esptool（备选路线）
```

要点，每条后面是依据：

1. **协议用 MCP over HTTP。** Claude Code 支持 HTTP 传输、请求头、`${VAR}` 展开 [C3]；工具返回的图片模型能直接看到（「Claude sees the image inline」，v2.1.283 起）[C3]。原型里模型读出了图片上的随机码，证实这一点。
2. **辅助程序必须跑在登录后的图形会话里**（一个有固定身份的 App，或 Aqua 类型的 LaunchAgent），不能是 LaunchDaemon，也不能从 SSH 里起：「A daemon cannot display any GUI… it is not allowed to connect to the window server」[M3]。权限记在哪个程序头上，由系统按「responsible code」判断，后台化容易断掉这层关系 [M2]——所以它不该由 `coderfleet server --daemon` 顺手拉起。
3. **辅助程序只听本机，容器经 server 转一道。** server 知道任务属于哪个项目、项目有没有被授权；`/platform-mcp/` 已经有「每次运行发一个令牌」的做法（`platform_agent.py`），照它来。现有 `/mcp/` 桥只靠未签名的 `X-CoderFleet-Task-Id`，`mcp_bridge.py` 的注释承认任何容器都能冒用别的任务号——问个问题可以接受，操作 Mac 不行，必须用令牌。
4. **默认谁也用不了。** 按项目显式授权，并且分三档：只读（看屏幕、列设备）/ 命令 / 图形操作。没授权的任务，工具根本不出现在它的 MCP 配置里。
5. **图形操作用 Cua Driver 做后端**：MIT，「Speaks MCP over stdio; drives native macOS apps without stealing focus」，有 `bounded` 权限模式，会拒绝在系统授权弹窗上输入 [M5]。Peekaboo（MIT，要求 macOS 15+）是备选 [M6]。自己写截屏会踩 macOS 15 对旧截屏接口的告警 [M1]。
6. **Mac 不是宿主时（容器在远程服务器上）**，同一个辅助程序改成自己向 server 拨出长连接即可，工具和规则不变。这一步现在不做，只是确认设计不堵这条路。

## 5. 三个场景各自怎么走

### 5.1 连接 Mac：命令和文件

- 工具：`run_command(argv, cwd, timeout)`，不经过 shell；按规则三分：拒绝 / 要你当场点允许 / 放行，**不在清单里的一律拒绝**。
- 最有用的第一批放行项就是你现在手工交给 Codex 做的事：`xcodebuild`、`xcrun`、Flutter 构建和真机安装。
- 文件不需要新通道：项目目录本来就是从 Mac 挂进容器的，产物放在项目目录里两边都看得到。
- 长命令要注意 Claude Code 的超时：HTTP 的 MCP 服务每个请求默认 60 秒超时，要把服务的 `timeout` 调高；5 分钟没有任何响应或进度通知也会被中断 [C3]。编译和刷机都要发进度通知。

### 5.2 Mac 上 computer use

- 需要你在「系统设置 → 隐私与安全性」里手工给辅助程序开两项：**屏幕录制**和**辅助功能**。屏幕录制没有任何免点击的办法，连管理配置文件也只能禁止不能授予：「A profile can't grant access to the contents; it can only deny it」[M10]。macOS 15 起系统还会不定期再弹一次确认（具体间隔苹果没写，未验证）[M1]。
- 截图要先缩小再给模型。新模型接受长边 2576 像素，旧模型 1568；坐标按截图像素算，缩了图就要把坐标换算回去 [C2]。
- 锁屏或息屏时能不能截图、能不能输入，没找到苹果的说法（未验证）。保守做法：要用图形操作时保持登录、不锁屏，`caffeinate -d` 防息屏 [M11]。
- 同一时间只让一个任务操作屏幕（官方功能也是这么做的 [C1]），并提供一个随时生效的「停」。
- 自带 computer use 的 API 工具（`computer_toolset_20260801`）在 Claude Code 里用不了，没有任何文档说它可以（未验证）；所以是「把同样的动作做成 MCP 工具」，代价是享受不到 API 那边对截图内容的注入检测 [C2]。

### 5.3 刷固件

你的板子是 Seeed reTerminal E1001。Seeed 的文档显示它走的是 **CH340 串口桥**（`/dev/tty.wchusbserial*`），不是 ESP32-S3 自带的 USB [F4]。

1. **首选：OrbStack 串口转发，容器里直接刷。** 「Serial and UART ports connected to your Mac… are automatically forwarded to Linux and appear as character devices in the guest. They stay usable on macOS at the same time」[F1]。本机内核是 `7.0.11-orbstack`，对应 2.2.0/2.2.1，而串口的几处修复在 2.2.2–2.2.5 [F2]，要先升级 OrbStack。还要实测的：CH340 能不能被转发、DTR/RTS 自动复位是否有效、CoderFleet 的容器怎么拿到设备节点（很可能要在生成的 compose 里加 `devices`，那就是一个要你定的隔离问题，见第 9 节）。
2. **备选一：Mac 上跑 `esp_rfc2217_server`，容器里 `esptool --port rfc2217://…?ign_set_control`。** 这是 Espressif 文档里给 Docker 的做法 [F3]。但这个服务「no security measures are implemented」[F3]，而且容器到 Mac 的任意端口现在是不通的（第 2 节），要多开一条转发，不划算。
3. **备选二：容器里编译并 `merge-bin`，辅助程序在 Mac 上执行 `esptool write-flash`。** 最稳，Mac 上只需要一个独立的 esptool 可执行文件 [F5]；刷机这条命令走「要你点允许」。
4. 其他芯片：有调试器的（STM32/nRF）在 Mac 上起 gdb server（OpenOCD 默认 3333），UF2 的板子是往挂载盘里拷文件——都能套进 `run_command`，现在不展开 [F6]。

刷机的规则（原型的 `policy.json` 已照此写）：

- **永远拒绝**：`espefuse` 的任何烧写（「it is possible to permanently damage or 'brick' your ESP32-S3 using this tool」[F7]）、`--do-not-confirm`、带 `--force` 的写入和擦除。
- **要你点允许**：`write-flash`、`erase-flash`。
- **直接放行**：`flash-id`、`read-mac`、`image-info`、`espefuse summary`、看串口日志。
- 普通刷坏了能救：复位入口代码在掩膜 ROM 里改不了 [F8]，重新进下载模式再刷即可（这是从文档推出来的，Espressif 没有一句原话这么说）。

## 6. 安全边界

这件事的本质是**在容器隔离上主动开一个口子**。Anthropic 的文档说得很直接：容器才是保护你系统的那道边界，而本机的 MCP 服务「run with your full access」、不在沙箱里 [C5]；模型「follows commands found in content even when they conflict with your instructions」[C2]。所以设计上假设容器里的 agent 可能被网页或仓库里的内容带偏。

| 问题 | 做法 |
|---|---|
| 给了容器什么 | 只有被授权项目的任务，才能调用清单内的命令、截屏/点击、清单内的刷机命令。没有任意 shell，没有任意文件读写，没有钥匙串 |
| 会不会破坏账号/容器/代理隔离 | 不加新的网络通路：仍然只有 relay 上那一条转发，仍然到不了 Mac 的其他端口。辅助程序不接触任何账号的登录数据。它是所有账号共用的一个「设备」，所以用每任务令牌区分是谁在用，而不是靠网络位置 |
| 需要的 macOS 授权 | 命令：不需要特别授权（访问桌面/文稿等目录除外）；图形操作：屏幕录制 + 辅助功能，都要你手工点 |
| 哪些动作要你确认 | 刷机和擦除、`osascript`/`open` 这类能间接做任何事的命令、图形操作第一次碰某个 App（照官方做法按 App 批准；终端、访达、系统设置额外警告）[C1] |
| 永远不做 | `sudo`、eFuse 烧写、在系统授权弹窗上点击、改辅助程序自己的规则文件 |
| 事后能查 | 每次调用一行审计：时间、任务、工具、参数、判定、退出码 |
| 无人值守时 | 没人点允许就是拒绝。`claude -p` 里要确认的调用本来也是默认拒绝 [C3] |
| 图形操作的残余风险 | 屏幕上任何内容（网页、邮件、通知）都可能是注入；规则管不住「点哪里」。这是三件事里风险最高的，建议默认关，或者先只对虚拟机开（路线 E） |

## 7. 原型和运行记录

位置：`examples/mac-helper-prototype/`（`helper.py` 约 180 行、`policy.json`、`check.py`、`run_demo.sh`）。

它证明的链路：**容器里的 `claude -p` → MCP(HTTP，带令牌) → 辅助程序 → 执行并回传结果**。`./run_demo.sh` 一次跑完，记录在 `examples/mac-helper-prototype/runs/20261125-014153/`：

| 验证了什么 | 结果 | 记录 |
|---|---|---|
| 令牌错或缺失 → 401 | 通过 | `check.txt` |
| 清单内命令执行并回传输出 | 通过（`uname -sm` → `Linux aarch64`） | `check.txt`、`claude-summary.txt` |
| eFuse 烧写被拒绝，模型如实报告、没有重试 | 通过（`BURN=deny`） | `claude-summary.txt`、`audit.jsonl` |
| 刷机命令没人确认就不执行 | 通过（`deny-unconfirmed`） | `check.txt` |
| 清单外命令被拒绝 | 通过 | `check.txt` |
| 截图以图片形式到达模型，模型能读内容 | 通过：图里的随机码 `476561`，模型答 `CODE=476561` | `claude-summary.txt`、`claude-stream.jsonl` |
| 审计里记下了真实的任务号 | 通过（`78805de3cdb4`，即本次 CoderFleet 任务） | `audit.jsonl` |

原型**没有**证明的（都要在 Mac 上才能验证）：

- 真屏幕截图（`screencapture`）、系统确认对话框（`osascript`）这两段 Mac 分支的代码写了，但一次都没运行过。
- 辅助程序在本容器里和 Claude Code 是同一台机器、走 `127.0.0.1`；relay 转发器 → Mac 这一段没有走。
- 点击和输入、Cua Driver 转接、真实刷机，都没有做。
- 规则是对整条命令做正则匹配，只够原型用；正式版应按「可执行文件 + 结构化参数」放行。

## 8. 分阶段落地

| 阶段 | 做什么 | 做完你能得到 | 风险 |
|---|---|---|---|
| 0（半天，Mac 上） | 升级 OrbStack，插上 E1001，看容器里能不能直接 `esptool flash-id`；在 Mac 上跑一次原型，看真截图和确认对话框 | 知道刷固件是否根本不需要辅助程序；知道 Mac 分支可用 | 无 |
| 1 | 辅助程序正式版（命令 + 只读截屏）、server 上的授权和每任务令牌、`coderfleet device …` 命令和 Web 上同等的开关与审计查看 | 容器里的任务能在 Mac 上编译 Xcode/Flutter 工程、装真机、截一张图给自己看 | 中：按清单放行 |
| 2 | 刷机规则、进度通知、串口日志 | 改固件 → 编译 → 刷 → 看日志，全程不用你动手（刷机点一下允许） | 中：普通刷坏可救 |
| 3 | 图形操作：转接 Cua Driver，按 App 批准、单任务占用、全局停止；可选虚拟机目标 | 让任务自己点开 App 做验收 | 高：见第 6 节 |

项目规矩对应到这里：阶段 1 起每个开关都要 CLI 和 Web 同时有；授权字段要读、写、界面一次接全；授权和审计文件的修改用一次同步的读-改-写；任务引用了失效的授权要明确拒绝，不能悄悄退回到别的 Mac 或默认规则。

## 9. 要你来定的事

1. **辅助程序住在哪。** 我的建议是放进 CoderFleet 桌面 App（Electron）：它有固定的 App 身份，系统权限记得住，也有地方弹确认和显示「正在被操作」。但桌面 App 的代码在另一个分支（`codex/node-electron-migration`），不在这个工作目录里。另外两个选择：现有的菜单栏 tray（Python，权限会记在 Python 解释器头上，升级 Python 可能要重新授权——这一点未验证），或者一个独立小程序。
2. **图形操作要不要对真桌面开。** 还是只对一台 macOS 虚拟机开，或者先不做阶段 3。
3. **刷固件如果走 OrbStack 直通**，设备会对同一个 Linux 实例里的所有容器可见（「available to all of your (non-isolated) machines and containers」[F1]），再由 compose 决定挂给谁。接受「哪个项目能看到开发板」由项目配置决定吗？
4. **确认的粒度。** 每次刷机都点一下，还是「这个任务里允许刷这块板子」点一次管到任务结束。
5. **要不要现在就考虑 Mac 不是宿主的情况**（容器在远程服务器，Mac 只是外设）。我的默认是不考虑，只保证设计不堵路。

## 10. 未验证清单

- Mac 上的一切实际行为：真截图、确认对话框、权限归属、Cua Driver 转接、刷机。本次只有 Linux 容器。
- 从 LaunchAgent 或 Electron 子进程启动时，屏幕录制/辅助功能权限记在哪个程序头上；从 SSH 启动时记在谁头上。
- macOS 15+ 屏幕录制再次确认的间隔；锁屏/息屏时截图和输入是否可用。
- OrbStack：CH340 是否能转发、DTR/RTS 是否透传、已在运行的 Docker 容器如何拿到设备节点、`mac` 命令能否用于 Docker 容器（文档只写了 machines）。
- E1001 有没有 BOOT 键、是否接了自动复位线。
- Claude Code：图片结果怎么计入 `MAX_MCP_OUTPUT_TOKENS`；进度通知在 `-p` 的输出里是否可见；API 的 computer use 工具能否在 Claude Code / Agent SDK 里用（没有文档支持）。
- 本机 relay 的 8766 转发器此刻为什么被 reset（宿主上是哪个服务在跑这次任务）。
- 文档 [M2] 的两句苹果工程师论坛原话是经摘要工具取回的，引用前应再核对原文。

## 11. 来源

Claude / MCP

- [C1] Claude Code computer use：https://code.claude.com/docs/en/computer-use
- [C2] API computer use tool（工具版本、截图尺寸、安全建议）：https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool
- [C3] Claude Code MCP、无头模式、权限、环境变量：https://code.claude.com/docs/en/mcp ，https://code.claude.com/docs/en/headless ，https://code.claude.com/docs/en/permissions ，https://code.claude.com/docs/en/env-vars ，https://code.claude.com/docs/en/hooks
- [C4] Remote Control、Dispatch：https://code.claude.com/docs/en/remote-control ，https://code.claude.com/docs/en/desktop
- [C5] 沙箱与隔离边界：https://code.claude.com/docs/en/sandbox-environments ，https://code.claude.com/docs/en/sandboxing ，https://code.claude.com/docs/en/agent-sdk/secure-deployment
- 本机 `claude --help`（2.1.296）

macOS

- [M1] macOS 15 / 15.1 发行说明（旧截屏接口告警）：https://developer.apple.com/documentation/macos-release-notes/macos-15-release-notes ，https://developer.apple.com/documentation/macos-release-notes/macos-15_1-release-notes
- [M2] 苹果开发者论坛，responsible code 与 Full Disk Access：https://developer.apple.com/forums/thread/678819 ，https://developer.apple.com/forums/thread/806187
- [M3] TN2083 Daemons and Agents：https://developer.apple.com/library/archive/technotes/tn2083/_index.html
- [M4] `screencapture(1)`、`launchctl(1)`（man page 镜像）：https://keith.github.io/xcode-man-pages/screencapture.1.html ，https://keith.github.io/xcode-man-pages/launchctl.1.html
- [M5] Cua Driver：https://github.com/trycua/cua/blob/main/libs/cua-driver/README.md ，https://cua.ai/docs/cua-driver/guides/permissions
- [M6] Peekaboo：https://github.com/openclaw/Peekaboo
- [M7] 远程登录：https://support.apple.com/guide/mac-help/allow-a-remote-computer-to-access-your-mac-mchlp1066/mac ；`sshd(8)`：https://man.openbsd.org/sshd.8
- [M8] macOS 许可协议 2B(iii)：https://www.apple.com/legal/sla/docs/macOSTahoe.pdf
- [M9] `VZUSBPassthroughDeviceConfiguration`（macOS 27）：https://developer.apple.com/documentation/virtualization/vzusbpassthroughdeviceconfiguration ；Lume：https://cua.ai/docs/lume/quickstart
- [M10] 隐私偏好策略（PPPC）服务定义：https://developer.apple.com/documentation/devicemanagement/privacypreferencespolicycontrol/services-data.dictionary
- [M11] `caffeinate(8)`：https://keith.github.io/xcode-man-pages/caffeinate.8.html

容器网络与刷固件

- [D1] Docker `internal` 网络、`host.docker.internal`：https://docs.docker.com/reference/cli/docker/network/create/ ，https://docs.orbstack.dev/docker/network
- [F1] OrbStack USB：https://docs.orbstack.dev/features/usb
- [F2] OrbStack 发行说明、issue #43：https://docs.orbstack.dev/release-notes ，https://github.com/orbstack/orbstack/issues/43
- [F3] esptool 远程串口、`esp_rfc2217_server`：https://docs.espressif.com/projects/esptool/en/latest/esp32s3/remote-serial-ports.html ，https://github.com/espressif/esptool/blob/master/esp_rfc2217_server/__init__.py ，https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-guides/tools/idf-docker-image.html
- [F4] Seeed reTerminal E1001：https://wiki.seeedstudio.com/getting_started_with_reterminal_e1001/
- [F5] esptool 安装、命令、v5 改名：https://docs.espressif.com/projects/esptool/en/latest/esp32s3/installation.html ，https://docs.espressif.com/projects/esptool/en/latest/esp32s3/esptool/basic-commands.html ，https://docs.espressif.com/projects/esptool/en/latest/esp32s3/migration-guide.html
- [F6] OpenOCD gdb server：https://openocd.org/doc/html/GDB-and-OpenOCD.html
- [F7] espefuse：https://docs.espressif.com/projects/esptool/en/latest/esp32s3/espefuse/index.html
- [F8] ESP32-S3 启动流程：https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-guides/startup.html

本仓库

- `coderfleet/compose.py`（relay 的 `extra_hosts` 与 MCP 桥转发）、`coderfleet/server/mcp_bridge.py`（任务号未签名的说明）、`coderfleet/server/platform_agent.py`（每次运行一个令牌）、`coderfleet/account_type_registry.py`（`_claude_mcp_bridge_arg`）
